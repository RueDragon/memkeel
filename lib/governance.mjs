// Pure P2 admission/deduplication/candidate helpers. No persistence or apply API.
import crypto from 'node:crypto';
import { isImportant, importanceScore } from './ingest/pipeline.mjs';
import { resolveCollection } from './privacy.mjs';
import { isVisible, visibilityOf } from './visibility.mjs';

const SOURCES = new Set(['hook', 'mcp', 'backfill', 'worker', 'manual', 'unknown']);

export function normalizeText(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

export function contentDigest(value) {
  return crypto.createHash('sha256').update(normalizeText(value), 'utf8').digest('hex');
}

function collectionDenied(input) {
  return input.collection === false || input.collecting === false || input.collectionEnabled === false
    || input.collection?.collecting === false || input.collection?.enabled === false || input.collectionOff === true;
}

/** Reuse ingest's importance policy; trusted explicit/stateChange flags protect short meaningful changes. */
export function admissionScore(value, options = {}) {
  if (collectionDenied(options) || options.noRecord === true) {
    return { score: 0, admitted: false, reason: options.noRecord === true ? 'no-record' : 'collection-disabled' };
  }
  const text = normalizeText(value);
  const score = importanceScore(text);
  if (!text) return { score, admitted: false, reason: 'empty' };
  if (options.explicit === true) return { score, admitted: true, reason: 'explicit-request' };
  if (options.stateChange === true) return { score, admitted: true, reason: 'state-change' };
  return { score, admitted: isImportant(text), reason: isImportant(text) ? 'ingest-importance' : 'low-importance' };
}

/** Gate before reading/hashing text. Returns only decision metadata, never a recorded-success claim. */
export function admissionDecision(input = {}) {
  const source = SOURCES.has(input.source) ? input.source : 'unknown';
  const noRecord = [input.noRecord, input.no_record, input.readOnly, input.read_only].includes(true);
  // Do not echo resolveCollection.reason/matched: exclusions can contain private paths.
  const policy = input.config ? resolveCollection(input.config, { source, ...(input.collectionContext ?? input.context ?? input) }) : null;
  if (noRecord || collectionDenied(input) || policy?.collecting === false) {
    return { score: 0, admitted: false, reason: noRecord ? 'no-record' : 'collection-disabled', source,
      ...(policy?.collecting === false ? { decidedBy: policy.decidedBy } : {}) };
  }
  const text = input.text ?? input.summary ?? '';
  const result = admissionScore(text, {
    explicit: [input.explicit, input.explicitRequest, input.explicit_request].includes(true),
    stateChange: [input.stateChange, input.state_change].includes(true),
  });
  return { ...result, source, ...(result.admitted ? { digest: contentDigest(text) } : {}) };
}

function scopePart(item, names) {
  for (const name of names) if (typeof item?.[name] === 'string') return item[name].trim();
  return '';
}

export function governanceScope(item) {
  return {
    workspace: scopePart(item, ['workspace', 'workspaceId', 'workspace_id', 'project']),
    topic: scopePart(item, ['topic', 'topicId', 'topic_id']),
    task: scopePart(item, ['taskId', 'task_id', 'task']),
    branch: scopePart(item, ['branch', 'gitBranch', 'branchName']),
  };
}

function dedupeText(item, key) {
  // Never hash String(object): every text-less record would become '[object Object]'.
  return typeof item?.[key] === 'string' ? normalizeText(item[key]) : null;
}

/** Missing workspace or content is not sufficient evidence for automatic deduplication. */
export function dedupeKey(item, key = 'text') {
  const text = dedupeText(item, key);
  const scope = governanceScope(item);
  // Exact scoped dedupe requires every boundary. Missing task/branch must not
  // collapse facts merely because their prose happens to match.
  if (!scope.workspace || !scope.topic || !scope.task || !scope.branch || !text) return null;
  // Retain lifecycle transitions even when their prose is identical. A supplied digest
  // is not trusted as proof of equality; it can be stale or forged.
  const statuses = [item.status, item.visibilityStatus, item.visibility, item.lifecycle, item.visible, item.hidden];
  return JSON.stringify([scope.workspace, scope.topic, scope.task, scope.branch, item.type ?? item.kind ?? '', statuses, text]);
}

export function deduplicate(items, { key = 'text', includeDropped = false, now = new Date() } = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  const seen = new Map(); const kept = []; const duplicates = [];
  for (const item of items) {
    if (!includeDropped && !isVisible(item, { now })) { kept.push(item); continue; }
    const identity = dedupeKey(item, key);
    if (identity === null) { kept.push(item); continue; }
    if (seen.has(identity)) duplicates.push({ item, duplicateOf: seen.get(identity), digest: contentDigest(item[key]) });
    else { seen.set(identity, item); kept.push(item); }
  }
  return { kept, duplicates };
}

const DEFAULTS = Object.freeze({ hotDays: 7, warmDays: 30 });
export function lifecycleOf(item, { now = new Date(), hotDays = DEFAULTS.hotDays, warmDays = DEFAULTS.warmDays } = {}) {
  const visibility = visibilityOf(item, { now });
  if (!visibility.visible) return visibility.status;
  const at = Date.parse(item?.updatedAt ?? item?.updated_at ?? item?.occurred_at ?? item?.at ?? '');
  if (!Number.isFinite(at)) return 'unknown';
  const age = (new Date(now).getTime() - at) / 86400000;
  if (age < -1) return 'future';
  if (age <= hotDays) return 'hot';
  if (age <= warmDays) return 'warm';
  return 'dormant';
}

export function evidenceReferences(item) {
  const refs = item?.evidence ?? item?.evidenceRefs ?? [];
  return [...new Set((Array.isArray(refs) ? refs : [refs]).filter((value) => typeof value === 'string' && value.trim()))];
}

export function lifecycleCandidate(item, options = {}) {
  const lifecycle = lifecycleOf(item, options);
  const visibility = visibilityOf(item, { ...options, history: true });
  // Elapsed time only requests review. It neither invalidates a long-term fact nor closes a todo.
  const action = ['dormant', 'unknown', 'future', 'invalid'].includes(lifecycle) ? 'review'
    : ['closed', 'cancelled', 'canceled', 'archived'].includes(lifecycle) ? 'archive'
      : visibility.historical ? 'hide' : 'retain';
  const reason = lifecycle === 'dormant' ? 'no recent substantive update; review only, age is not invalidation'
    : lifecycle === 'unknown' ? 'missing substantive update time; review source'
      : lifecycle === 'future' ? 'future occurrence time; review clock/source'
        : visibility.historical ? `explicit visibility: ${visibility.status}` : 'within lifecycle window';
  return { id: item?.id ?? item?.key ?? item?.event_id ?? null, event_id: item?.event_id ?? null,
    ...governanceScope(item), action, lifecycle, reason, evidence: evidenceReferences(item), visibility,
    affectedViews: ['bootstrap', 'recall', 'summary', 'search'],
    recovery: 'No changes applied. Query history=true for original evidence. If separately approved, undo the specific retention decision or append an evidence-backed item revision, then rebuild projections/indexes; never rewrite the ledger.' };
}

export function buildGovernanceCandidates(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  return items.map((item) => lifecycleCandidate(item, options));
}
