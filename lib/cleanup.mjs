// Retention enforcement (PRIV-01, plan item 5).
//
// The plan asks for configurable retention — "how many backups, how long diagnostics" — and for a
// cleanup preview that lists its own scope. Configuration and preview existed already; this module is
// the part that actually removes something, which is why it is written as plan-then-execute rather
// than as a single "prune" call:
//
//   planCleanup()    enumerates concrete targets. Writes nothing.
//   executeCleanup() deletes exactly those targets, re-validating each one first.
//
// Four things are deliberately out of reach, and each is a way this feature could do real damage:
//
//   1. The ledger and the store. Retention never removes an event, a note or evidence; those are
//      immutable records, and "retention" is not a licence to rewrite history.
//   2. Archives the user created elsewhere. `backup create --out DIR` writes wherever the user said;
//      that directory is theirs, not this program's, and nothing here knows it exists.
//   3. `backups/replacements/` — the rollback store an in-flight atomic write depends on. It looks
//      like a backup by its path and is not one; pruning it would break a write that is still running.
//   4. Anything outside the memory home. Every target is re-derived from the home and re-checked, so
//      neither a stale plan nor a crafted one can point the deletion somewhere else.
import fs from 'node:fs';
import path from 'node:path';
import { normalizeCollection } from './privacy.mjs';
import { msg } from './messages.mjs';

export const CLEANUP_FORMAT = 1;

/** Directory names under `backups/` that are operational state, not retention subjects. */
export const CLEANUP_PROTECTED = Object.freeze(['replacements']);

/** The only two places retention may delete from, and only within these groups. Each value is a
 * message reference rather than a sentence, so the plan stays language-neutral and whoever prints it
 * renders it in their own locale. */
export const CLEANUP_GROUPS = Object.freeze({
  'setup-snapshots': msg('cli.cleanup.group.setupSnapshots'),
  'config-migrations': msg('cli.cleanup.group.configMigrations'),
  'session-state': msg('cli.cleanup.group.sessionState'),
  'bootstrap-diagnostics': msg('cli.cleanup.group.bootstrapDiagnostics'),
});

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Recursive size, so a reported "would free" number is a measurement rather than a guess. */
function measure(target) {
  let bytes = 0;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) return stat.size;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    bytes += entry.isDirectory() ? measure(full) : fs.lstatSync(full).size;
  }
  return bytes;
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return []; }
}

/**
 * What retention would remove, without removing anything.
 *
 * Every target carries the group it belongs to, its path relative to the memory home, its measured
 * size and the modified time the decision was based on, so the preview is checkable rather than
 * reassuring.
 */
export function planCleanup(config = {}, { now = new Date(), keepBackups, diagnosticsDays } = {}) {
  const retention = normalizeCollection(config.collection).retention;
  const keep = Number.isFinite(keepBackups) ? Math.max(0, Math.floor(keepBackups)) : retention.backups;
  const days = Number.isFinite(diagnosticsDays) ? Math.max(0, Math.floor(diagnosticsDays)) : retention.diagnosticsDays;
  const home = path.resolve(config.policyRoot ?? '.');
  const cutoff = now.getTime() - days * 86400000;
  const targets = [];
  const kept = [];
  const issues = [];
  const protectedSeen = [];

  const add = (group, absolute, reason, modifiedAt) => {
    if (!inside(absolute, home)) { issues.push({ group, path: absolute, message: msg('cli.cleanup.rejectedOutsideHome') }); return; }
    const relative = path.relative(home, absolute).replaceAll('\\', '/');
    let bytes = 0;
    try { bytes = measure(absolute); } catch (error) { issues.push({ group, path: relative, message: error.message }); return; }
    targets.push({ group, relative, reason, modifiedAt, bytes });
  };

  // --- setup snapshots: newest `keep` survive, the rest go.
  const backupsDir = path.join(home, 'backups');
  const snapshots = listDir(backupsDir)
    .filter((entry) => entry.isDirectory() && /^setup-\d+$/.test(entry.name))
    .map((entry) => {
      const full = path.join(backupsDir, entry.name);
      return { name: entry.name, full, at: fs.statSync(full).mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
  for (const row of snapshots) {
    if (kept.filter((entry) => entry.group === 'setup-snapshots').length < keep) kept.push({ group: 'setup-snapshots', relative: `backups/${row.name}`, modifiedAt: row.at });
    else add('setup-snapshots', row.full, msg('cli.cleanup.keepSetupSnapshots', { keep }), row.at);
  }

  // --- config migration backups: same count, applied to files rather than directories.
  const migrationsDir = path.join(backupsDir, 'config-migrations');
  const migrations = listDir(migrationsDir)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => {
      const full = path.join(migrationsDir, entry.name);
      return { name: entry.name, full, at: fs.statSync(full).mtime.toISOString() };
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
  for (const row of migrations) {
    if (kept.filter((entry) => entry.group === 'config-migrations').length < keep) kept.push({ group: 'config-migrations', relative: `backups/config-migrations/${row.name}`, modifiedAt: row.at });
    else add('config-migrations', row.full, msg('cli.cleanup.keepConfigMigrations', { keep }), row.at);
  }

  // --- operational directories are reported as protected rather than silently skipped: a reader
  // should be able to see that they were considered and deliberately left alone.
  for (const entry of listDir(backupsDir)) {
    if (CLEANUP_PROTECTED.includes(entry.name)) protectedSeen.push(`backups/${entry.name}`);
  }

  // --- old hook session state. This is runtime state (excluded from backup and migration), it grows
  // one directory per session, and it is where the collected prompt text used to live.
  const sessionsDir = path.join(home, 'state', 'hook-sessions');
  for (const entry of listDir(sessionsDir)) {
    if (!entry.isDirectory()) continue;
    const full = path.join(sessionsDir, entry.name);
    const stamp = fs.statSync(full).mtime;
    const at = stamp.toISOString();
    if (stamp.getTime() >= cutoff) { kept.push({ group: 'session-state', relative: `state/hook-sessions/${entry.name}`, modifiedAt: at }); continue; }
    add('session-state', full, msg('cli.cleanup.sessionStale', { days }), at);
  }

  // --- bootstrap diagnostics.
  const bootstrapFile = path.join(home, 'state', 'last-bootstrap.json');
  if (fs.existsSync(bootstrapFile)) {
    const at = fs.statSync(bootstrapFile).mtime.toISOString();
    if (fs.statSync(bootstrapFile).mtime.getTime() < cutoff) add('bootstrap-diagnostics', bootstrapFile, msg('cli.cleanup.diagnosticsStale', { days }), at);
    else kept.push({ group: 'bootstrap-diagnostics', relative: 'state/last-bootstrap.json', modifiedAt: at });
  }

  const bytes = targets.reduce((sum, row) => sum + row.bytes, 0);
  return {
    format: CLEANUP_FORMAT,
    at: now.toISOString(),
    dryRun: true,
    executed: false,
    policy: { backups: keep, diagnosticsDays: days, contextDays: retention.contextDays },
    home,
    targets,
    kept,
    bytes,
    protected: protectedSeen,
    groups: CLEANUP_GROUPS,
    issues,
    notCovered: [
      msg('cli.cleanup.notCovered.ledger'),
      msg('cli.cleanup.notCovered.ownArchives'),
      msg('cli.cleanup.notCovered.replacements', { protected: CLEANUP_PROTECTED.join(', backups/') }),
      msg('cli.cleanup.notCovered.copied'),
      msg('cli.cleanup.notCovered.hostSessions'),
      msg('cli.cleanup.notCovered.dormant'),
    ],
    note: msg('cli.cleanup.planNote'),
  };
}

/**
 * Delete exactly what the plan listed.
 *
 * Each target is re-derived from the memory home and re-checked against the allowed groups before
 * anything is removed. A plan is data — it may be stale, or hand-edited — so verification happens
 * here rather than being assumed from the fact that `planCleanup` produced it.
 */
export function executeCleanup(config = {}, plan = {}) {
  if (!plan?.format || !Array.isArray(plan.targets)) throw new Error('A cleanup plan is required (build one with planCleanup)');
  const home = path.resolve(config.policyRoot ?? '.');
  const allowed = new Set(Object.keys(CLEANUP_GROUPS));
  const removed = [];
  const errors = [];
  let bytes = 0;

  for (const row of plan.targets) {
    if (!allowed.has(row.group)) { errors.push({ relative: row.relative, message: msg('cli.cleanup.unknownGroup', { group: row.group }) }); continue; }
    // Rebuild the path from the home: never trust an absolute path handed in by a plan.
    const absolute = path.resolve(home, String(row.relative));
    if (!inside(absolute, home)) { errors.push({ relative: row.relative, message: msg('cli.cleanup.outsideHome') }); continue; }
    if (CLEANUP_PROTECTED.some((name) => path.relative(home, absolute).replaceAll('\\', '/').startsWith(`backups/${name}`))) {
      errors.push({ relative: row.relative, message: msg('cli.cleanup.protectedRollback') });
      continue;
    }
    try {
      const size = measure(absolute);
      fs.rmSync(absolute, { recursive: true, force: true });
      removed.push({ group: row.group, relative: row.relative, bytes: size });
      bytes += size;
    } catch (error) {
      errors.push({ relative: row.relative, message: error.message });
    }
  }
  return { format: CLEANUP_FORMAT, dryRun: false, executed: true, removed, bytes, errors };
}
