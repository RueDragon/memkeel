import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withLock, inspectLock } from '../lib/transport.mjs';

// Regression coverage for the writer lock.
//
// The lock is a create-exclusive file, so a killed holder leaves it behind. An earlier revision
// tried to recover by itself: when the recorded holder looked gone, it renamed the lock file
// aside. Reading the record and renaming the file are two steps, and the gap between them is not
// harmless. A contender can read a dead holder's record while a second contender creates a fresh,
// live lock at the same path, and the stale rename then moves *that* lock away - so a second
// writer enters while a live holder still believes it owns the lock. The unconditional `finally`
// unlink had the mirror-image flaw: it removed whichever lock sat at the path, not the one this
// call had acquired.
//
// This build never removes a lock it did not create, and the tests below assert that contract
// from both sides: an unverifiable or foreign lock is never stolen, and a release never deletes a
// lock that is not its own. `inspectLock` still reports a provably dead holder as stale, because a
// human needs that diagnosis - it is just no longer a licence to write over the lock.
function dir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function deadPid() {
  // A pid that cannot be running, so "provably gone" is a fact rather than a probability. It is above
  // every platform's pid ceiling - Linux caps pid_max at 2^22 - and the liveness check answers ESRCH for
  // it on Windows and on POSIX alike.
  //
  // The previous version reused the pid of a process that had just exited, which is only *usually*
  // dead: this suite runs its test files in parallel and each one spawns children, so that pid can be
  // handed to another test's process between the two lines. When that happened, the refusal correctly
  // reported a running holder and this test failed. It failed once in five full-suite runs and never in
  // isolation, which is exactly the shape of that race.
  return 2147483646;
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

function liveHolder(t) {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => { try { child.kill(); } catch {} });
  return child;
}

// The call is expected to fail closed; returning the error keeps the assertions about its message
// readable, and failing here is itself the signal that the lock was stolen.
function caught(fn) {
  try { fn(); }
  catch (error) { return error; }
  throw new Error('expected the call to fail closed, but it proceeded');
}

const lockFile = (root) => path.join(root, 'writer.lock');

test('a lock whose recorded holder is provably gone is never stolen, and the refusal says how to recover', (t) => {
  const root = dir(t);
  writeLock(root, { pid: deadPid(), host: os.hostname(), at: '2026-09-10T03:00:21.839Z' });
  const before = fs.readFileSync(lockFile(root), 'utf8');

  const error = caught(() => withLock(root, () => 'must-not-run'));

  assert.match(error.message, /locked/i);
  assert.match(error.message, /is not running/, 'the refusal must report the diagnosis a human needs');
  assert.match(error.message, /delete that file/, 'the refusal must name the recovery step, because recovery is manual');
  assert.equal(fs.readFileSync(lockFile(root), 'utf8'), before, 'the orphaned lock must be left exactly as it was found');
  assert.equal(fs.existsSync(path.join(root, 'orphan-locks.log')), false, 'no automatic reclaim means no reclaim audit trail');
});

test('an owner-less lock past the write grace is never stolen either', (t) => {
  const root = dir(t);
  writeLock(root, '', 60_000);

  const error = caught(() => withLock(root, () => 'must-not-run'));

  assert.match(error.message, /locked/i);
  assert.equal(fs.existsSync(lockFile(root)), true, 'an unreadable lock is unverifiable, not removable');
});

test('a lock held by a live process, a fresh owner-less lock, or another host is never stolen', (t) => {
  const root = dir(t);
  const child = liveHolder(t);

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
  assert.equal(inspectLock(root).holderAlive, null, 'another host\'s pid cannot be checked from here, so liveness is unknown, not dead');
  assert.equal(inspectLock(root).stale, null, 'a pid that cannot be checked must never be called a stale holder');
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
    // The token is what makes release provable: the file at the path must still be the one this
    // call wrote before it may be removed.
    assert.match(String(record.token), /^[0-9a-f]{32}$/);
    return 'ok';
  }), 'ok');
  assert.equal(fs.existsSync(lockFile(root)), false);
  assert.equal(fs.existsSync(path.join(root, 'orphan-locks.log')), false, 'a normal acquisition writes no reclaim trail');
});

test('a live lock that appears between the read and the decision is never moved aside', (t) => {
  const root = dir(t);
  const holder = liveHolder(t);
  writeLock(root, { pid: deadPid(), host: os.hostname(), at: '2026-09-10T03:00:21.839Z' });

  // Force the interleaving: the contender has just read the dead holder's record, and before it
  // acts on that read the path holds a live holder's lock. This is the window that made the old
  // reclaiming rename move a live lock away.
  const realReadFileSync = fs.readFileSync;
  let swapped = false;
  fs.readFileSync = function (target, ...rest) {
    const text = realReadFileSync.call(fs, target, ...rest);
    if (!swapped && String(target) === lockFile(root)) {
      swapped = true;
      writeLock(root, { pid: holder.pid, host: os.hostname(), at: new Date().toISOString() });
    }
    return text;
  };
  t.after(() => { fs.readFileSync = realReadFileSync; });

  let entered = false;
  const error = caught(() => { withLock(root, () => { entered = true; return 'must-not-run'; }); });

  assert.equal(swapped, true, 'the test must actually force the interleaving');
  assert.equal(entered, false, 'a second writer must not enter while a live holder owns the lock');
  assert.match(error.message, /locked/i);
  assert.match(error.message, /is running/, 'the refusal must report the live holder it can see now, not the dead record it read first');
  const survivor = JSON.parse(fs.readFileSync(lockFile(root), 'utf8'));
  assert.equal(survivor.pid, holder.pid, 'the live lock must survive the blocked attempt');
});

test('a lock that replaces this one before release is not deleted by the release', (t) => {
  const root = dir(t);
  const child = liveHolder(t);

  assert.equal(withLock(root, () => {
    // Before this call releases, the path holds someone else's lock: a human recovering by hand,
    // or a later acquisition after a manual delete. Releasing must not remove it.
    fs.unlinkSync(lockFile(root));
    writeLock(root, { pid: child.pid, host: os.hostname(), at: new Date().toISOString() });
    return 'ran';
  }), 'ran');

  assert.equal(fs.existsSync(lockFile(root)), true, 'a lock that appeared after ours must survive our release');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(root), 'utf8')).pid, child.pid, 'the replacement lock must be left intact');
});

test('a holder whose liveness cannot be determined is not reported as dead', (t) => {
  const root = dir(t);
  writeLock(root, { pid: 999_999, host: os.hostname(), at: new Date().toISOString() });

  const realKill = process.kill;
  process.kill = function () { const error = new Error('EINVAL: invalid argument'); error.code = 'EINVAL'; throw error; };
  let seen;
  let error;
  try {
    seen = inspectLock(root);
    error = caught(() => withLock(root, () => 'must-not-run'));
  } finally {
    process.kill = realKill;
  }

  assert.equal(seen.holderAlive, null, 'a liveness check that cannot answer must not be reported as dead');
  assert.equal(seen.stale, null, 'only a provably dead holder may be reported stale');
  assert.match(error.message, /undetermined/, 'the refusal must say the holder could not be checked');
  assert.equal(fs.existsSync(lockFile(root)), true, 'an unverifiable lock must not be removed');
});

test('an acquisition that cannot write its owner record does not leak the lock', (t) => {
  const root = dir(t);

  const realWriteFileSync = fs.writeFileSync;
  let injected = 0;
  fs.writeFileSync = function (target, ...rest) {
    // Only the owner record goes through a file descriptor in this path.
    if (typeof target === 'number' && injected === 0) {
      injected += 1;
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    }
    return realWriteFileSync.call(fs, target, ...rest);
  };
  t.after(() => { fs.writeFileSync = realWriteFileSync; });

  const error = caught(() => withLock(root, () => 'must-not-run'));

  assert.match(error.message, /ENOSPC/);
  assert.equal(fs.existsSync(lockFile(root)), false, 'a failed acquisition must not leave its lock behind');
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
  assert.equal(inspectLock(root).stale, null, 'a freshly half-written lock is not yet past the write grace');
  writeLock(root, 'not json at all', 60_000);
  assert.match(String(inspectLock(root).stale), /no readable owner record/);
});
