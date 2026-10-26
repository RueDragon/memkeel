import fs from 'node:fs';
import path from 'node:path';
import { prepareCapture, capture } from './lifecycle.mjs';
import { loadEvents, consolidate, consumptionStatus } from './core.mjs';
import { atomicJson, withLock, inside } from './transport.mjs';
import { createTransport } from './storage/index.mjs';
import { reserveCapture } from './capture-reservation.mjs';

const queueRoot = (config) => path.join(config.policyRoot, 'state/capture-queue');
const receiptFile = (config, id) => {
  if (!/^[\w-]{8,100}$/.test(id ?? '')) throw new Error('Unsafe receipt id');
  return path.join(queueRoot(config), id + '.json');
};
const receipt = (row) => ({ event_id: row.event_id, digest: row.digest, status: row.status,
  attempts: row.attempts, nextAttemptAt: row.nextAttemptAt ?? null, recorded: row.recorded ?? false,
  storage: row.storage, disk: row.disk ?? 'not_recorded', view: row.view ?? 'not_checked',
  ...(row.failure ? { failure: row.failure } : {}) });

// No event registration or vault IO on the foreground path. The queue itself is durable
// transport state, not an archive. The same id must always carry exactly the same payload.
export function submitCapture(config, rawInput, rawEvidenceText) {
  const prepared = prepareCapture(config, rawInput, rawEvidenceText);
  const file = receiptFile(config, prepared.input.event_id);
  return withLock(path.join(config.policyRoot, 'state'), () => {
    reserveCapture(config, prepared.input.event_id, prepared.digest);
    if (fs.existsSync(file)) {
      const old = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (old.digest !== prepared.digest) throw new Error('Capture id reused with different evidence or event');
      return { ...receipt(old), duplicate: true };
    }
    const planFile = path.join(config.policyRoot, 'state/captures.json');
    const old = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8'))[prepared.input.event_id] : null;
    if (old && old.digest !== prepared.digest) throw new Error('Capture id reused with different evidence or event');
    const row = { version: 1, event_id: prepared.input.event_id, ...prepared,
      status: 'queued', attempts: 0, queuedAt: new Date().toISOString(), storage: config.storage ?? (config.obsidianCli ? 'obsidian-cli' : 'filesystem') };
    atomicJson(file, row);
    return { ...receipt(row), duplicate: false };
  });
}

// This is deliberately read-only: querying receipts never starts a worker or repairs state.
export function captureStatus(config, id) {
  if (id) {
    const file = receiptFile(config, id);
    return fs.existsSync(file) ? receipt(JSON.parse(fs.readFileSync(file, 'utf8'))) : { event_id: id, status: 'unknown' };
  }
  const root = queueRoot(config);
  const receipts = []; const corrupt = [];
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!name.endsWith('.json')) continue;
    try { receipts.push(receipt(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))); }
    catch { corrupt.push(name); }
  }
  return { receipts, corrupt, pending: receipts.filter((row) => ['queued', 'recorded'].includes(row.status)).length,
    needs_attention: receipts.filter((row) => row.status === 'needs_attention').length };
}

export function retryCapture(config, id) {
  const file = receiptFile(config, id);
  return withLock(queueRoot(config), () => {
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prepareCapture(config, row.input, row.evidenceText).digest !== row.digest) throw new Error('Queue payload digest mismatch');
    if (row.status === 'ready') return receipt(row);
    const next = { ...row, status: row.recorded ? 'recorded' : 'queued', attempts: 0, nextAttemptAt: null, failure: undefined };
    atomicJson(file, next);
    return receipt(next);
  });
}

export function retryableFailure(error) {
  return error.retryable === true || ['EAGAIN', 'EBUSY', 'EINTR', 'EIO', 'EMFILE', 'ENFILE', 'ENOSPC', 'ETIMEDOUT', 'OBSIDIAN_CLI_FAILED'].includes(error.code)
    || /Writer locked|mutex.*(?:busy|timed out)|CLI readback mismatch/i.test(error.message);
}

// Persisted backoff survives hook-triggered process restarts. Diagnostics never retain raw
// exception text, which can include a CLI's sensitive stdout or an offending event body.
function failed(row, error, now, maxAttempts) {
  const attempts = row.attempts + 1;
  const retryable = retryableFailure(error);
  const waiting = retryable && attempts < maxAttempts;
  return { ...row, attempts, status: waiting ? (row.recorded ? 'recorded' : 'queued') : 'needs_attention',
    nextAttemptAt: waiting ? new Date(now + Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 8))).toISOString() : null,
    failure: { kind: retryable ? 'transient' : 'permanent', code: error.code ?? 'CAPTURE_FAILED', exhausted: retryable && !waiting } };
}

function diskState(config, row) {
  const event = loadEvents(config).find((entry) => entry.event_id === row.event_id);
  if (!event) {
    const file = path.join(config.policyRoot, 'state/captures.json');
    const plan = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8'))[row.event_id] : null;
    return { recorded: false, disk: plan?.path && fs.existsSync(inside(config.vaultRoot, plan.path)) ? 'evidence_file' : 'not_recorded' };
  }
  return { recorded: true, disk: 'recorded', evidence: event.evidence };
}

export function drainCaptures(config, transport = createTransport(config), { limit = 20, now = Date.now(), maxAttempts = 6, consolidateBatch = consolidate } = {}) {
  const root = queueRoot(config);
  if (!fs.existsSync(root)) return { processed: 0, errors: [], nextAttemptAt: null };
  return withLock(path.join(config.policyRoot, 'state/capture-consumer'), () => {
    const rows = []; const errors = [];
    for (const name of fs.readdirSync(root).filter((entry) => entry.endsWith('.json')).sort()) {
      const file = path.join(root, name);
      try {
        const row = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (['queued', 'recorded'].includes(row.status) && (!row.nextAttemptAt || Date.parse(row.nextAttemptAt) <= now)) rows.push({ file, row });
      } catch { errors.push({ receipt: name, kind: 'corrupt' }); }
    }
    const recorded = [];
    for (const entry of rows.slice(0, limit)) {
      let row = entry.row;
      try {
        // Revalidate recovered payloads; a modified queue is never promoted on trust.
        const prepared = prepareCapture(config, row.input, row.evidenceText);
        if (prepared.digest !== row.digest) throw new Error('Queue payload digest mismatch');
        const result = capture(config, transport, row.input, row.evidenceText, { deferConsolidation: true });
        row = { ...row, status: 'recorded', recorded: true, disk: 'recorded', view: config.storage === 'obsidian-cli' ? 'healthy' : 'not_required',
          evidence: result.evidence, nextAttemptAt: null, failure: undefined };
        atomicJson(entry.file, row);
        recorded.push({ ...entry, row });
      } catch (error) {
        try { row = { ...row, ...diskState(config, row) }; } catch { /* corrupt ledger remains a failure */ }
        if (config.storage === 'obsidian-cli') row.view = 'unhealthy';
        row = failed(row, error, now, maxAttempts);
        atomicJson(entry.file, row);
        errors.push({ event_id: row.event_id, ...row.failure });
      }
    }
    let consolidation;
    if (recorded.length) {
      try {
        consolidation = consolidateBatch(config, transport);
        // The consumed checkpoint is authoritative even after a prior projection crash.
        consumptionStatus(config, loadEvents(config));
        const consumed = JSON.parse(fs.readFileSync(path.join(config.policyRoot, 'state/consumed.json'), 'utf8'));
        for (const { file, row } of recorded) {
          if (!consumed.hashes[row.event_id]) throw new Error('Projection still pending');
          atomicJson(file, { ...row, status: 'ready', readyAt: new Date(now).toISOString() });
        }
      } catch (error) {
        for (const { file, row } of recorded) {
          const next = failed(row, error, now, maxAttempts);
          atomicJson(file, next);
          errors.push({ event_id: row.event_id, ...next.failure });
        }
      }
    }
    const status = captureStatus(config);
    const nextAttemptAt = status.receipts.filter((row) => ['queued', 'recorded'].includes(row.status) && row.nextAttemptAt)
      .map((row) => row.nextAttemptAt).sort()[0] ?? null;
    return { processed: recorded.length, errors, consolidation, nextAttemptAt, pending: status.pending };
  });
}
