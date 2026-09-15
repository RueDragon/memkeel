import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../redaction.mjs';
import { atomicJson } from '../transport.mjs';
import { discoverWorkspace, ensureWorkspace, registerTopic } from '../core.mjs';
import { capture } from '../lifecycle.mjs';
import { isImportant, contentHash } from './pipeline.mjs';
import { parseCodexSession, selectCandidates, listCodexSessions } from './sources.mjs';

// Backfill orchestrator. Two modes share one code path:
//   plan()  -> read-only report of what would be captured
//   apply() -> writes the planned events through the normal capture path
// Nothing is written unless apply() runs, and apply() is idempotent through the
// dedup ledger plus the event id derived from session + turn content hash.

// Self-imposed excerpt bound for auto-imported historical turns, not an enforcement
// ceiling: the capture-side 1800-byte evidence gate was removed on 2026-09-14.
const EVIDENCE_MAX = 4000;
const CONTEXT_MAX = 1100;
const TASK_MAX = 160;

function utf8(text, max) {
  let result = '';
  for (const char of String(text)) {
    if (Buffer.byteLength(result + char) > max) break;
    result += char;
  }
  return result;
}

function oneLine(text, max) {
  return utf8(String(text).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim(), max);
}

function loadLedger(file) {
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Turns a candidate into the event shape the existing capture contract requires.
// The turn is stored as a reported short-term context, never as a verified fact.
function toCapture(config, candidate, workspace, topic) {
  const sessionKey = contentHash(candidate.sessionId).slice(0, 10);
  const turnHash = contentHash(candidate.text).slice(0, 8);
  const ordinal = candidate.ordinal ?? 0;
  const eventId = `ingest-${sessionKey}-${ordinal}-${turnHash}`;
  const id = `session-${sessionKey}-${ordinal}-${turnHash}`;
  const task = oneLine(candidate.text, TASK_MAX);
  const contextText = candidate.antecedent
    ? `用户输入：${oneLine(candidate.text, CONTEXT_MAX)}\n上下文：${oneLine(candidate.antecedent, 400)}`
    : oneLine(candidate.text, CONTEXT_MAX);
  const event = {
    event_id: eventId,
    workspace,
    topic,
    agent: candidate.harness,
    occurred_at: candidate.timestamp ?? new Date().toISOString(),
    contexts: [{ id, task, text: contextText, certainty: 'reported', ttl_days: 30 }],
  };
  // Budget the whole evidence string, not just the excerpt: the prefix plus the
  // newline is itself ~120 bytes. This is a deliberate excerpt bound, not a limit
  // capture enforces.
  const prefix = `历史会话回填。来源：${candidate.harness}，会话 ${sessionKey}，时间 ${candidate.timestamp ?? '未知'}。只保存脱敏截断的用户输入，不提升为已验证事实。\n`;
  const body = utf8(redactSecrets(candidate.text), Math.max(200, EVIDENCE_MAX - Buffer.byteLength(prefix)));
  const evidenceText = prefix + body;
  return { event, evidenceText, eventId };
}

// Reads all Codex sessions and returns the candidates worth backfilling, with the
// reason each skipped candidate was skipped, so the report is auditable.
export function collectCodexCandidates({ root, since = null, limit = Infinity } = {}) {
  const files = listCodexSessions(root);
  const transcripts = [];
  const unreadable = [];
  // Only real user threads are backfill sources. Sub-agent, automation and
  // agent-created threads carry orchestration traffic, not durable user intent.
  const allowedSources = new Set(['user', '']);
  let excludedThreads = 0;
  for (const file of files) {
    if (since) {
      const stat = fs.statSync(file);
      if (stat.mtime < since) continue;
    }
    try {
      const transcript = parseCodexSession(file);
      if (!allowedSources.has(transcript.threadSource)) { excludedThreads += 1; continue; }
      transcripts.push(transcript);
    }
    catch (error) { unreadable.push({ file, error: error.message }); }
  }
  unreadable.push(...[]);
  var excludedThreadCount = excludedThreads;
  // A per-session ordinal makes the derived event id unique even when the same text
  // appears twice in one session, which content hashing alone cannot separate.
  const counters = new Map();
  const all = selectCandidates(transcripts).map((candidate) => {
    const ordinal = counters.get(candidate.sessionId) ?? 0;
    counters.set(candidate.sessionId, ordinal + 1);
    return { ...candidate, ordinal };
  });
  const kept = [];
  const skipped = [];
  for (const candidate of all) {
    if (!candidate.text.trim()) { skipped.push({ reason: 'empty', sessionId: candidate.sessionId }); continue; }
    if (redactSecrets(candidate.text) !== candidate.text) { skipped.push({ reason: 'possible-secret', sessionId: candidate.sessionId }); continue; }
    if (!isImportant(candidate.text)) { skipped.push({ reason: 'low-importance', sessionId: candidate.sessionId, excerpt: oneLine(candidate.text, 80) }); continue; }
    kept.push(candidate);
    if (kept.length >= limit) break;
  }
  return { files: files.length, transcripts: transcripts.length, excludedThreads: excludedThreadCount, candidates: all.length, kept, skipped, unreadable };
}

// Dry run. Resolves workspace and topic per candidate without writing anything.
export function planCodexBackfill(config, { root, since = null, limit = Infinity, autoRegister = false } = {}) {
  const collected = collectCodexCandidates({ root, since, limit });
  const routes = new Map();
  const planned = [];
  for (const candidate of collected.kept) {
    const cwd = candidate.cwd && path.isAbsolute(candidate.cwd) ? candidate.cwd : undefined;
    const route = cwd ? discoverWorkspace(config, cwd) : undefined;
    // Temp session dirs and one-off scratch folders must not auto-create projects.
    // Only an already-registered workspace is backfilled unless autoRegister is set.
    if (!route) { collected.skipped.push({ reason: 'no-workspace', sessionId: candidate.sessionId }); continue; }
    if (route.discovered && !autoRegister) { collected.skipped.push({ reason: 'unregistered-workspace', sessionId: candidate.sessionId, cwd: route.workspace }); continue; }
    routes.set(route.id, route);
    const topicId = `${route.id}/task-context`;
    planned.push({
      eventId: `ingest-${contentHash(candidate.sessionId).slice(0, 10)}-${candidate.ordinal ?? 0}-${contentHash(candidate.text).slice(0, 8)}`,
      workspace: route.id,
      topic: topicId,
      timestamp: candidate.timestamp,
      excerpt: oneLine(candidate.text, 120),
    });
  }
  return {
    mode: 'plan',
    files: collected.files,
    transcripts: collected.transcripts,
    excludedThreads: collected.excludedThreads,
    authoredTurns: collected.candidates,
    planned: planned.length,
    skipped: collected.skipped.length,
    skipReasons: collected.skipped.reduce((acc, row) => { acc[row.reason] = (acc[row.reason] ?? 0) + 1; return acc; }, {}),
    unreadable: collected.unreadable,
    workspaces: [...routes.keys()],
    samples: planned.slice(0, 20),
  };
}

// Apply. Writes through capture(), so every backfilled turn lands in the immutable
// event journal with evidence, exactly like a live checkpoint would.
export function applyCodexBackfill(config, transport, { root, since = null, limit = Infinity, autoRegister = false, onProgress } = {}) {
  const collected = collectCodexCandidates({ root, since, limit });
  const ledgerFile = path.join(config.policyRoot, 'state', 'ingest-ledger.json');
  const ledger = loadLedger(ledgerFile);
  const written = [];
  const errors = [];
  let skippedExisting = 0;
  for (const candidate of collected.kept) {
    const cwd = candidate.cwd && path.isAbsolute(candidate.cwd) ? candidate.cwd : undefined;
    const discovered = cwd ? discoverWorkspace(config, cwd) : undefined;
    // Mirror planCodexBackfill: never auto-create a project for a scratch/temp cwd.
    if (!discovered) { errors.push({ reason: 'no-workspace', sessionId: candidate.sessionId }); continue; }
    if (discovered.discovered && !autoRegister) { errors.push({ reason: 'unregistered-workspace', sessionId: candidate.sessionId, cwd: discovered.workspace }); continue; }
    const route = discovered.discovered ? ensureWorkspaceSafe(config, transport, cwd) : discovered;
    if (!route) { errors.push({ reason: 'no-workspace', sessionId: candidate.sessionId }); continue; }
    let topic = config.topics.find((row) => row.id === `${route.id}/task-context`);
    if (!topic) {
      topic = registerTopic(config, { id: `${route.id}/task-context`, workspace: route.id, title: `${route.id} 近期任务上下文`, alias: '近期任务' });
      config.topics.push(topic);
    }
    const plan = toCapture(config, candidate, route.id, topic.id);
    if (ledger[plan.eventId]) { skippedExisting += 1; continue; }
    try {
      capture(config, transport, plan.event, plan.evidenceText);
      ledger[plan.eventId] = { at: new Date().toISOString(), workspace: route.id, source: candidate.sourcePath };
      atomicJson(ledgerFile, ledger);
      written.push(plan.eventId);
      if (onProgress) onProgress(written.length, plan.eventId);
    } catch (error) {
      errors.push({ eventId: plan.eventId, error: error.message });
    }
  }
  return { mode: 'apply', written: written.length, skippedExisting, errors, planned: collected.kept.length, skipped: collected.skipped.length };
}

// Same as ensureWorkspace but tolerates an already-registered route.
function ensureWorkspaceSafe(config, transport, cwd) {
  try { return ensureWorkspace(config, transport, cwd); }
  catch (error) {
    if (/Cannot register workspace/.test(error.message)) return undefined;
    throw error;
  }
}
