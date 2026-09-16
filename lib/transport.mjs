import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

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
 * Write a text file, keeping the permissions of the file it replaces.
 *
 * `modeFrom` names the file whose mode should be kept, which is not always the file being written:
 * an atomic replace writes a temporary file and then renames it over the target, and rename keeps
 * the *source* file's mode, so the temporary has to be created with the target's.
 */
export function writeFilePreservingMode(file, content, { encoding = 'utf8', modeFrom = file } = {}) {
  const mode = existingMode(modeFrom);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding, ...(mode === null ? {} : { mode }) });
  // `mode` on write only applies to a file being created, and umask can still narrow it; setting it
  // explicitly is what actually reproduces the original. Windows has no POSIX mode, where chmod only
  // toggles the read-only bit and failing to set one is not an error worth surfacing.
  if (mode !== null) { try { fs.chmodSync(file, mode); } catch { /* no POSIX mode on this platform */ } }
  return file;
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  writeFilePreservingMode(temp, `${JSON.stringify(value, null, 2)}\n`, { modeFrom: file });
  fs.renameSync(temp, file);
}

// Orphaned lock recovery.
//
// The lock is a create-exclusive file, which the OS does not release when the
// holder dies. Releasing only from `finally` meant any kill, crash or torn-down
// parent left the file behind forever, and because the owner record is written
// once at acquisition, lock age can never separate a live holder from a dead one.
// Node exposes no flock()/LockFile equivalent, so recovery works by verifying the
// recorded holder instead: a lock is reclaimed only when that process is provably
// gone, and a holder that is still running is never stolen.
const LOCK_WAIT_DELAYS_MS = [25, 50, 100, 200, 400, 800];
const LOCK_ORPHAN_GRACE_MS = 5000;

function readLockOwner(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return undefined; }
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { record = undefined; }
  const pid = Number(record?.pid);
  return { stat, record, pid: Number.isInteger(pid) && pid > 0 ? pid : undefined, host: record?.host, at: record?.at };
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }   // exists but not inspectable (for example elevated)
}

function staleLockReason(owner) {
  if (!owner) return undefined;
  if (owner.host && owner.host !== os.hostname()) return undefined;   // another host: pid numbers are meaningless here
  if (owner.pid === undefined) return Date.now() - owner.stat.mtimeMs > LOCK_ORPHAN_GRACE_MS ? 'no readable owner record' : undefined;
  if (owner.pid === process.pid) return undefined;                   // re-entrant acquisition is never stale
  return processAlive(owner.pid) ? undefined : `holder pid ${owner.pid} is not running`;
}

function reclaimLock(file, reason, owner) {
  // rename is atomic, so only one contender can quarantine a given lock file
  const quarantine = `${file}.orphan.${process.pid}.${Date.now().toString(36)}`;
  try { fs.renameSync(file, quarantine); } catch { return false; }
  try { fs.unlinkSync(quarantine); } catch {}
  try {
    fs.appendFileSync(path.join(path.dirname(file), 'orphan-locks.log'),
      `${new Date().toISOString()}\t${reason}\towner=${JSON.stringify(owner?.record ?? null)}\n`);
  } catch {}
  return true;
}

export function withLock(root, callback) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'writer.lock');
  let owner;
  let reclaimed = false;
  for (let attempt = 0; attempt <= LOCK_WAIT_DELAYS_MS.length; attempt += 1) {
    let handle;
    try {
      handle = fs.openSync(file, 'wx');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      owner = readLockOwner(file);
      if (owner?.pid === process.pid) throw new Error(`Writer locked: ${file} is already held by this process; nested acquisition is not supported.`);
      const reason = owner ? staleLockReason(owner) : undefined;
      if (reason && !reclaimed && reclaimLock(file, reason, owner)) { reclaimed = true; continue; }
      if (attempt === LOCK_WAIT_DELAYS_MS.length) break;
      if (owner) sleepSync(LOCK_WAIT_DELAYS_MS[attempt]);
      continue;
    }
    fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }));
    try { return callback(); }
    finally { fs.closeSync(handle); try { fs.unlinkSync(file); } catch {} }
  }
  const age = owner ? Math.round((Date.now() - owner.stat.mtimeMs) / 1000) : 0;
  throw new Error(`Writer locked: ${file}. Live holder pid=${owner?.pid ?? 'unknown'} host=${owner?.host ?? 'unknown'} since=${owner?.at ?? 'unknown'} (age ${age}s). Do not steal a live or unverified stale lock.`);
}

// Read-only lock inspection for diagnostics. Never throws and never reclaims, so a health
// check can report a lock that is merely in use separately from one whose holder is gone:
// a lock left behind by a killed process is exactly the failure worth surfacing, and it is
// otherwise invisible because the owner record is written once and its age proves nothing.
export function inspectLock(root) {
  const file = path.join(root, 'writer.lock');
  const owner = readLockOwner(file);
  if (!owner) return { present: false, file };
  const reason = staleLockReason(owner);
  return {
    present: true,
    file,
    pid: owner.pid ?? null,
    host: owner.host ?? null,
    at: owner.at ?? null,
    ageSeconds: Math.round((Date.now() - owner.stat.mtimeMs) / 1000),
    holderAlive: owner.pid === undefined ? null : processAlive(owner.pid),
    stale: reason ?? null,
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
  // Byte-exact vault write. Never routes content through cli(): the argument protocol
  // decodes backslash-t and backslash-n, which cannot be escaped (see the note on cli()).
  writeBytes(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    return target;
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
    // One byte-exact write, then a readback check. The former paragraph chunking
    // (2800-byte flush, 3500-byte paragraph rejection) existed only because content
    // used to travel through the Obsidian CLI argument protocol; cli() is now used
    // for reads only (measured 2026-09-14), so those bounds were removed with the
    // event ceiling.
    try {
      this.writeBytes(relative, content.trim());
      if (this.verifyStable(relative) !== content.trim()) throw new Error(`Create content mismatch: ${relative}`);
    } catch (error) {
      // A rejected create must not leave a partial note behind.
      fs.rmSync(target, { force: true });
      throw error;
    }
  }
  append(relative, content) {
    const target = inside(this.config.vaultRoot, relative);
    const before = fs.readFileSync(target, 'utf8');
    // The CLI's append added its own separator on top of the escaped leading newline, so a
    // blank line preceded every appended block; keep those bytes identical.
    const next = `${before}\n\n${content.trim()}`;
    this.writeBytes(relative, next);
    try {
      // Disk is authoritative: the appended bytes must be exactly what was intended.
      if (fs.readFileSync(target, 'utf8') !== next) throw new Error(`Append bytes mismatch: ${relative}`);
      if (!this.verifyStable(relative).endsWith(content.trim())) throw new Error(`Append mismatch: ${relative}`);
    } catch (error) {
      // Roll back, because a corrupt append breaks loadEvents for the entire journal:
      // that is how one Windows path in a recovered event took the whole store offline.
      this.writeBytes(relative, before);
      throw error;
    }
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
      // The generated patch was applied to an exact byte copy; publish only the verified result.
      fs.copyFileSync(path.join(dir, 'target.md'), target);
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
    const start = '<!-- AUTO-MANAGED:START -->';
    const end = '<!-- AUTO-MANAGED:END -->';
    const block = `${start}\n${body.trim()}\n${end}`;
    const target = inside(this.config.vaultRoot, relative);
    if (!fs.existsSync(target)) { this.create(relative, `${header.trim()}\n\n${block}\n`); return; }
    const old = fs.readFileSync(target, 'utf8');
    if (old.split(start).length !== 2 || old.split(end).length !== 2 || old.indexOf(end) < old.indexOf(start)) {
      throw new Error(`Expected exactly one managed block: ${relative}`);
    }
    this.replace(relative, old, old.slice(0, old.indexOf(start)) + block + old.slice(old.indexOf(end) + end.length));
  }
}
