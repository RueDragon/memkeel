// Backup, verification and restore (DATA-01).
//
// The store is plain Markdown, which makes a backup almost trivial — and that is exactly why the
// interesting part is not the copying. It is deciding what must be carried, proving afterwards that
// what was carried is intact, and refusing to write a restore somewhere it would do harm.
//
// Three rules shape this module:
//
//   1. What cannot be recomputed is data; what can be recomputed is a cache. The journal, the
//      evidence notes and the user's own decisions are data. The search index and the topic catalog
//      are rebuilt from the journal by `memkeel index` and `consolidate`, so carrying them would
//      only make the archive bigger.
//   2. When in doubt, a file is data. Carrying a rebuildable file costs bytes; dropping a
//      non-rebuildable one costs the data.
//   3. A restore never guesses. Every path in a manifest is checked before anything is written, and
//      an archive that fails a check is reported, never half-applied.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { withLock } from './transport.mjs';

export const BACKUP_FORMAT = 1;
export const MANIFEST = 'manifest.json';

// Files in the memory home that cannot be recreated from anything else.
const HOME_DATA_FILES = Object.freeze([
  'config.json',
  'bootstrap.md',
  'event-schema.md',
  'dsh-hooks.json',
  // The restore chain for every host file `setup` changed. Losing it means a host's original
  // configuration can never be put back.
  'state/setup-receipt.json',
  // The user's retention judgements.
  'state/retention.json',
  // Captures awaiting evidence, and the checkpoint queue: unpublished work, not derived state.
  'state/captures.json',
  'state/retired-memory-skill.json',
  // Which events have already been projected. Recomputed in principle, but restoring it avoids a
  // surprise re-projection, and it is small.
  'state/consumed.json',
]);
const HOME_DATA_DIRS = Object.freeze(['state/hook-queue']);

// Rebuilt from the journal on the next command, so they are deliberately not carried. These are
// reported as `notCarried` so the omission is visible and explainable.
const DERIVED = Object.freeze([
  'state/index.json',
  'state/legacy-catalog.json',
  'state/access-log.json',
  'state/last-bootstrap.json',
  'state/adapters.json',
  'state/setup.json',
]);

// Ephemeral operational state: locks and per-session hook bookkeeping. Never data, and never worth
// reporting as an omission - `state/writer.lock` in particular exists only because the backup itself
// is holding it while it walks the tree.
const RUNTIME_DIRS = Object.freeze(['state/hook-sessions', 'state/setup-lock']);
const RUNTIME_FILES = Object.freeze(['state/writer.lock']);

const toPosix = (value) => String(value).replaceAll('\\', '/');
const isInside = (candidate, root) => {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** How a path inside the memory home is treated: `data`, `derived`, `runtime` or `skip`. */
export function classifyHomePath(relative) {
  const rel = toPosix(relative).replace(/^\.\/+/, '');
  if (!rel) return 'skip';
  if (RUNTIME_FILES.includes(rel)) return 'runtime';
  if (RUNTIME_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return 'runtime';
  if (rel.endsWith('.tmp')) return 'runtime';
  if (DERIVED.includes(rel)) return 'derived';
  if (HOME_DATA_FILES.includes(rel)) return 'data';
  if (HOME_DATA_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return 'data';
  // Everything else in the memory home is the user's: the host backups `setup` wrote, the config
  // migration snapshots, and anything they added themselves.
  return 'data';
}

/** Everything under the store is data. There is no cache inside it: Markdown is the source. */
export function classifyStorePath() {
  return 'data';
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function walk(dir, base = dir) {
  const rows = [];
  if (!fs.existsSync(dir)) return rows;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    // A symlink is never followed: it would either duplicate its target or point outside the store,
    // and a backup that silently contains something else is worse than one that names it.
    if (entry.isSymbolicLink()) { rows.push({ full, relative: toPosix(path.relative(base, full)), symlink: true }); continue; }
    if (entry.isDirectory()) { rows.push(...walk(full, base)); continue; }
    rows.push({ full, relative: toPosix(path.relative(base, full)), symlink: false });
  }
  return rows;
}

/** Free bytes available to the volume holding `dir`, or null when the platform cannot say. */
export function freeBytes(dir) {
  try {
    const stat = fs.statfsSync(fs.existsSync(dir) ? dir : path.dirname(dir));
    return Number(stat.bsize) * Number(stat.bavail);
  } catch { return null; }
}

/** The entries a backup of this configuration would carry, with their hashes. */
export function collectEntries(config) {
  const entries = [];
  const skipped = [];
  for (const row of walk(config.policyRoot)) {
    if (row.symlink) { skipped.push({ path: `home/${row.relative}`, reason: 'symbolic link' }); continue; }
    const kind = classifyHomePath(row.relative);
    if (kind === 'runtime') continue;
    if (kind === 'skip' || kind === 'derived') { skipped.push({ path: `home/${row.relative}`, reason: kind === 'skip' ? 'runtime state' : 'rebuildable' }); continue; }
    entries.push({ source: row.full, path: `home/${row.relative}`, kind: 'data', bytes: fs.statSync(row.full).size, sha256: sha256File(row.full) });
  }
  for (const row of walk(config.vaultRoot)) {
    if (row.symlink) { skipped.push({ path: `store/${row.relative}`, reason: 'symbolic link' }); continue; }
    entries.push({ source: row.full, path: `store/${row.relative}`, kind: classifyStorePath(row.relative), bytes: fs.statSync(row.full).size, sha256: sha256File(row.full) });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, skipped };
}

/**
 * Write a backup into `out`.
 *
 * The whole snapshot is taken while holding the memory writer lock, so a capture or a consolidation
 * running in another process cannot land between two files of the same logical unit and produce an
 * archive that is internally inconsistent. Locking is the point: an unlocked copy of a live store is
 * a copy of a moment that never existed.
 */
export function createBackup(config, { out, version = '', now = new Date().toISOString() } = {}) {
  if (!out) throw new Error('A backup destination is required (--out DIR)');
  const target = path.resolve(out);
  // Refusing this is the difference between an archive and a copy of itself: a destination inside
  // the home or the store would be read back into its own next run, and a restore could overwrite
  // the only copy of the backup.
  for (const [label, root] of [['memory home', config.policyRoot], ['store', config.vaultRoot]]) {
    if (isInside(target, root)) throw new Error(`The backup destination must live outside the ${label} (${root}); choose a directory beside it instead of inside it`);
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`The backup destination is not empty: ${target}`);

  return withLock(path.join(config.policyRoot, 'state'), () => {
    const { entries, skipped } = collectEntries(config);
    fs.mkdirSync(target, { recursive: true });
    // A backup holds the journal and may hold host configuration, so it is private by default.
    try { fs.chmodSync(target, 0o700); } catch { /* Windows has no POSIX mode */ }
    for (const entry of entries) {
      const destination = path.join(target, entry.path.replaceAll('/', path.sep));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(entry.source, destination);
      const copied = sha256File(destination);
      if (copied !== entry.sha256) throw new Error(`Readback mismatch while copying ${entry.path}; the backup is incomplete and must not be trusted`);
    }
    const manifest = {
      format: BACKUP_FORMAT,
      createdAt: now,
      source: { memkeel: version, node: process.versions.node, platform: process.platform },
      home: { path: config.policyRoot, store: config.vaultRoot },
      counts: { files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) },
      files: entries.map(({ path: relative, kind, bytes, sha256 }) => ({ path: relative, kind, bytes, sha256 })),
      notCarried: skipped,
    };
    fs.writeFileSync(path.join(target, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return { dir: target, manifest, files: entries.length, bytes: manifest.counts.bytes, notCarried: skipped.length };
  });
}

export function readManifest(dir) {
  const file = path.join(path.resolve(dir), MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`No ${MANIFEST} in ${path.resolve(dir)}; this is not a memkeel backup`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.files)) throw new Error(`${file} has no file list; it cannot be verified or restored`);
  return raw;
}

/**
 * Recompute every hash and compare. Reports mismatches, missing files and extra files rather than
 * stopping at the first problem, because "which parts of my archive are still good" is the question
 * a user actually has.
 */
export function verifyBackup(dir) {
  const root = path.resolve(dir);
  const manifest = readManifest(root);
  const problems = [];
  if (manifest.format !== BACKUP_FORMAT) {
    problems.push({ kind: 'format', message: `the archive is format ${manifest.format}, this build reads format ${BACKUP_FORMAT}` });
  }
  const listed = new Set();
  const issues = { corrupted: [], missing: [], extra: [] };
  for (const row of manifest.files) {
    listed.add(toPosix(row.path));
    const file = path.join(root, row.path.replaceAll('/', path.sep));
    if (!fs.existsSync(file)) { issues.missing.push(row.path); continue; }
    const actual = sha256File(file);
    if (actual !== row.sha256) issues.corrupted.push({ path: row.path, expected: row.sha256, actual });
  }
  for (const row of walk(root)) {
    const relative = row.relative;
    if (relative === MANIFEST || listed.has(relative)) continue;
    issues.extra.push(relative);
  }
  problems.push(...issues.corrupted.map((row) => ({ kind: 'corrupted', message: `${row.path} does not match its recorded checksum` })));
  problems.push(...issues.missing.map((row) => ({ kind: 'missing', message: `${row} is listed but absent` })));
  problems.push(...issues.extra.map((row) => ({ kind: 'extra', message: `${row} is present but not listed` })));
  return {
    ok: problems.length === 0,
    dir: root,
    format: manifest.format,
    createdAt: manifest.createdAt ?? null,
    source: manifest.source ?? null,
    counts: manifest.counts ?? { files: manifest.files.length, bytes: manifest.files.reduce((sum, row) => sum + (row.bytes ?? 0), 0) },
    issues,
    problems,
  };
}

/** Every reason a restore into `into` would be unsafe or impossible, checked before anything is written. */
export function reviewRestore(manifest, { into, free = null } = {}) {
  const issues = [];
  if (!into) issues.push({ kind: 'target', message: 'A restore destination is required (--into DIR)' });
  if (manifest.format !== BACKUP_FORMAT) {
    issues.push({ kind: 'format', message: `the archive is format ${manifest.format}, this build writes format ${BACKUP_FORMAT}` });
  }
  const target = into ? path.resolve(into) : '';
  if (target) {
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      // Overwriting is never the default: a restore into a populated directory needs a deliberate
      // decision from the user, and the plan's own default is to restore into a new directory.
      issues.push({ kind: 'conflict', message: `the destination already exists and is not empty: ${target}` });
    }
    if (!fs.existsSync(path.dirname(target))) issues.push({ kind: 'parent', message: `the destination's parent does not exist: ${path.dirname(target)}` });
  }
  for (const row of manifest.files) {
    const relative = toPosix(row.path);
    // A manifest is data, so it is not trusted: an entry naming an absolute path or climbing out of
    // the destination would turn "restore a backup" into "write anywhere on this machine".
    if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) issues.push({ kind: 'traversal', message: `${row.path} is an absolute path` });
    else if (relative.split('/').includes('..')) issues.push({ kind: 'traversal', message: `${row.path} climbs out of the destination` });
    if (relative !== 'home/config.json' && !relative.startsWith('home/') && !relative.startsWith('store/')) {
      issues.push({ kind: 'layout', message: `${row.path} is outside the expected home/ and store/ layout` });
    }
  }
  const required = (manifest.files ?? []).reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  if (free !== null && free < required) {
    issues.push({ kind: 'space', message: `the destination has ${free} bytes free but the archive needs ${required}` });
  }
  return { ok: issues.length === 0, into: target, required, free, issues };
}

/**
 * Copy an archive into a new directory and repoint its configuration at the new location.
 *
 * The rewrite is not optional: a restored `config.json` still names the *old* home and store, so
 * without it the restore would produce a directory whose own configuration points back at the store
 * it was restored from - which looks like a successful restore and behaves like a broken one.
 */
export function restoreBackup(dir, { into, manifest = null } = {}) {
  const root = path.resolve(dir);
  const source = manifest ?? readManifest(root);
  const target = path.resolve(into);
  const homeDir = path.join(target, 'home');
  const storeDir = path.join(target, 'store');
  const written = [];
  for (const row of source.files) {
    const destination = path.join(target, row.path.replaceAll('/', path.sep));
    if (!isInside(destination, target)) throw new Error(`Refusing to write outside the destination: ${row.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, row.path.replaceAll('/', path.sep)), destination);
    if (sha256File(destination) !== row.sha256) throw new Error(`Restore readback mismatch for ${row.path}; the destination is not a valid restore`);
    written.push(row.path);
  }

  const configFile = path.join(homeDir, 'config.json');
  const rewritten = [];
  if (fs.existsSync(configFile)) {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const changes = [];
    const setIfDifferent = (key, value) => {
      if (config[key] !== undefined && path.resolve(config[key]) !== path.resolve(value)) { changes.push({ key, from: config[key], to: value }); config[key] = value; }
    };
    setIfDifferent('memoryRoot', storeDir);
    setIfDifferent('vaultRoot', storeDir);
    setIfDifferent('policyRoot', homeDir);
    if (changes.length) {
      fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
      rewritten.push(...changes);
    }
  }
  return { dir: target, home: homeDir, store: storeDir, files: written.length, configRewritten: rewritten };
}
