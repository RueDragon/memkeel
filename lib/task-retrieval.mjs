import fs from 'node:fs';
import path from 'node:path';
import { loadEvents, reduceEvents, consumptionStatus, resolveWorkspaceId, loadRoutes, discoverWorkspace } from './core.mjs';
import { learningProjection, retention } from './experience.mjs';
import { loadRetention } from './retention.mjs';
import { sha } from './transport.mjs';
import { retrieveTaskContext, createRetrievalCache } from './retrieval-pipeline.mjs';
import { buildIndex, search } from './search/bm25.mjs';
import { factQuery, contains } from './fact-retrieval.mjs';
import { isVisible } from './visibility.mjs';
import { redactSecrets } from './redaction.mjs';
import { governanceReport } from './governance-report.mjs';
import { validateSemanticIndex } from './search/semantic-index.mjs';
import { retrievalCorpus } from './search/corpus.mjs';
import { resolveCollection } from './privacy.mjs';

const caches = new WeakMap();

function readIndex(config, workspace) {
  const file = path.join(config.policyRoot, 'state', 'knowledge-upgrade', `${workspace}.index.json`);
  if (!fs.existsSync(file)) return { index: null, state: 'missing' };
  try {
    const index = JSON.parse(fs.readFileSync(file, 'utf8'));
    validateSemanticIndex(index);
    return { index, state: 'available' };
  } catch {
    return { index: null, state: 'invalid' };
  }
}

function visibleLearning(config, events, workspace, now, dropped, history) {
  const projection = learningProjection(events);
  const conflicts = new Set(projection.conflicts.map((row) => row.key));
  const byId = new Map(events.map((event) => [event.event_id, event]));
  return projection.entries
    .filter((row) => row.workspace === workspace && (history || !dropped.has(row.event_id)))
    .filter((row) => !conflicts.has(`${row.type}/${row.topic}/${row.id}`))
    .filter((row) => history || ['retained', 'hot', 'warm'].includes(retention(row, now)))
    .filter((row) => {
      const event = byId.get(row.event_id);
      return resolveCollection(config, { workspace: row.workspace, host: event?.agent }).collecting;
    })
    .map((row) => ({
      id: JSON.stringify([row.type === 'contexts' ? 'context' : 'experience', row.topic, row.id, row.event_id]),
      sourceType: row.type === 'contexts' ? 'context' : 'experience',
      workspace: row.workspace,
      topic: row.topic,
      event_id: row.event_id,
      taskId: row.task,
      title: row.task,
      text: row.text,
      status: dropped.has(row.event_id) ? 'drop' : (row.status ?? 'active'),
      lifecycle: dropped.has(row.event_id) ? 'drop' : retention(row, now),
      certainty: row.certainty ?? 'verified',
      path: row.evidence?.[0],
      needsReverify: row.type === 'experiences' || row.certainty !== 'verified',
    }));
}

function boundedText(value, maxBytes) {
  let text = '';
  for (const char of String(value ?? '')) {
    if (Buffer.byteLength(text + char) > maxBytes) break;
    text += char;
  }
  return text;
}

function annotateDropped(units, dropped, history) {
  if (!history) return units;
  return units.map((unit) => dropped.has(unit.event_id)
    ? { ...unit, status: 'drop', lifecycle: 'drop' }
    : unit);
}

/** Synchronous hook-safe task recall. It intentionally uses keyword search only. */
export function retrieveForTaskSync(config, { workspace, cwd, query, history = false, limit = 5, maxBytes = 6000 } = {}) {
  if (!query?.trim()) throw new Error('Non-empty task query required');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(maxBytes) || maxBytes < 256 || maxBytes > 20000)
    throw new Error('Invalid synchronous retrieval budget');
  const routes = loadRoutes(config);
  const resolvedWorkspace = workspace ? resolveWorkspaceId(workspace, routes) : discoverWorkspace(config, cwd, routes)?.id;
  if (!resolvedWorkspace) throw new Error('Explicit registered workspace or matching cwd required');
  const started = Date.now();
  const safeQuery = redactSecrets(query);
  const events = loadEvents(config);
  const consumption = consumptionStatus(config, events);
  const dropped = new Set(Object.entries(loadRetention(config).decisions)
    .filter(([, row]) => row?.decision === 'drop').map(([id]) => id));
  const visibleEvents = events.filter((event) => history || !dropped.has(event.event_id));
  const projection = reduceEvents(visibleEvents);
  const now = config.now ?? new Date();
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const workspaceCollecting = resolveCollection(config, { workspace: resolvedWorkspace }).collecting;
  const base = workspaceCollecting
    ? retrievalCorpus(config, visibleEvents, projection, safeQuery, resolvedWorkspace, consumption.pendingTopics)
    : [];
  const units = [...annotateDropped(base, dropped, history), ...visibleLearning(config, events, resolvedWorkspace, now, dropped, history)]
    .filter((unit) => {
      if (unit.workspace !== resolvedWorkspace) return false;
      const event = eventsById.get(unit.event_id);
      const collecting = resolveCollection(config, { workspace: resolvedWorkspace, host: event?.agent }).collecting;
      if (!history && event && dropped.has(event.event_id)) return false;
      if (!collecting) return false;
      return history || isVisible(unit, { now });
    });
  const parsed = factQuery(safeQuery);
  const eligible = units.filter((unit) => parsed.entities.every((term) => contains(`${unit.title ?? ''} ${unit.text ?? ''}`.normalize('NFKC').toLowerCase(), term)));
  const rows = search(buildIndex(eligible), safeQuery, { limit });
  const byId = new Map(eligible.map((unit) => [unit.id, unit]));
  const hits = [];
  let bytes = 0;
  for (const row of rows) {
    const unit = byId.get(row.id);
    if (!unit) continue;
    const hit = { id: unit.id, sourceType: unit.sourceType, workspace: unit.workspace, topic: unit.topic,
      title: unit.title, path: unit.path, event_id: unit.event_id, score: row.score,
      text: boundedText(redactSecrets(unit.text), Math.max(256, Math.min(12000, maxBytes))),
      needsReverify: Boolean(unit.needsReverify), historical: Boolean(history && !isVisible(unit, { now })) };
    const cost = Buffer.byteLength(JSON.stringify(hit));
    if (bytes + cost > maxBytes) continue;
    bytes += cost;
    hits.push(hit);
  }
  return { version: 1, executed: true, workspace: resolvedWorkspace, hits,
    diagnostics: { mode: 'keyword-fallback', degraded: 'async-semantic-unavailable', reasons: ['synchronous-hook-path'],
      corpusSize: units.length, eligibleUnits: eligible.length, boundedUnits: eligible.length, stale: 0, bytes,
      elapsedMs: Date.now() - started, routes: { keyword: hits.length }, cache: 'disabled',
      pending: consumption.pending, queued: consumption.queued } };
}

/** Read-only task-start retrieval shared by the CLI, MCP and host adapters. */
export async function retrieveForTask(config, { workspace, cwd, query, history = false, budget = {}, embed, embeddingOptions } = {}) {
  if (!query?.trim()) throw new Error('Non-empty task query required');
  const routes = loadRoutes(config);
  const resolvedWorkspace = workspace
    ? resolveWorkspaceId(workspace, routes)
    : discoverWorkspace(config, cwd, routes)?.id;
  if (!resolvedWorkspace) throw new Error('Explicit registered workspace or matching cwd required');

  const events = loadEvents(config);
  const consumption = consumptionStatus(config, events);
  const dropped = new Set(Object.entries(loadRetention(config).decisions)
    .filter(([, row]) => row?.decision === 'drop').map(([id]) => id));
  const visibleEvents = events.filter((event) => history || !dropped.has(event.event_id));
  const projection = reduceEvents(visibleEvents);
  const now = config.now ?? new Date();
  const base = resolveCollection(config, { workspace: resolvedWorkspace }).collecting
    ? retrievalCorpus(config, visibleEvents, projection, query, resolvedWorkspace, consumption.pendingTopics)
    : [];
  const contexts = visibleLearning(config, events, resolvedWorkspace, now, dropped, history);
  const eventsById = new Map(events.map((event) => [event.event_id, event]));
  const units = [...annotateDropped(base, dropped, history), ...contexts].filter((unit) => {
    if (unit.workspace !== resolvedWorkspace) return false;
    const event = eventsById.get(unit.event_id);
    if (!history && event && dropped.has(event.event_id)) return false;
    return resolveCollection(config, { workspace: resolvedWorkspace, host: event?.agent }).collecting;
  });
  const indexState = readIndex(config, resolvedWorkspace);
  const retentionVersion = sha(JSON.stringify([...dropped].sort()));
  const memoryVersion = sha(JSON.stringify(events.map((event) => [event.event_id, event.recorded_at])));
  let cache = caches.get(config);
  if (!cache) { cache = createRetrievalCache(); caches.set(config, cache); }
  const result = await retrieveTaskContext({
    config,
    events,
    projection,
    units,
    query,
    workspace: resolvedWorkspace,
    index: indexState.index,
    cache,
    visibilityVersion: sha(JSON.stringify(config.topics ?? [])),
    retentionVersion,
    memoryVersion,
    privacyVersion: sha(JSON.stringify(config.collection ?? {})),
    pendingTopics: consumption.pendingTopics,
    history,
    embed,
    embeddingOptions: indexState.index ? {
      modelRevision: indexState.index.profile.modelRevision,
      queryPrefix: indexState.index.profile.queryPrefix,
      documentPrefix: indexState.index.profile.documentPrefix,
      endpoint: indexState.index.profile.endpoint,
      chunkChars: indexState.index.profile.chunkChars,
      overlapChars: indexState.index.profile.overlapChars,
      ...embeddingOptions,
    } : embeddingOptions,
    model: indexState.index?.model,
    budget,
  });
  const reasons = [...result.diagnostics.reasons];
  if (indexState.state !== 'available' && !reasons.includes(`semantic-index-${indexState.state}`)) reasons.push(`semantic-index-${indexState.state}`);
  return {
    ...result,
    diagnostics: {
      ...result.diagnostics,
      index: indexState.state,
      source: 'local-memory',
      reasons,
      pending: consumption.pending,
      queued: consumption.queued,
    },
  };
}

/** Append bounded hits to the ordinary startup summary without exceeding its byte budget. */
export function appendTaskRetrieval(summary, retrieval, maxBytes = 14000) {
  const original = String(summary ?? '');
  const remaining = Math.max(0, maxBytes - Buffer.byteLength(original));
  if (!remaining) return original;
  const prefix = '\n\n## 任务前相关记忆\n';
  if (retrieval?.executed === false) {
    const skipped = `${prefix}检索未执行（${retrieval.reason ?? '原因未知'}）。请在获得当前任务目标后调用 task_recall。\n`;
    return Buffer.byteLength(skipped) <= remaining ? `${original}${skipped}` : original;
  }
  const status = retrieval?.diagnostics?.degraded
    ? `检索已执行，降级为 ${retrieval.diagnostics.mode}（${retrieval.diagnostics.degraded}）；`
    : '检索已执行；';
  const rows = [`${prefix}${status}工作区 ${retrieval?.workspace ?? 'unknown'}，命中 ${retrieval?.hits?.length ?? 0} 条。`];
  for (const hit of retrieval?.hits ?? []) {
    rows.push(`- ${hit.title ?? hit.topic ?? hit.id}：${hit.text}${hit.needsReverify ? '（使用前复核）' : ''}`);
  }
  let addition = '';
  for (const row of rows) {
    const candidate = `${addition}${row}\n`;
    if (Buffer.byteLength(candidate) > remaining) break;
    addition = candidate;
  }
  return addition ? `${original}${addition}` : original;
}

/** Build a body-free governance inventory from validated ledger rows. */
export function buildCurrentGovernanceReport(config, { history = false } = {}) {
  const events = loadEvents(config);
  const retention = loadRetention(config).decisions;
  const supersededRows = new Set();
  for (const event of events) {
    for (const fact of event.facts ?? []) if (fact.supersedes) supersededRows.add(JSON.stringify(['fact', event.topic, fact.key, fact.supersedes]));
    for (const context of event.contexts ?? []) if (context.supersedes) supersededRows.add(JSON.stringify(['context', event.topic, context.id, context.supersedes]));
    for (const experience of event.experiences ?? []) if (experience.supersedes) supersededRows.add(JSON.stringify(['experience', event.topic, experience.id, experience.supersedes]));
  }
  const items = [];
  for (const event of events) {
    const dropped = retention[event.event_id]?.decision === 'drop';
    const base = { workspace: event.workspace, topic: event.topic, event_id: event.event_id,
      occurred_at: event.occurred_at, evidence: event.evidence,
      status: dropped ? 'drop' : 'active' };
    for (const fact of event.facts ?? []) items.push({ ...base, ...fact, id: fact.key, type: 'fact',
      status: fact.status === 'invalidated' ? 'invalidated' : (dropped ? 'drop' : (supersededRows.has(JSON.stringify(['fact', event.topic, fact.key, event.event_id])) ? 'superseded' : 'active')) });
    for (const context of event.contexts ?? []) items.push({ ...base, ...context, id: context.id, type: 'context',
      status: dropped ? 'drop' : (supersededRows.has(JSON.stringify(['context', event.topic, context.id, event.event_id])) ? 'superseded' : (context.status ?? 'active')) });
    for (const experience of event.experiences ?? []) items.push({ ...base, ...experience, id: experience.id, type: 'experience',
      status: dropped ? 'drop' : (supersededRows.has(JSON.stringify(['experience', event.topic, experience.id, event.event_id])) ? 'superseded' : (experience.status ?? 'active')) });
    for (const action of event.actions ?? []) items.push({ ...base, ...action, id: action.id, type: 'task', taskId: action.id,
      status: action.status === 'done' ? 'closed' : base.status });
  }
  return governanceReport(items, { history, now: config.now ?? new Date() });
}
