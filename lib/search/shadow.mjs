import { factQuery, contains } from '../fact-retrieval.mjs';
import { redactSecrets } from '../redaction.mjs';
import { buildIndex, search } from './bm25.mjs';
import { cosine, embedLocal, validateVectors } from './local-embedding.mjs';

export function fuseRoutes(routes, k = 60) {
  const merged = new Map();
  for (const [source, rows] of Object.entries(routes)) {
    const seen = new Set();
    rows.forEach((row, index) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      const hit = merged.get(row.id) ?? { id: row.id, score: 0, sources: [] };
      hit.score += 1 / (k + index + 1);
      hit.sources.push({ source, rank: index + 1 });
      merged.set(row.id, hit);
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function eligibleFacts(topics, projection, query, workspace, pendingTopics = []) {
  if (!workspace || !query?.trim()) throw new Error('Explicit workspace and non-empty query required');
  const parsed = query === 'all' ? { entities: [], words: [] } : factQuery(query);
  const allowed = new Map(topics.filter((t) => t.workspace === workspace
    && !['archived', 'superseded'].includes(t.status) && !pendingTopics.includes(t.id)).map((t) => [t.id, t]));
  return projection.facts.filter((fact) => allowed.has(fact.topic)).map((fact) => ({
    id: JSON.stringify([fact.topic, fact.key, fact.event_id]),
    text: redactSecrets(fact.text), topic: fact.topic, event_id: fact.event_id,
    conflict: projection.conflicts.some((c) => c.topic === fact.topic && c.key === fact.key),
  })).filter((row) => parsed.entities.every((term) => contains(row.text.normalize('NFKC').toLowerCase(), term)));
}

// No storage writes or automatic injection. Both retrieval arms share one eligible corpus.
export async function shadowRecall({ topics, projection, query, workspace, pendingTopics = [],
  embed = embedLocal, embeddingOptions = {}, limit = 10, maxUnits = 200 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isInteger(maxUnits) || maxUnits < 1 || maxUnits > 1000) {
    throw new Error('Invalid shadow retrieval limits');
  }
  query = redactSecrets(query);
  const units = eligibleFacts(topics, projection, query, workspace, pendingTopics);
  if (units.length > maxUnits) throw new Error('Corpus exceeds shadow limit; select a smaller workspace or raise maxUnits explicitly');
  const keyword = search(buildIndex(units), query, { limit }).map(({ id, score }) => ({ id, score }));
  let semantic = []; let dimension = null; let degraded = null;
  if (units.length) {
    try {
      const queryVectors = await embed([query], embeddingOptions);
      dimension = validateVectors(queryVectors, 1);
      const vectors = [];
      for (let start = 0; start < units.length; start += 16) {
        const batch = units.slice(start, start + 16);
        const result = await embed(batch.map((row) => row.text), embeddingOptions);
        validateVectors(result, batch.length, dimension);
        vectors.push(...result);
      }
      semantic = units.map((row, i) => ({ id: row.id, score: cosine(queryVectors[0], vectors[i]) }))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
    } catch {
      degraded = 'local-embedding-unavailable-or-invalid';
      dimension = null;
    }
  }
  const byId = new Map(units.map((row) => [row.id, row]));
  return { mode: 'shadow', workspace, corpusSize: units.length, dimension, degraded,
    routes: { keyword, semantic },
    fused: fuseRoutes({ keyword, semantic }).slice(0, limit).map((row) => ({ ...row, ...byId.get(row.id), score: row.score })),
  };
}
