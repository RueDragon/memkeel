import { sha } from '../transport.mjs';
import { redactSecrets } from '../redaction.mjs';
import { cosine, embedLocal, validateVectors, DEFAULT_MODEL, localEndpoint } from './local-embedding.mjs';
import { buildIndex, search } from './bm25.mjs';
import { fuseRoutes } from './shadow.mjs';
import { factQuery, contains } from '../fact-retrieval.mjs';

export const INDEX_VERSION = 3;

export function splitEmbeddingText(text, chunkChars = 2000, overlapChars = 200) {
  if (typeof text !== 'string' || !text.trim() || text.length > 100000
    || !Number.isInteger(chunkChars) || chunkChars < 256 || chunkChars > 6000
    || !Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= chunkChars / 2)
    throw new Error('Invalid bounded embedding text or chunk settings');
  const chars = Array.from(redactSecrets(text));
  const chunks = [];
  for (let start = 0; start < chars.length; start += chunkChars - overlapChars) {
    const chunk = chars.slice(start, start + chunkChars).join('');
    if (chunk.trim()) chunks.push(chunk);
    if (start + chunkChars >= chars.length) break;
  }
  return chunks;
}

export function embeddingProfile(model = DEFAULT_MODEL, options = {}) {
  const { modelRevision = 'unverified-model-id', queryPrefix = '', documentPrefix = '' } = options;
  const { chunkChars = 2000, overlapChars = 200 } = options;
  splitEmbeddingText('validate', chunkChars, overlapChars);
  if (typeof model !== 'string' || !model.trim() || typeof modelRevision !== 'string' || !modelRevision.trim()
    || modelRevision.length > 256 || [queryPrefix, documentPrefix].some((p) => typeof p !== 'string' || p.length > 512))
    throw new Error('Invalid embedding profile');
  const profile = { model, modelRevision, queryPrefix, documentPrefix, chunkChars, overlapChars, endpoint: localEndpoint(options.endpoint) };
  return { ...profile, fingerprint: sha(JSON.stringify(profile)) };
}
export const contentHash = (unit) => sha(JSON.stringify([unit.id, unit.text]));

export function validateSemanticIndex(index) {
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.rows)
    || index.rows.length > 100000 || !index.profile || index.model !== index.profile.model)
    throw new Error('Invalid semantic index');
  const profile = embeddingProfile(index.model, index.profile);
  if (profile.fingerprint !== index.profile.fingerprint) throw new Error('Invalid index profile fingerprint');
  if (index.rows.length && (!Number.isInteger(index.dimension) || index.dimension < 1 || index.dimension > 16384))
    throw new Error('Invalid index dimension');
  const seen = new Set();
  for (const row of index.rows) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)
      || !/^[a-f0-9]{64}$/.test(row.hash ?? '') || !Array.isArray(row.vectors)
      || !row.vectors.length || row.vectors.length > 800) throw new Error('Invalid index row');
    seen.add(row.id);
    validateVectors(row.vectors, row.vectors.length, index.dimension);
  }
  return index;
}

// Build is explicit; publication/storage is owned by the caller. A failed build
// never mutates the previous index. Only compatible unchanged vectors are reused.
export async function buildSemanticIndex(units, { previous = null, embed = embedLocal,
  model = DEFAULT_MODEL, embeddingOptions = {}, revision = '', sourceCheck = () => true } = {}) {
  if (new Set(units.map((u) => u.id)).size !== units.length) throw new Error('Duplicate unit id');
  const profile = embeddingProfile(model, embeddingOptions);
  if (previous?.version === INDEX_VERSION) {
    try { validateSemanticIndex(previous); } catch { previous = null; }
  }
  const compatible = previous?.version === INDEX_VERSION && previous.profile?.fingerprint === profile.fingerprint;
  const reusable = compatible
    ? new Map(previous.rows.map((r) => [r.id, r])) : new Map();
  let dimension = compatible ? previous.dimension : null;
  // Validate and split the full corpus before issuing any model request.
  const chunksById = new Map(units.map((u) => [u.id, splitEmbeddingText(u.text, profile.chunkChars, profile.overlapChars)]));
  const rows = []; let reused = 0; let embedded = 0;
  for (let start = 0; start < units.length; start += 16) {
    const batch = units.slice(start, start + 16);
    const changed = batch.filter((unit) => reusable.get(unit.id)?.hash !== contentHash(unit));
    const inputs = changed.flatMap((u) => chunksById.get(u.id).map((text) => profile.documentPrefix + text));
    const vectors = [];
    for (let offset = 0; offset < inputs.length; offset += 16) {
      const input = inputs.slice(offset, offset + 16);
      const output = await embed(input, { ...embeddingOptions, model });
      dimension = validateVectors(output, input.length, dimension);
      vectors.push(...output);
    }
    let offset = 0;
    const newlyEmbedded = new Map(changed.map((u) => {
      const count = chunksById.get(u.id).length;
      const value = vectors.slice(offset, offset + count); offset += count;
      return [u.id, value];
    }));
    for (const unit of batch) {
      const chunkVectors = newlyEmbedded.get(unit.id) ?? reusable.get(unit.id)?.vectors;
      dimension = validateVectors(chunkVectors, chunksById.get(unit.id).length, dimension);
      if (newlyEmbedded.has(unit.id)) embedded += 1; else reused += 1;
      rows.push({ id: unit.id, hash: contentHash(unit), vectors: chunkVectors });
    }
  }
  if (!sourceCheck()) throw new Error('Source changed during index build');
  return { version: INDEX_VERSION, model, profile, dimension, revision, rows, stats: { reused, embedded } };
}

// Current eligible units are authoritative, not the contents of the old index.
export async function indexedRecall(units, query, index, { embed = embedLocal,
  model = DEFAULT_MODEL, embeddingOptions = {}, limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid result limit');
  query = redactSecrets(query);
  const keyword = search(buildIndex(units), query, { limit }).map(({ id, score }) => ({ id, score }));
  const parsed = factQuery(query);
  const exact = units.filter((u) => u.sourceType === 'fact').map((u) => {
    const text = u.text.normalize('NFKC').toLowerCase();
    const entities = parsed.entities.filter((term) => contains(text, term));
    const words = parsed.words.filter((term) => contains(text, term));
    return { id: u.id, score: entities.length === parsed.entities.length ? entities.length * 20 + words.length * 3 : 0 };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  let semantic = []; let degraded = null; let stale = 0;
  try {
    const profile = embeddingProfile(model, embeddingOptions);
    validateSemanticIndex(index);
    if (!index || index.version !== INDEX_VERSION || index.profile?.fingerprint !== profile.fingerprint)
      throw new Error('Index incompatible');
    const stored = new Map(index.rows.map((r) => [r.id, r]));
    const current = units.filter((unit) => {
      const match = stored.get(unit.id)?.hash === contentHash(unit);
      if (!match) stale += 1;
      return match;
    });
    if (current.length) {
      const vectors = await embed([profile.queryPrefix + query], { ...embeddingOptions, model });
      validateVectors(vectors, 1, index.dimension);
      semantic = current.map((unit) => {
        const row = stored.get(unit.id);
        validateVectors(row.vectors, splitEmbeddingText(unit.text, profile.chunkChars, profile.overlapChars).length, index.dimension);
        return { id: unit.id, score: Math.max(...row.vectors.map((vector) => cosine(vectors[0], vector))), chunks: row.vectors.length };
      }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
    }
  } catch { degraded = 'semantic-index-unavailable-or-invalid'; semantic = []; }
  const byId = new Map(units.map((u) => [u.id, u]));
  return { mode: 'indexed-shadow', stale, degraded, routes: { exact, keyword, semantic },
    fused: fuseRoutes({ exact, keyword, semantic }).slice(0, limit).map((r) => ({ ...byId.get(r.id), ...r })) };
}
