import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { createTransport } from './storage/index.mjs';
import { drainCheckpoints } from './checkpoints.mjs';
import { captureStatus, drainCaptures, retryableFailure } from './capture-queue.mjs';
import { consumptionStatus, loadEvents, consolidate } from './core.mjs';
import { atomicJson, withLock } from './transport.mjs';
import { withQueueMutex } from './kernel-mutex.mjs';
export { withQueueMutex } from './kernel-mutex.mjs';

export function startCheckpointWorker(home) {
  const statusFile = path.join(home, 'state/checkpoint-worker.json');
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    if (['running', 'waiting'].includes(status.state)) { process.kill(status.pid, 0); return; }
  } catch { /* no live consumer; the kernel lock arbitrates concurrent starters */ }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--home', home], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

export function drainPendingProjection(config, transport, { now = Date.now(), maxAttempts = 6 } = {}) {
  const events = loadEvents(config);
  const consumption = consumptionStatus(config, events);
  const file = path.join(config.policyRoot, 'state/checkpoint-projection.json');
  if (!consumption.pending) {
    if (fs.existsSync(file)) atomicJson(file, { status: 'ready', attempts: 0, nextAttemptAt: null });
    return { pending: false, status: 'ready' };
  }
  // Capture receipts own their retry budget. A second consolidation here would
  // bypass their backoff or retry a permanent failure without explicit approval.
  if (captureStatus(config).receipts.some((row) => row.recorded && row.status !== 'ready')) {
    return { pending: false, status: 'deferred_to_captures' };
  }
  const consumedFile = path.join(config.policyRoot, 'state/consumed.json');
  const hashes = fs.existsSync(consumedFile) ? JSON.parse(fs.readFileSync(consumedFile, 'utf8')).hashes : {};
  const eventIds = events.filter((event) => !hashes[event.event_id]).map((event) => event.event_id);
  const prior = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const retry = prior.eventIds?.some((id) => !hashes[id]) ? prior : { attempts: 0 };
  if (retry.status === 'needs_attention') return { ...retry, pending: false };
  if (retry.nextAttemptAt && Date.parse(retry.nextAttemptAt) > now) return { ...retry, pending: true };
  try {
    consolidate(config, transport);
    const ready = { status: 'ready', attempts: 0, nextAttemptAt: null };
    atomicJson(file, ready);
    return { ...ready, pending: false };
  } catch (error) {
    const attempts = retry.attempts + 1;
    const retryable = retryableFailure(error);
    const waiting = retryable && attempts < maxAttempts;
    const next = { status: waiting ? 'waiting' : 'needs_attention', eventIds, attempts,
      nextAttemptAt: waiting ? new Date(now + Math.min(300000, 1000 * 2 ** Math.min(attempts - 1, 8))).toISOString() : null,
      failure: { kind: retryable ? 'transient' : 'permanent', code: error.code ?? 'PROJECTION_FAILED', exhausted: retryable && !waiting } };
    atomicJson(file, next);
    return { ...next, pending: waiting };
  }
}

export function runCheckpointWorker(home, { now = Date.now, sleep = (delay) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay),
  transportFactory = createTransport, maxAttempts = 6 } = {}) {
  const status = path.join(home, 'state/checkpoint-worker.json');
  return withLock(path.join(home, 'state/memory-worker'), () => {
      let processed = 0;
      for (;;) {
        // Configuration can change while a delayed item waits. Do not write through a
        // stale topic list or silently retain a previous storage selection.
        const { config } = loadConfig(home);
        const transport = transportFactory(config);
        const at = now();
        atomicJson(status, { state: 'running', pid: process.pid, at: new Date(at).toISOString(), processed });
        const checkpoints = drainCheckpoints(config, transport, { limit: 10, now: at, deferConsolidation: true });
        const captures = drainCaptures(config, transport, { limit: 20, now: at, maxAttempts });
        processed += checkpoints.processed + captures.processed;
        const projection = drainPendingProjection(config, transport, { now: at, maxAttempts });
        const receipts = captureStatus(config);
        const checkpointRoot = path.join(home, 'state/hook-queue');
        const rows = (fs.existsSync(checkpointRoot) ? fs.readdirSync(checkpointRoot) : [])
          .filter((name) => name.endsWith('.json')).flatMap((name) => {
            try { return [JSON.parse(fs.readFileSync(path.join(checkpointRoot, name), 'utf8'))]; } catch { return []; }
          });
        const waiting = rows.filter((row) => row.status === 'pending');
        const next = [...waiting.map((row) => row.nextAttemptAt ?? new Date(at).toISOString()),
          ...(captures.nextAttemptAt ? [captures.nextAttemptAt] : []), ...(projection.nextAttemptAt ? [projection.nextAttemptAt] : [])].sort()[0];
        if (!waiting.length && !receipts.pending && !projection.pending) {
          const attention = captures.errors.length || checkpoints.errors.length || receipts.needs_attention || receipts.corrupt.length
            || rows.some((row) => row.status === 'needs_attention') || projection.status === 'needs_attention';
          const result = { state: attention ? 'needs_attention' : 'idle',
            pid: process.pid, at: new Date(now()).toISOString(), processed, projection };
          atomicJson(status, result);
          return result;
        }
        const delay = next ? Math.max(50, Math.min(300000, Date.parse(next) - now())) : 50;
        atomicJson(status, { state: 'waiting', pid: process.pid, at: new Date(now()).toISOString(), processed, nextAttemptAt: next ?? null, projection });
        sleep(delay);
      }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[process.argv.indexOf('--home') + 1];
  const status = path.join(home, 'state/checkpoint-worker.json');
  try {
    runCheckpointWorker(home);
  } catch (error) {
    // Another live consumer is normal. Never clobber its health record.
    if (!/Writer locked/.test(error.message)) {
      atomicJson(status, { state: 'needs_attention', at: new Date().toISOString(), error: 'Background memory worker failed; inspect the store and receipts.' });
      process.exitCode = 1;
    }
  }
}
