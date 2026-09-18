import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { MANAGED_END, MANAGED_START, escapeManagedMarkers } from './markers.mjs';

export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const READ_RETRY_DELAYS_MS = [150, 400];
// Obsidian's cache can trail a direct file write, so the vault view is confirmed with a
// short bounded retry: a lagging readback must never fail a write that is correct on disk.
const READBACK_DELAYS_MS = [150, 400, 1000];

function sleepSync(milliseconds) {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function outputSnippet(value) {
  const text = String(value ?? '').replaceAll('\r\n', '\n').trim();
  return text ? text.slice(0, 1200) : '<empty>';
}

function isTransientReadFailure(result) {
  const code = result.error?.code;
  if (['ETIMEDOUT', 'EAGAIN', 'EBUSY', 'EINTR'].includes(code)) return true;
  const text = `${result.error?.message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`;
  return result.signal != null || /busy|locked|timeout|timed out|temporar|try again|unavailable|read failed/i.test(text);
}

function cliFailure(command, result) {
  const details = [
    `status=${result.status ?? '<null>'}`,
    `signal=${result.signal ?? '<none>'}`,
    `spawn=${result.error?.message ?? '<none>'}`,
    `stderr=${outputSnippet(result.stderr)}`,
    `stdout=${outputSnippet(result.stdout)}`,
  ].join('; ');
  const error = new Error(`Obsidian ${command} failed: ${details}`);
  error.code = 'OBSIDIAN_CLI_FAILED';
  error.retryable = command === 'read' && isTransientReadFailure(result);
  return error;
}

// `inside` is called once per evidence source per event on every journal replay, and it used to resolve
// the root through `realpathSync` on every one of those calls. Measured at 1k events, the two realpath
// calls in this function accounted for 452 ms of a 502 ms validation pass — the path helper, not the
// parsing, was the single most expensive thing in reading the journal.
//
// A root's real path is a property of the configured directory, not of the call, so it is resolved once
// and remembered. Only successful resolutions are cached: a root that does not exist still throws every
// time, exactly as before, and the cursor below is deliberately not cached because whether a path
// exists yet is exactly what changes between calls.
const realRootCache = new Map();
function realRootPath(root) {
  const key = path.resolve(root);
  const hit = realRootCache.get(key);
  if (hit !== undefined) return hit;
  const real = fs.realpathSync(root);
  realRootCache.set(key, real);
  return real;
}

export function inside(root, relative) {
  if (!relative || path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error('Expected relative path');
  const resolved = path.resolve(root, relative.replaceAll('\\', '/'));
  const rel = path.relative(path.resolve(root), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes root');
  let cursor = resolved;
  while (!fs.existsSync(cursor)) cursor = path.dirname(cursor);
  const realRoot = realRootPath(root);
  const realRel = path.relative(realRoot, fs.realpathSync(cursor));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error('Symlink escapes root');
  return resolved;
}

/**
 * The permission bits of an existing regular file, or null when there is nothing to preserve.
 *
 * Replacing a file must not change who can read it. Host configuration can carry credentials, and
 * both the installation receipt and its backups hold the original bytes of that configuration, so a
 * rewrite that widened the mode would expose exactly what the restore chain exists to protect.
 */
export function existingMode(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() ? stat.mode & 0o777 : null;
  } catch { return null; }
}

/**
 * Where a write to this path should actually land.
 *
 * A symlink is resolved rather than written through: writing through it in place is a truncating write
 * (the window this module exists to close), and publishing at the link's path would replace the link
 * with a regular file and break a layout the user set up on purpose. Publishing at the resolved target
 * keeps the link and is still atomic. A link that cannot be resolved - broken, or pointing at a
 * directory - is refused instead of followed, because there is nothing safe to publish to.
 */
function resolveWritableTarget(file) {
  let link = false;
  try { link = fs.lstatSync(file).isSymbolicLink(); } catch { return file; }   // nothing there yet
  if (!link) return file;
  let real;
  try { real = fs.realpathSync(file); }
  catch (error) { throw new Error(`Refusing to write through a symlink that cannot be resolved: ${file} (${error.code ?? error.message})`); }
  if (fs.statSync(real).isDirectory()) throw new Error(`Refusing to write a file over a directory: ${file} -> ${real}`);
  return real;
}

/**
 * Publish a file's bytes all at once.
 *
 * The bytes go to a sibling temporary, are flushed, and are renamed over the target. A reader therefore
 * sees the old file or the new one and never a mixture: a process killed at any point cannot leave a
 * half-written note behind. That is what a direct write does - it truncates the target before the
 * replacement exists - and for a journal note it means the events already committed to that note are
 * gone, which is the failure this protocol exists to prevent.
 *
 * What is guaranteed, and what is not, because the difference matters:
 *
 *   - Against a process dying, including SIGKILL: the target is never partial, and the previous bytes
 *     survive untouched until the rename. Retrying is safe.
 *   - Against power loss: the temporary's own bytes are flushed with fsync before the name changes, so
 *     they are on the device. The *directory entry* is not flushed, and Windows has no way to flush one
 *     at all, so a power cut can lose the newest publish - it cannot make a file partial. Saying more
 *     than that would be describing rename as though it were an fsync.
 *
 * The temporary is named `<target>.<uuid>.tmp`. The note scanner matches `.md` only, so residue from a
 * kill can never be read as an event, and this function does not go looking for residue to delete: it
 * is a file a later run cannot prove it owns.
 */
export function publishFile(target, content, { encoding = 'utf8', modeFrom = target } = {}) {
  const mode = existingMode(modeFrom);
  const temp = `${target}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fd = fs.openSync(temp, 'wx', mode === null ? undefined : mode);
    fs.writeFileSync(fd, content, { encoding });
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // `mode` on creation is narrowed by umask, so it is set explicitly as well. Windows has no POSIX
    // mode, where chmod only toggles the read-only bit and failing to set one is not worth surfacing.
    if (mode !== null) { try { fs.chmodSync(temp, mode); } catch { /* no POSIX mode on this platform */ } }
    fs.renameSync(temp, target);
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    try { fs.rmSync(temp, { force: true }); } catch { /* nothing to clean up */ }
    throw error;
  }
  return target;
}

/**
 * Whether an already-resolved path is inside an already-resolved root.
 *
 * `inside` answers this for a relative path, and it deliberately re-checks the root's real path; this is
 * the same rule for a path that has already been resolved, which is what a followed symlink produces.
 * Kept here rather than duplicated so a write and a restore cannot disagree about what "inside" means.
 */
export function isInsidePath(candidate, root) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Publish a file inside a store, refusing anything that would leave it.
 *
 * `relative` is validated by `inside`, which rejects a relative path that escapes and a symlinked
 * directory that does; a symlink at the target path itself is then resolved, and the bytes are published
 * at what it points to - so the write stays atomic and the link survives. A link that resolves outside
 * the store is refused rather than followed, which is the one case `inside` cannot see on its own,
 * because it checks the path before the final component is followed.
 */
export function publishStoreFile(root, relative, content) {
  const target = inside(root, relative);
  const resolved = resolveWritableTarget(target);
  if (resolved !== target && !isInsidePath(resolved, realRootPath(root))) throw new Error(`Refusing to write outside the store through a symlink: ${relative}`);
  return publishFile(resolved, content);
}

/**
 * Whether `text` already ends with the exact block an append of `tail` would have published.
 *
 * A publish that completed but was never acknowledged - the process died between the rename and the
 * readback - must not append the same block again when the caller retries, and the caller always retries
 * the same event. The block carries its own identity (an event id, a marker), so an identical trailing
 * block is that same append rather than a second one.
 *
 * The comparison requires the blank-line separator the append writes, so a coincidental match inside the
 * body is not mistaken for a published append, and it normalises line endings for the comparison only -
 * a note written elsewhere with CRLF is still recognised, while the bytes actually written are untouched.
 *
 * The boundary: only the trailing block is recognised. If a *different* append lands after the crash and
 * before the retry, the retried block is no longer trailing and will be written again; a caller that needs
 * that case closed has to pass its own identity and a de-duplicating read, which this layer cannot invent.
 */
export function alreadyAppended(text, tail) {
  if (tail === '') return false;
  const normalize = (value) => value.replaceAll('\r\n', '\n');
  return normalize(text).trimEnd().endsWith(`\n\n${normalize(tail)}`);
}

/**
 * Write a text file, keeping the permissions of the file it replaces.
 *
 * `modeFrom` names the file whose mode should be kept, which is not always the file being written: the
 * publish writes a temporary and renames it over the target, and rename keeps the *source* file's mode,
 * so the temporary has to be created with the target's. A symlink is resolved and published at its
 * target, so the link survives and the write is still all-or-nothing.
 */
export function writeFilePreservingMode(file, content, { encoding = 'utf8', modeFrom = file } = {}) {
  return publishFile(resolveWritableTarget(file), content, { encoding, modeFrom });
}

export function atomicJson(file, value) {
  return publishFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Writer lock.
//
// The lock is a create-exclusive file, which the OS does not release when the holder dies, and
// Node exposes no flock()/LockFile equivalent. An earlier revision tried to recover by itself:
// when the recorded holder looked gone, it renamed the lock file aside. Reading that record and
// renaming that file are two steps, and the gap between them is not harmless. A contender can read
// a dead holder's record while a second contender creates a fresh, live lock at the same path, and
// the stale rename then moves *that* lock away - so a second writer enters while a live holder
// still believes it owns the lock, and that holder's own `finally` may then unlink a third one.
// Re-checking the file immediately before the rename only narrows that window; it does not close
// it, because the check and the rename are still not one operation.
//
// So this build never removes a lock it did not create. A blocked acquisition fails closed with
// the holder details, and `inspectLock` (what `doctor` uses) reports the same facts read-only. A
// human who has stopped every writer - including anything that would start one again - deletes the
// file and retries. Paying a manual step after a crash is the price of never letting two writers into
// the ledger, and the refusal below names the exact file to remove so that recovery is a decision,
// not a guess.
//
// What this lock is not: a guarantee against every writer. It is a file both sides agree to respect,
// so it excludes another run that takes it and does nothing about a process that rewrites the file
// without taking it - a person editing it, or another program. Nothing here can detect that, and the
// identity check below is not a compare-and-swap: it decides whether *this* call may remove the file
// it created, which is a different question from whether a concurrent take-over was safe.
const LOCK_WAIT_DELAYS_MS = [25, 50, 100, 200, 400, 800];
// An owner-less lock may simply be one whose owner record is still being written.
const LOCK_OWNER_WRITE_GRACE_MS = 5000;

function readLockOwner(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return undefined; }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { record = undefined; }
  const pid = Number(record?.pid);
  return {
    stat,
    record,
    pid: Number.isInteger(pid) && pid > 0 ? pid : undefined,
    host: record?.host,
    at: record?.at,
    token: typeof record?.token === 'string' ? record.token : undefined,
  };
}

// Only ESRCH proves a process is gone. EPERM means it exists and cannot be signalled (elevated,
// for example), and anything else - EINVAL for a pid this platform rejects, EACCES, EIO - says
// nothing about liveness at all. Treating "I could not tell" as "it is dead" is what let a live
// holder's lock be classified as an orphan in the first place, so unknown is its own answer.
function holderState(pid) {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

// Reported to a human and used by `doctor`. Non-null only for a holder that is provably gone or an
// owner-less lock past the write grace; it is a diagnosis, never a licence to remove the file.
function staleLockReason(owner) {
  if (!owner) return undefined;
  if (owner.host && owner.host !== os.hostname()) return undefined;   // another host: pid numbers are meaningless here
  if (owner.pid === undefined) return Date.now() - owner.stat.mtimeMs > LOCK_OWNER_WRITE_GRACE_MS ? 'no readable owner record' : undefined;
  if (owner.pid === process.pid) return undefined;                   // our own lock is never an orphan
  return holderState(owner.pid) === 'dead' ? `holder pid ${owner.pid} is not running` : undefined;
}

function describeHolder(owner) {
  const age = Math.round((Date.now() - owner.stat.mtimeMs) / 1000);
  let liveness;
  if (owner.host && owner.host !== os.hostname()) liveness = 'recorded on another host, so its pid cannot be checked here';
  else if (owner.pid === undefined) liveness = 'no pid in the owner record';
  else if (owner.pid === process.pid) liveness = 'held by this process';
  else {
    const state = holderState(owner.pid);
    liveness = state === 'alive' ? 'that process is running'
      : state === 'dead' ? 'that process is not running'
        : 'that process could not be checked, so liveness is undetermined';
  }
  return `Holder pid=${owner.pid ?? 'unknown'} host=${owner.host ?? 'unknown'} since=${owner.at ?? 'unknown'} (age ${age}s; ${liveness}).`;
}

function blockedMessage(file, owner) {
  const detail = owner ? describeHolder(owner) : 'The file could not be read as an owner record.';
  const reason = owner ? staleLockReason(owner) : undefined;
  const recovery = 'This lock is never removed automatically, because a stale record cannot be told apart from a live holder whose lock is being replaced right now. Stop every writer first - including anything that would start one again - then delete that file yourself and retry; "node memory.mjs doctor" reports the same facts without writing anything.';
  return `Writer locked: ${file}. ${detail}${reason ? ` Detected: ${reason}.` : ''} ${recovery}`;
}

// Release only the lock this call created. An unconditional `unlinkSync` in `finally` removes
// whichever lock happens to sit at the path, which is how a losing contender deleted a winner's
// lock. The handle identifies the file object this call created, and the recorded token identifies
// the record it wrote; either one is evidence that the path's current contents are this call's own.
// This decides what may be *removed*, and deliberately nothing more: it is not a compare-and-swap,
// and it does not make a take-over of a held lock safe - it only stops the release from deleting a
// file that has already been replaced.
function stillOurs(file, handle, token) {
  try {
    const held = fs.fstatSync(handle);
    const onDisk = fs.lstatSync(file);
    if (held.ino && onDisk.ino) return held.dev === onDisk.dev && held.ino === onDisk.ino;
  } catch { return false; }   // the file is gone or the handle is unusable: nothing of ours to remove
  // A filesystem that reports no inode number falls back to the record this call wrote.
  return readLockOwner(file)?.token === token;
}

function releaseLock(file, handle, token) {
  try {
    if (stillOurs(file, handle, token)) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
  } finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
  }
}

export function withLock(root, callback) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'writer.lock');
  const token = crypto.randomBytes(16).toString('hex');
  let owner;
  for (let attempt = 0; attempt <= LOCK_WAIT_DELAYS_MS.length; attempt += 1) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      owner = readLockOwner(file);
      if (owner?.pid === process.pid) throw new Error(`Writer locked: ${file} is already held by this process; nested acquisition is not supported.`);
      // Waiting is the only safe reaction to a lock this call did not create: it may be in use, and
      // it may be unverifiable, and neither is a reason to remove it.
      if (attempt === LOCK_WAIT_DELAYS_MS.length) break;
      sleepSync(LOCK_WAIT_DELAYS_MS[attempt]);
      continue;
    }
    try {
      // The owner record is written inside the same `try` as the callback: on its own, a failure
      // here would leave the lock file behind with no `finally` left to release it.
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), token }));
      return callback();
    } finally {
      releaseLock(file, handle, token);
    }
  }
  throw new Error(blockedMessage(file, owner));
}

// Read-only lock inspection for diagnostics. Never throws and never removes anything, so a health
// check can report a lock that is merely in use separately from one whose holder is gone: a lock
// left behind by a killed process is exactly the failure worth surfacing, and it is otherwise
// invisible because the owner record is written once and its age proves nothing.
//
// `holderAlive` is deliberately three-valued: `true`, `false` only when the OS says ESRCH, and
// `null` when this host cannot answer at all (a record from another host, no pid, or an error that
// is neither ESRCH nor EPERM). `stale` is non-null only for a provably dead holder or an owner-less
// lock past the write grace, and even then it is a report for a human rather than a reason to
// delete the file.
export function inspectLock(root) {
  const file = path.join(root, 'writer.lock');
  const owner = readLockOwner(file);
  if (!owner) return { present: false, file };
  const state = holderState(owner.pid);
  const checkable = owner.pid !== undefined && (!owner.host || owner.host === os.hostname());
  return {
    present: true,
    file,
    pid: owner.pid ?? null,
    host: owner.host ?? null,
    at: owner.at ?? null,
    ageSeconds: Math.round((Date.now() - owner.stat.mtimeMs) / 1000),
    holderAlive: checkable && state !== 'unknown' ? state === 'alive' : null,
    stale: staleLockReason(owner) ?? null,
  };
}

export class VaultTransport {
  constructor(config) { this.config = config; this.spawnSync = config.spawnSync ?? spawnSync; }
  // Read-only CLI access.
  //
  // Arguments travel as single-line key=value pairs on argv, and the CLI decodes the
  // two-character sequences backslash-n to a line feed and backslash-t to a tab on every
  // argument. It offers no way to escape a literal backslash before those letters:
  // measured 2026-09-10, sending backslash-backslash-t produced backslash + tab, and
  // backslash-backslash-n produced backslash + line feed, while backslash-r, double
  // backslash, backslash-quote and backslash-u were passed through untouched.
  //
  // Document content must therefore never travel through this method: a Windows path such
  // as .../remote-web-ui-tunnel/tunnel.ps1 would arrive as invalid JSON and break the
  // whole event journal. Writes go to disk directly and confirm the vault view by reading
  // back, so this path stays read-only.
  cli(command, args = {}) {
    const result = this.spawnSync(this.config.obsidianCli, [`vault=${this.config.vaultName}`, command,
      ...Object.entries(args).map(([key, value]) => `${key}=${String(value).replaceAll('\r\n', '\n').replaceAll('\n', '\\n')}`)],
    { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    const stdout = String(result.stdout ?? '');
    if (result.error || result.status !== 0 || stdout.trimStart().startsWith('Error:')) {
      throw cliFailure(command, result);
    }
    return stdout.replaceAll('\r\n', '\n').trim();
  }
  read(relative) {
    inside(this.config.vaultRoot, relative);
    let lastError;
    for (let attempt = 0; attempt <= READ_RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return this.cli('read', { path: relative });
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === READ_RETRY_DELAYS_MS.length) throw error;
        sleepSync(READ_RETRY_DELAYS_MS[attempt]);
      }
    }
    throw lastError;
  }
  verify(relative) {
    const disk = fs.readFileSync(inside(this.config.vaultRoot, relative), 'utf8').replaceAll('\r\n', '\n').trim();
    const cli = this.read(relative);
    if (disk !== cli) throw new Error(`CLI readback mismatch: ${relative}`);
    return cli;
  }
  // Byte-exact vault write, published all at once. Never routes content through cli(): the argument
  // protocol decodes backslash-t and backslash-n, which cannot be escaped (see the note on cli()).
  writeBytes(relative, content) {
    return publishStoreFile(this.config.vaultRoot, relative, content);
  }
  // Confirms the vault view, tolerating a brief Obsidian cache lag behind a direct write.
  verifyStable(relative) {
    for (let attempt = 0; ; attempt += 1) {
      try { return this.verify(relative); }
      catch (error) {
        if (attempt >= READBACK_DELAYS_MS.length) throw error;
        sleepSync(READBACK_DELAYS_MS[attempt]);
      }
    }
  }
  create(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    if (fs.existsSync(target)) throw new Error(`Refusing duplicate create: ${relative}`);
    // One byte-exact publish, then a readback check. The former paragraph chunking
    // (2800-byte flush, 3500-byte paragraph rejection) existed only because content
    // used to travel through the Obsidian CLI argument protocol; cli() is now used
    // for reads only (measured 2026-09-14), so those bounds were removed with the
    // event ceiling.
    this.writeBytes(relative, content.trim());
    // The bytes are published already, so a readback that disagrees is reported rather than acted on:
    // the publish cannot leave a partial note, and removing a complete note because a *view* of it is
    // stale would destroy the bytes this check exists to protect.
    if (this.verifyStable(relative) !== content.trim()) throw new Error(`Create content mismatch: ${relative}`);
  }
  append(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    const before = fs.readFileSync(target, 'utf8');
    const tail = content.trim();
    if (alreadyAppended(before, tail)) return;
    // The CLI's append added its own separator on top of the escaped leading newline, so a
    // blank line preceded every appended block; keep those bytes identical.
    const next = `${before}\n\n${tail}`;
    this.writeBytes(relative, next);
    // Disk is authoritative: the appended bytes must be exactly what was intended. There is no rollback
    // on a mismatch: the publish is atomic, so a mismatch means something else changed the file, and
    // writing the previous bytes back would overwrite whatever that was.
    if (fs.readFileSync(target, 'utf8') !== next) throw new Error(`Append bytes mismatch: ${relative}`);
    if (!this.verifyStable(relative).endsWith(tail)) throw new Error(`Append mismatch: ${relative}`);
  }
  replace(relative, expected, next) {
    const target = inside(this.config.vaultRoot, relative);
    const current = fs.readFileSync(target, 'utf8');
    if (current !== expected) throw new Error(`Concurrent edit detected: ${relative}`);
    if (current === next) { this.verify(relative); return false; }
    // The generated patch is the provenance of this replacement, so it is staged beside the note
    // backup rather than in the OS temp directory. Provenance in a temp directory is not durable,
    // and a temp directory that is never removed accumulates without bound.
    const backupDir = path.join(this.config.policyRoot, 'backups', 'replacements');
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const dir = path.join(backupDir, id);
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(path.join(dir, 'before'), current, 'utf8');
      fs.writeFileSync(path.join(dir, 'after'), next, 'utf8');
      const diff = spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-ext-diff', '--', 'before', 'after'],
        { cwd: dir, encoding: 'utf8', windowsHide: true });
      if (diff.status !== 1) throw new Error('Cannot generate exact replacement patch');
      const patch = diff.stdout.replace(/^diff --git a\/before b\/after$/m, 'diff --git a/target.md b/target.md')
        .replace(/^--- a\/before$/m, '--- a/target.md').replace(/^\+\+\+ b\/after$/m, '+++ b/target.md');
      fs.writeFileSync(path.join(dir, 'target.md'), current, 'utf8');
      fs.writeFileSync(path.join(dir, 'change.patch'), patch, 'utf8');
      for (const check of [true, false]) {
        const result = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--no-index', '--recount', ...(check ? ['--check'] : []), 'change.patch'],
          { cwd: dir, encoding: 'utf8', windowsHide: true });
        if (result.status !== 0) throw new Error(`Generated patch ${check ? 'preflight' : 'apply'} failed: ${result.stderr}`);
      }
      if (fs.readFileSync(path.join(dir, 'target.md'), 'utf8') !== next) throw new Error('Patched bytes mismatch');
      // Keep the pre-image before the target is touched, so a failed run can still be rolled back.
      fs.copyFileSync(target, path.join(backupDir, `${id}.md`));
      if (fs.readFileSync(target, 'utf8') !== current) throw new Error('Target changed after preflight');
      // The generated patch was applied to an exact byte copy; the verified result is published all at
      // once, so a process killed here leaves the note it was replacing exactly as it was.
      publishStoreFile(this.config.vaultRoot, relative, next);
      atomicJson(path.join(backupDir, `${id}.json`), { relative, before: sha(current), after: sha(next), patchDirectory: dir });
    } catch (error) {
      // A refused replacement must not leave a half-written provenance directory behind.
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
    this.verify(relative);
    return true;
  }
  managed(relative, header, body) {
    // Content can mention the markers by accident, and a marker inside the block forges a second
    // one, which makes the note unmanageable with no way back. Escape it before it goes in.
    const block = `${MANAGED_START}\n${escapeManagedMarkers(body).trim()}\n${MANAGED_END}`;
    const target = inside(this.config.vaultRoot, relative);
    if (!fs.existsSync(target)) { this.create(relative, `${escapeManagedMarkers(header).trim()}\n\n${block}\n`); return; }
    const old = fs.readFileSync(target, 'utf8');
    if (old.split(MANAGED_START).length !== 2 || old.split(MANAGED_END).length !== 2 || old.indexOf(MANAGED_END) < old.indexOf(MANAGED_START)) {
      throw new Error(`Expected exactly one managed block: ${relative}`);
    }
    this.replace(relative, old, old.slice(0, old.indexOf(MANAGED_START)) + block + old.slice(old.indexOf(MANAGED_END) + MANAGED_END.length));
  }
}
