import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { withLock, inspectLock } from '../lib/transport.mjs';

// Regression coverage for orphaned writer locks.
//
// A killed holder used to leave writer.lock behind forever, and because the
// owner record is written once at acquisition, lock age could not separate a
// live holder from a dead one. The error message even forbade the only recovery,
// so a single crash blocked every later write until a human intervened.
function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deadPid() {
  // Spawn a process that exits immediately, then reuse its pid: it is provably gone.
  return spawnSync(process.execPath, ['-e', '']).pid;
}

function writeLock(root, record, ageMs = 0) {
  const file = path.join(root, 'writer.lock');
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(file, when, when);
  }
  return file;
}

const lockFile = (root) => path.join(root, 'writer.lock');

test('an orphaned lock whose holder is gone is reclaimed instead of deadlocking', (t) => {
  const root = dir(t);
  writeLock(root, { pid: deadPid(), host: os.hostname(), at: '2026-09-10T03:00:21.839Z' });
  const result = withLock(root, () => 'callback-ran');
  assert.equal(result, 'callback-ran');
  assert.equal(fs.existsSync(lockFile(root)), false, 'lock must be released after the callback');
  const audit = fs.readFileSync(path.join(root, 'orphan-locks.log'), 'utf8');
  assert.match(audit, /is not running/, 'reclaim must be recorded for later inspection');
  assert.match(audit, /pid/);
});

test('a lock held by a live process, a fresh owner-less lock, or another host is never stolen', (t) => {
  const root = dir(t);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch {} });

  // 1. live foreign holder
  writeLock(root, { pid: child.pid, host: os.hostname(), at: new Date().toISOString() });
  assert.throws(() => withLock(root, () => 'must-not-run'), /locked/i);
  assert.equal(fs.existsSync(lockFile(root)), true, 'a live holder must keep its lock');
  // Diagnostics must classify a live foreign holder as in use, not as an orphan.
  const liveForeign = inspectLock(root);
  assert.equal(liveForeign.holderAlive, true, 'a live foreign holder must be reported alive');
  assert.equal(liveForeign.stale, null, 'a live foreign holder must never be reported stale');

  // 2. owner-less lock that is still young (holder may be between create and write)
  writeLock(root, '');
  assert.throws(() => withLock(root, () => 'must-not-run'), /locked/i);
  assert.equal(fs.existsSync(lockFile(root)), true, 'a fresh owner-less lock must not be reclaimed');

  // 3. record from a different host: pid numbers are not comparable there
  writeLock(root, { pid: deadPid(), host: 'some-other-host', at: new Date().toISOString() });
  assert.throws(() => withLock(root, () => 'must-not-run'), /locked/i);
  assert.equal(fs.existsSync(lockFile(root)), true, 'a foreign-host lock must never be reclaimed');
});

test('an owner-less lock older than the grace period is reclaimed', (t) => {
  const root = dir(t);
  writeLock(root, '', 60_000);
  assert.equal(withLock(root, () => 'reclaimed'), 'reclaimed');
  assert.equal(fs.existsSync(lockFile(root)), false);
});

test('re-entrant acquisition fails fast and leaves the held lock untouched', (t) => {
  const root = dir(t);
  withLock(root, () => {
    const started = Date.now();
    assert.throws(() => withLock(root, () => 'must-not-run'), /locked/i);
    assert.ok(Date.now() - started < 500, 'a re-entrant acquisition must not wait for a retry cycle');
    assert.equal(fs.existsSync(lockFile(root)), true, 'the outer holder still owns the lock');
  });
});

test('a normal acquisition records owner details and leaves no residue', (t) => {
  const root = dir(t);
  assert.equal(withLock(root, () => {
    const record = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
    assert.equal(record.pid, process.pid);
    assert.equal(record.host, os.hostname());
    assert.ok(record.at);
    return 'ok';
  }), 'ok');
  assert.equal(fs.existsSync(lockFile(root)), false);
  assert.equal(fs.existsSync(path.join(root, 'orphan-locks.log')), false, 'no reclaim means no audit entry');
});

test('inspectLock reports absence, use, and orphanhood without ever throwing', (t) => {
  const root = dir(t);
  assert.equal(inspectLock(root).present, false, 'an empty directory holds no lock');

  // Live holder: reported as in use, not stale.
  writeLock(root, { pid: process.pid, host: os.hostname(), at: new Date().toISOString() });
  const live = inspectLock(root);
  assert.equal(live.present, true);
  assert.equal(live.holderAlive, true);
  assert.equal(live.stale, null, 'a lock in use must not be reported stale');

  // Holder gone: the case a health check must surface.
  writeLock(root, { pid: deadPid(), host: os.hostname(), at: '2026-09-10T03:00:21.839Z' }, 7 * 3600 * 1000);
  const orphan = inspectLock(root);
  assert.equal(orphan.holderAlive, false);
  assert.match(String(orphan.stale), /not running/);
  assert.ok(orphan.ageSeconds > 3600);

  // Half-written or garbage record: tolerated, and only stale past the grace period.
  writeLock(root, '');
  assert.equal(inspectLock(root).stale, null, 'a freshly half-written lock is not yet reclaimable');
  writeLock(root, 'not json at all', 60_000);
  assert.match(String(inspectLock(root).stale), /no readable owner record/);
});
