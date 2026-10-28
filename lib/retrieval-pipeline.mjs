import { factQuery, contains } from './fact-retrieval.mjs';
import { redactSecrets } from './redaction.mjs';
import { retrievalCorpus } from './search/corpus.mjs';
import { indexedRecall } from './search/semantic-index.mjs';
import { buildIndex, search } from './search/bm25.mjs';

/**
 * Unified, read-only retrieval entry point for task start.
 *
 * The pipeline deliberately owns eligibility and budgets while the existing
 * corpus/BM25/vector implementations own matching and ranking. Callers may
 * provide `units` directly (useful for adapters/tests), or provide the normal
 * config/events/projection tuple and let retrievalCorpus build the corpus.
 */
export const RETRIEVAL_PIPELINE_VERSION = 1;
const HIDDEN = new Set(['archived', 'superseded', 'invalidated', 'closed', 'dormant', 'drop', 'dropped', 'hidden', 'soft-hidden', 'soft_hidden']);
const SOURCES = new Set(['fact', 'experience', 'note-section', 'task', 'context', 'task-summary']);

const asText = (value) => String(value ?? '');
const normalized = (value) => asText(value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function clipUtf8(value, maxBytes) {
  const text = asText(value);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return `${out}…`;
}

function hiddenStatus(unit) {
  const values = [unit.status, unit.visibility, unit.lifecycle, unit.retention, unit.state]
    .filter((v) => typeof v === 'string').map((v) => v.toLowerCase());
  return unit.visible === false || unit.hidden === true || values.some((v) => HIDDEN.has(v));
}

function workspaceOf(unit, topics) {
  if (typeof unit.workspace === 'string' && unit.workspace) return unit.workspace;
  const topic = typeof unit.topic === 'string' ? topics.get(unit.topic) : undefined;
  return topic?.workspace ?? null;
}

function canonicalUnit(unit) {
  const text = normalized(unit.text);
  // Collapse repeated projections of the same statement across fact/note/task
  // routes. An id is only the fallback because ids often differ per source.
  if (text) return [unit.workspace, unit.topic, text].filter(Boolean).join('|');
  return String(unit.id ?? [unit.sourceType, unit.key, unit.path].filter(Boolean).join('|'));
}

function taskKey(unit) {
  return unit.taskId ?? unit.task_id ?? unit.task ?? unit.metadata?.taskId ?? null;
}

function entityEligible(unit, parsed) {
  if (!parsed.entities.length) return true;
  const text = normalized(`${unit.title ?? ''} ${unit.text ?? ''} ${unit.extra ?? ''}`);
  return parsed.entities.every((term) => contains(text, term));
}

function dedupeAndBound(units, { maxPerTask, maxUnits }) {
  const seen = new Set();
  const taskCounts = new Map();
  const out = [];
  for (const unit of units) {
    const id = canonicalUnit(unit);
    if (seen.has(id)) continue;
    const key = taskKey(unit);
    if (key && (taskCounts.get(key) ?? 0) >= maxPerTask) continue;
    seen.add(id);
    if (key) taskCounts.set(key, (taskCounts.get(key) ?? 0) + 1);
    out.push(unit);
    if (out.length >= maxUnits) break;
  }
  return out;
}

function fallbackKeyword(units, query, limit) {
  return search(buildIndex(units), query, { limit }).map(({ id, score }) => ({ id, score }));
}

function timeoutPromise(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs)) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('retrieval-timeout')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Optional process-local cache for task-start reads. Keys include scope and
 * caller-supplied state versions so retention/privacy changes cannot reuse an
 * older result. It stores bounded, already-redacted result objects only.
 */
export function createRetrievalCache({ maxEntries = 128, version = '1' } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000) throw new Error('Invalid retrieval cache size');
  const entries = new Map();
  const keyOf = ({ workspace, query, index, model = '', visibilityVersion = '', retentionVersion = '', memoryVersion = '', privacyVersion = '', history = false, embeddingOptions = {}, budget = {} }) => JSON.stringify({
    version, workspace, query: redactSecrets(query), profile: index?.profile?.fingerprint ?? null,
    indexRevision: index?.revision ?? null, visibilityVersion, retentionVersion, memoryVersion, privacyVersion,
    history, model: model || embeddingOptions.model || index?.model || null, budget,
  });
  const get = (input) => {
    const key = keyOf(input);
    const value = entries.get(key);
    if (!value) return undefined;
    entries.delete(key); entries.set(key, value);
    return structuredClone(value);
  };
  const set = (input, value) => {
    const key = keyOf(input);
    entries.delete(key); entries.set(key, structuredClone(value));
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    return value;
  };
  return { get, set, clear: () => entries.clear(), get size() { return entries.size; } };
}

function validateOptions(options) {
  const budget = options.budget ?? {};
  const integer = (key, fallback, min, max) => {
    const value = budget[key] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid retrieval budget: ${key}`);
    return value;
  };
  const minSemanticScore = budget.minSemanticScore ?? 0.2;
  if (typeof minSemanticScore !== 'number' || !Number.isFinite(minSemanticScore) || minSemanticScore < -1 || minSemanticScore > 1) {
    throw new Error('Invalid retrieval budget: minSemanticScore');
  }
  return {
    limit: integer('limit', 8, 1, 50),
    maxUnits: integer('maxUnits', 1000, 1, 5000),
    maxBytes: integer('maxBytes', 12000, 256, 100000),
    maxPerTask: integer('maxPerTask', 3, 1, 50),
    timeoutMs: integer('timeoutMs', 5000, 1, 60000),
    minSemanticScore,
  };
}

/**
 * Retrieve task context with strict scope, visibility filtering, deduplication,
 * and an explicit degradation report. This function never writes storage.
 */
export async function retrieveTaskContext({
  config,
  events = [],
  projection = { facts: [], conflicts: [] },
  units: suppliedUnits,
  query,
  workspace,
  index = null,
  cache = null,
  visibilityVersion = '',
  retentionVersion = '',
  memoryVersion = '',
  privacyVersion = '',
  pendingTopics = [],
  history = false,
  crossWorkspace = false,
  embed,
  model,
  embeddingOptions = {},
  budget = {},
  now = Date.now(),
} = {}) {
  const started = Date.now();
  if (typeof workspace !== 'string' || !workspace.trim()) throw new Error('Explicit workspace required');
  if (typeof query !== 'string' || !query.trim()) throw new Error('Non-empty query required');
  if (crossWorkspace) throw new Error('Cross-workspace retrieval requires an explicit scoped adapter');
  const limits = validateOptions({ budget });
  const safeQuery = redactSecrets(query);
  const cacheInput = {
    workspace, query: safeQuery, index, model: model ?? index?.model ?? embeddingOptions.model, visibilityVersion, retentionVersion,
    memoryVersion, privacyVersion, history, embeddingOptions, budget: limits,
  };
  if (cache) {
    if (typeof cache.get !== 'function' || typeof cache.set !== 'function') throw new Error('Invalid retrieval cache');
    const cached = cache.get(cacheInput);
    if (cached) return { ...cached, diagnostics: { ...cached.diagnostics, cache: 'hit', elapsedMs: Date.now() - started } };
  }
  const parsed = factQuery(safeQuery);
  const topics = new Map((config?.topics ?? []).filter((topic) => topic && typeof topic.id === 'string').map((topic) => [topic.id, topic]));
  let units;
  let corpusError = null;
  try {
    units = Array.isArray(suppliedUnits)
      ? suppliedUnits
      : retrievalCorpus(config, events, projection, safeQuery, workspace, pendingTopics);
  } catch (error) {
    corpusError = error instanceof Error ? error.message : 'corpus-error';
    units = [];
  }

  const reasons = [];
  const hidden = [];
  const outOfScope = [];
  const wrongEntity = [];
  const eligible = [];
  for (const unit of units ?? []) {
    if (!unit || typeof unit !== 'object') continue;
    if (!history && hiddenStatus(unit)) { hidden.push(unit.id ?? null); continue; }
    const unitWorkspace = workspaceOf(unit, topics);
    if (unitWorkspace !== workspace) { outOfScope.push(unit.id ?? null); continue; }
    if (unit.sourceType && !SOURCES.has(unit.sourceType)) continue;
    if (!entityEligible(unit, parsed)) { wrongEntity.push(unit.id ?? null); continue; }
    eligible.push({ ...unit, workspace: unitWorkspace, historical: Boolean(history && hiddenStatus(unit)) });
  }
  const bounded = dedupeAndBound(eligible, limits);
  if (outOfScope.length) reasons.push('workspace-filtered');
  if (wrongEntity.length) reasons.push('entity-filtered');
  if (hidden.length) reasons.push('visibility-filtered');
  if (bounded.length < eligible.length) reasons.push('budget-or-dedup-filtered');

  let retrieval;
  try {
    // An absent index is an expected cold-start condition, not a successful
    // semantic query. Skip vector route and report the explicit fallback.
    if (!index) throw new Error('semantic-index-unavailable-or-invalid');
    retrieval = await timeoutPromise(indexedRecall(bounded, safeQuery, index, {
      embed, model: model ?? index.model, embeddingOptions, limit: limits.limit,
    }), limits.timeoutMs);
    if (retrieval.routes?.semantic?.length) {
      const semanticById = new Map(retrieval.routes.semantic.map((row) => [row.id, row.score]));
      retrieval.routes.semantic = retrieval.routes.semantic.filter((row) => row.score >= limits.minSemanticScore);
      const allowedSemantic = new Set(retrieval.routes.semantic.map((row) => row.id));
      retrieval.fused = retrieval.fused.filter((row) => {
        const sources = row.sources ?? [];
        return sources.some((source) => source.source !== 'semantic') || allowedSemantic.has(row.id)
          || !semanticById.has(row.id);
      });
    }
  } catch (error) {
    reasons.push(error?.message === 'retrieval-timeout' ? 'retrieval-timeout' : 'keyword-fallback');
    const keyword = fallbackKeyword(bounded, safeQuery, limits.limit);
    retrieval = { mode: 'keyword-fallback', stale: 0, degraded: error?.message === 'retrieval-timeout' ? 'retrieval-timeout' : 'semantic-index-unavailable-or-invalid', routes: { exact: [], keyword, semantic: [] }, fused: keyword };
  }
  if (retrieval.degraded) reasons.push(retrieval.degraded);
  if (corpusError) reasons.push('corpus-unavailable');

  const byId = new Map(bounded.map((unit) => [unit.id, unit]));
  const hits = [];
  let bytes = 0;
  for (const raw of retrieval.fused ?? []) {
    const unit = byId.get(raw.id);
    if (!unit) continue;
    const text = redactSecrets(unit.text ?? '');
    const hit = {
      id: unit.id,
      sourceType: unit.sourceType,
      workspace: unit.workspace,
      topic: unit.topic,
      title: unit.title,
      path: unit.path,
      event_id: unit.event_id,
      taskId: taskKey(unit),
      text: clipUtf8(text, Math.min(12000, Math.max(256, limits.maxBytes))),
      score: raw.score ?? 0,
      matchReasons: raw.sources ?? [],
      source: unit.path ?? unit.event_id ?? unit.id,
      conflict: Boolean(unit.conflict),
      needsReverify: Boolean(unit.needsReverify),
      historical: Boolean(unit.historical),
      stale: Boolean(retrieval.stale),
    };
    const cost = Buffer.byteLength(JSON.stringify(hit));
    if (bytes + cost > limits.maxBytes) continue;
    bytes += cost;
    hits.push(hit);
    if (hits.length >= limits.limit) break;
  }
  const result = {
    version: RETRIEVAL_PIPELINE_VERSION,
    executed: true,
    workspace,
    query: safeQuery,
    hits,
    diagnostics: {
      mode: retrieval.mode ?? 'indexed-shadow',
      degraded: retrieval.degraded ?? null,
      reasons: [...new Set(reasons)],
      corpusSize: units?.length ?? 0,
      eligibleUnits: eligible.length,
      boundedUnits: bounded.length,
      stale: retrieval.stale ?? 0,
      bytes,
      budget: limits,
      elapsedMs: Date.now() - started,
      filtered: { hidden: hidden.length, outOfScope: outOfScope.length, wrongEntity: wrongEntity.length },
      routes: Object.fromEntries(Object.entries(retrieval.routes ?? {}).map(([name, rows]) => [name, rows.length])),
      cache: cache ? 'miss' : 'disabled',
    },
  };
  if (cache) cache.set(cacheInput, result);
  return result;
}

// Names used by host adapters can remain stable while the implementation evolves.
export const taskPreRetrieval = retrieveTaskContext;
export const retrieveBeforeTask = retrieveTaskContext;
