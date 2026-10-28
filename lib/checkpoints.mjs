import { withQueueMutex } from './checkpoint-worker.mjs';
import fs from 'node:fs';
import { redactSecrets } from './redaction.mjs';
import path from 'node:path';
import { registerTopic, loadEvents, loadRoutes, ensureWorkspace, consolidate } from './core.mjs';
import { capture, prepareCapture, admitCapture } from './lifecycle.mjs';
import { resolveCollection } from './privacy.mjs';
import { admissionDecision } from './governance.mjs';
import { atomicJson, withLock } from './transport.mjs';

function utf8(text, max) {
  let result = '';
  for (const char of String(text)) { if (Buffer.byteLength(result + char) > max) break; result += char; }
  return result;
}
function eventText(text, max) {
  return utf8(redactSecrets(text), max).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
export function drainCheckpoints(config, transport, { limit = 20, kernelLocked = false, now = Date.now(), deferConsolidation = false, ids = [] } = {}) {
  const root = path.join(config.policyRoot, 'state/hook-queue');
  if (!fs.existsSync(root)) return { processed: 0, errors: [] };
  if (process.platform === 'win32' && !kernelLocked) {
    const result = withQueueMutex(root, () => drainCheckpoints(config, transport, { limit, kernelLocked: true, now, deferConsolidation, ids }));
    return result?.busy ? { processed: 0, errors: [], busy: true } : result;
  }
  const lock = kernelLocked ? (_root, callback) => callback() : withLock;
  return lock(root, () => {
    let processed = 0; const errors = []; let held = 0;
    const known = new Set(loadEvents(config).map((event) => event.event_id));
    // `held` rows are re-considered on every pass: they were deferred, not decided, so turning
    // collection back on drains them normally.
    const rows = fs.readdirSync(root).filter((name) => name.endsWith('.json')).flatMap((name) => {
      try {
        const row = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
        if (!row.id || typeof row.at !== 'string') throw new Error('Invalid checkpoint row');
        return [{ file: path.join(root, name), row }];
      } catch { errors.push({ id: name, error: 'Corrupt checkpoint queue row; inspect original file' }); return []; }
    })
      .filter(({ row }) => (row.status === 'pending' || row.status === 'held' || (ids.includes(row.id) && row.status === 'needs_attention'))
        && (ids.includes(row.id) || !row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now))
      .filter(({ row }) => !ids.length || ids.includes(row.id)).sort((a, b) => a.row.at.localeCompare(b.row.at)).slice(0, limit);
    for (const { file, row } of rows) {
      try {
        // Queued-but-not-yet-drained is the gap that matters most: a checkpoint written before the
        // switch was turned off must not become evidence afterwards, or "off" would only mean "off
        // for new sessions" while the text already on disk kept arriving in the ledger.
        const collection = resolveCollection(config, { host: row.host, workspace: row.workspace, cwd: row.cwd });
        if (!collection.collecting) {
          // `held`, not a terminal status: the row was collected while collection was on and is only
          // being *deferred*. Marking it decided would silently discard something the user had
          // already agreed to keep, and would make turning collection back on unable to recover it.
          if (row.status !== 'held') atomicJson(file, { ...row, status: 'held', reason: 'collection-disabled', decidedBy: collection.decidedBy, heldAt: new Date().toISOString() });
          held += 1;
          continue;
        }
        // A checkpoint whose event is already recorded — an out-of-band recovery or a manual
        // repair — must be closed rather than retried forever: capture() refuses to append
        // its evidence a second time, so the row would otherwise stay pending for good and
        // keep the checkpoint health check red.
        if (known.has(row.id)) {
          atomicJson(file, { ...row, status: 'consumed', consumedAt: new Date().toISOString(), event_id: row.id, recovered: true });
          processed += 1;
          continue;
        }
        const admitted = admissionDecision({ source: 'hook', text: `${row.task ?? ''}\n${row.context ?? ''}`,
          explicit: row.admission?.reason === 'explicit-request', stateChange: row.admission?.reason === 'state-change',
          config, collectionContext: { host: row.host, workspace: row.workspace, cwd: row.cwd } });
        if (!admitted.admitted) {
          atomicJson(file, { ...row, status: 'skipped', reason: admitted.reason, admission: { score: admitted.score, reason: admitted.reason }, skippedAt: new Date(now).toISOString() });
          continue;
        }
        if (!row.capture) {
          const existingRoute = loadRoutes(config).find((route) => route.id === row.workspace);
          if (existingRoute) transport.verify(existingRoute.note);
          else {
            const route = ensureWorkspace(config, transport, row.cwd);
            row.workspace = route.id;
            atomicJson(file, row);
          }
          let topic = config.topics.find((t) => t.workspace === row.workspace && [t.title, ...(t.aliases ?? [])].some((alias) => row.task.toLowerCase().includes(alias.toLowerCase())));
          if (!topic) {
            const id = `${row.workspace}/task-context`;
            topic = config.topics.find((t) => t.id === id);
            if (!topic) topic = registerTopic(config, { id, workspace: row.workspace, title: `${row.workspace} 近期任务上下文`, alias: '近期任务' });
          }
          const id = row.turn === undefined ? `session-${row.session}` : `turn-${row.session}-${row.turn}`;
          const prior = loadEvents(config).filter((e) => e.topic === topic.id && e.contexts?.some((c) => c.id === id)).at(-1);
          row.capture = { event: { event_id: row.id, workspace: row.workspace, topic: topic.id, agent: row.host, occurred_at: row.at,
            contexts: [{ id, task: eventText(row.task, 160), text: eventText(row.context, 1100), certainty: 'reported', ttl_days: 30,
              ...(prior ? { supersedes: prior.event_id } : {}) }] },
          evidence_text: `原生 hook 自动检查点。来源：${row.host}，会话指纹 ${row.session}，时间 ${row.at}。只保存脱敏截断的用户要求及回复片段，不将回复提升为已验证事实。\n${utf8(redactSecrets(row.context), 1100)}` };
          atomicJson(file, row);
        }
        const result = capture(config, transport, row.capture.event, row.capture.evidence_text, { deferConsolidation: true, source: 'hook', explicit: false });
        if (result.status === 'skipped') {
          atomicJson(file, { ...row, status: 'skipped', reason: result.reason, skippedAt: new Date(now).toISOString() });
          continue;
        }
        atomicJson(file, { ...row, status: 'consumed', consumedAt: new Date().toISOString(), event_id: result.event_id });
        processed++;
      } catch (error) {
        const attempts = (row.attempts ?? 0) + 1;
        // Only classify transport failures that are explicitly known to be transient.  An arbitrary
        // Error must remain a review failure; otherwise a programming bug would be retried forever.
        const message = String(error?.message ?? '');
        const retryable = error?.retryable === true
          || ['EAGAIN', 'EBUSY', 'EINTR', 'EIO', 'ENOSPC', 'ETIMEDOUT', 'OBSIDIAN_CLI_FAILED'].includes(error?.code)
          || /Writer locked|CLI readback mismatch|^CLI offline$|transport (?:offline|unavailable)|temporarily unavailable/i.test(message);
        const safeMessage = /^(?:CLI offline|transport (?:offline|unavailable)|temporarily unavailable)$/i.test(message)
          ? message : (retryable ? 'Temporary storage failure' : 'Checkpoint requires inspection');
        atomicJson(file, { ...row, status: retryable && attempts < 6 ? row.status : 'needs_attention', attempts,
          nextAttemptAt: retryable && attempts < 6 ? new Date(now + 1000 * 2 ** (attempts - 1)).toISOString() : null,
          lastError: safeMessage, lastAttemptAt: new Date(now).toISOString() });
        errors.push({ id: row.id, error: safeMessage });
      }
    }
    if (processed && !deferConsolidation) consolidate(config, transport);
    return { processed, held, errors };
  });
}

/** Explicitly retry one quarantined checkpoint without changing its original payload. */
export function retryCheckpoint(config, transport, id, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^hook-[a-f0-9]{24}-\d+-[a-f0-9]{10}$/.test(id)) throw new Error('Invalid checkpoint id');
  const file = path.join(config.policyRoot, 'state/hook-queue', `${id}.json`);
  if (!fs.existsSync(file)) throw new Error('Checkpoint not found');
  const row = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (row.id !== id || row.status !== 'needs_attention') throw new Error('Only a needs_attention checkpoint can be explicitly retried');
  if ((row.attempts ?? 0) >= 6) throw new Error('Checkpoint retry limit reached; inspect the original payload before any further action');
  if (row.capture) {
    // Validate before touching queue state. Secret-bearing or otherwise malformed payloads stay
    // quarantined and visible until an authorized, evidence-preserving correction is made.
    prepareCapture(config, row.capture.event, row.capture.evidence_text);
  }
  return drainCheckpoints(config, transport, { ids: [id], limit: 1, now });
}

/** Repair only an explicitly selected false-consumed, unrecorded low-value payload. */
export function reconcileSkippedCheckpoint(config, id, { now = Date.now() } = {}) {
  if (typeof id !== 'string' || !/^hook-[a-f0-9]{24}-\d+-[a-f0-9]{10}$/.test(id)) throw new Error('Invalid checkpoint id');
  const file = path.join(config.policyRoot, 'state/hook-queue', `${id}.json`);
  return withLock(path.join(config.policyRoot, 'state'), () => {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (row.id !== id || row.event_id != null || loadEvents(config).some((event) => event.event_id === id))
      throw new Error('Reconciliation requires an empty event_id and no matching ledger event');
    if (row.status === 'skipped' && row.reconciliation === 'unrecorded-low-importance')
      return { status: 'skipped', reason: row.reason, changed: false };
    if (row.status !== 'consumed' || !row.capture) throw new Error('Only a false-consumed capture can be reconciled');
    prepareCapture(config, row.capture.event, row.capture.evidence_text);
    const admission = admitCapture(config, row.capture.event, row.capture.evidence_text, { source: 'hook', explicit: false });
    if (admission.admitted || admission.reason !== 'low-importance')
      throw new Error('Only a revalidated low-importance denial can be reconciled');
    atomicJson(file, { ...row, status: 'skipped', reason: admission.reason,
      reconciliation: 'unrecorded-low-importance', reconciledAt: new Date(now).toISOString() });
    return { status: 'skipped', reason: admission.reason, changed: true };
  });
}
