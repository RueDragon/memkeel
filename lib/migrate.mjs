// Data migration (DATA-02).
//
// A migration copies a memory home and its store to a new location and repoints the copy at itself.
// The copy is the easy half. The rest of this module exists because of four ways that goes wrong:
//
//   1. Nested paths. A destination inside the source (or the source inside the destination) turns a
//      copy into a loop, or into a copy that overwrites what it is reading.
//   2. Silent partial copies. A migration that reports success after copying some of the files is
//      worse than one that fails, because the user then deletes the original.
//   3. A switch that half-happened. The new configuration is written last, so an interrupted
//      migration leaves a directory that cannot be mistaken for a working home.
//   4. Losing the original. The source is never modified and never deleted; removing it is a
//      separate, deliberate action by a human.
//
// It reuses the archive's file classification, so "what has to be carried" has one answer rather
// than two that can drift apart.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectEntries, sha256File } from './backup.mjs';
import { validateConfig } from './config.mjs';
import { atomicJson, withLock } from './transport.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Canonical form of a path, whether or not it exists yet.
 *
 * Resolving symlinks only "where the path exists" is not enough, and the way it fails is quiet: a
 * source that exists gets its symlinks resolved while a destination that does not exist yet keeps
 * its literal spelling, so two names for the same place stop comparing equal and every overlap check
 * misses. On macOS that is not a corner case — `os.tmpdir()` sits behind `/var -> /private/var`, so
 * a migration destination under the temporary directory is spelled differently from its source and a
 * copy into itself is allowed. The nearest existing ancestor is therefore resolved through symlinks
 * and the not-yet-existing remainder is reattached.
 */
function realOrResolved(target) {
  const resolved = path.resolve(target);
  const suffix = [];
  let current = resolved;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    suffix.unshift(path.basename(current));
    current = parent;
  }
  let base;
  try { base = fs.realpathSync(current); } catch { base = current; }
  return suffix.length ? path.join(base, ...suffix) : base;
}
function overlaps(a, b) {
  const inside = (child, parent) => {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/**
 * What a migration would do, without doing any of it.
 *
 * Reports the source, the destination, the file and byte counts, the configuration keys that would
 * be rewritten, the workspace aliases in effect, and every reason the migration must not proceed.
 */
export function planMigration(config, { to } = {}) {
  const issues = [];
  const source = { home: realOrResolved(config.policyRoot), store: realOrResolved(config.vaultRoot) };
  const target = to ? path.resolve(String(to)) : '';
  const targetHome = target ? path.join(target, 'home') : '';
  const targetStore = target ? path.join(target, 'store') : '';

  if (!target) issues.push({ kind: 'target', message: 'A migration destination is required (--to DIR)' });

  if (target) {
    // A destination inside the source would be copied into itself; a source inside the destination
    // would be overwritten by the copy. Symlinks are resolved first so a link cannot hide either.
    for (const [label, root] of [['memory home', source.home], ['store', source.store]]) {
      if (overlaps(realOrResolved(target), root)) {
        issues.push({ kind: 'overlap', message: `the destination and the ${label} overlap; a migration must move data between separate trees (${root})` });
      }
    }
    const relToRepo = path.relative(REPOSITORY_ROOT, realOrResolved(target));
    if (relToRepo === '' || (!relToRepo.startsWith('..') && !path.isAbsolute(relToRepo))) {
      issues.push({ kind: 'repository', message: `the destination is inside the memkeel checkout (${REPOSITORY_ROOT}); a store must live outside it` });
    }
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      issues.push({ kind: 'conflict', message: `the destination already exists and is not empty: ${target}` });
    }
  }

  const { entries } = collectEntries(config, { includeDerived: true });
  const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);

  // The keys the switch would rewrite. Listed rather than assumed, because a migration that silently
  // repoints a store is indistinguishable from one that loses it.
  const aliases = Object.entries(config.workspaceAliases ?? {}).map(([id, paths]) => ({ id, paths }));
  const configChanges = target
    ? [
      { key: 'policyRoot', from: config.policyRoot, to: targetHome },
      { key: 'memoryRoot', from: config.memoryRoot ?? null, to: targetStore },
      { key: 'vaultRoot', from: config.vaultRoot, to: targetStore },
    ].filter((row) => row.from === null || path.resolve(String(row.from)) !== path.resolve(String(row.to)))
    : [];

  return {
    ok: issues.length === 0,
    source,
    target,
    targetHome,
    targetStore,
    counts: { files: entries.length, bytes },
    // Reported, never rewritten: an alias is how a moved project directory keeps resolving to the
    // same workspace, and the evidence that recorded the old path stays as it was written.
    aliases,
    configChanges,
    issues,
  };
}

/**
 * Carry out a plan.
 *
 * Copies are verified against the hash of what was read, and the new configuration is written last:
 * if anything fails, the destination has no `config.json` and therefore cannot be picked up as a
 * working home by accident, while the source is untouched and still the live store. That invariant is
 * only real because `config.json` is excluded from the copy loop rather than copied and rewritten.
 */
export function executeMigration(config, plan, { version = '', now = new Date().toISOString() } = {}) {
  if (!plan?.ok) throw new Error(`Refusing to migrate: ${(plan?.issues ?? []).map((issue) => issue.message).join('；')}`);
  const target = plan.target;
  const { entries } = collectEntries(config, { includeDerived: true });

  // Read the source configuration before anything is copied. `config.json` is deliberately NOT part
  // of the copy loop: it is the file that decides which store a home reads, so the only version of it
  // that may ever exist at the destination is the one written by the switch below. Copying it first
  // and rewriting it afterwards would leave, after any failure in between, a destination that looks
  // like a home and reads the *source* store — a migration that reports nothing and changes nothing.
  const sourceConfigFile = path.join(config.policyRoot, 'config.json');
  if (!fs.existsSync(sourceConfigFile)) {
    throw new Error(`Refusing to migrate: ${sourceConfigFile} does not exist, so there is no configuration to repoint`);
  }
  const before = JSON.parse(fs.readFileSync(sourceConfigFile, 'utf8'));
  // `collectEntries` names entries `home/<relative>` and `store/<relative>`, so the configuration is
  // `home/config.json` — filtering on a bare `config.json` would match nothing and quietly copy it.
  const CONFIG_ENTRY = 'home/config.json';
  const carried = entries.filter((entry) => entry.path !== CONFIG_ENTRY);
  if (entries.length - carried.length !== 1) {
    throw new Error(`Refusing to migrate: expected exactly one ${CONFIG_ENTRY} among the collected files`);
  }

  return withLock(path.join(config.policyRoot, 'state'), () => {
    fs.mkdirSync(plan.targetStore, { recursive: true });
    try { fs.chmodSync(target, 0o700); } catch { /* Windows has no POSIX mode */ }
    // Remove a config a previous interrupted run may have left, so the "written last" invariant holds
    // for this run too.
    const configFile = path.join(plan.targetHome, 'config.json');
    // Remove a config a previous interrupted run may have left, so the "written last" invariant holds
    // for this run too: an old configuration at the destination names the old store, and pointing a
    // home at it would read the source store while looking like a completed migration.
    fs.rmSync(configFile, { force: true });
    const copied = [];
    for (const entry of carried) {
      const destination = path.join(target, entry.path.replaceAll('/', path.sep));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(entry.source, destination);
      if (sha256File(destination) !== entry.sha256) {
        throw new Error(`Copy readback mismatch for ${entry.path}; the migration is incomplete and the source is unchanged`);
      }
      copied.push(entry.path);
    }

    // The switch. Rewriting the paths is not optional: a copy whose config still names the old store
    // reads the old store, which looks like a successful migration and behaves like a broken one.
    const next = { ...before };
    next.policyRoot = plan.targetHome;
    next.memoryRoot = plan.targetStore;
    next.vaultRoot = plan.targetStore;
    next.migration = { format: 1, at: now, memkeel: version, from: { home: plan.source.home, store: plan.source.store } };
    const report = validateConfig(next);
    if (!report.ok) {
      // Leave no usable config behind: a destination that cannot validate must not look switched.
      fs.rmSync(configFile, { force: true });
      throw new Error(`The migrated configuration does not validate, so nothing was switched: ${report.issues.map((issue) => issue.message).join('；')}`);
    }
    atomicJson(configFile, next);
    if (JSON.parse(fs.readFileSync(configFile, 'utf8')).vaultRoot !== plan.targetStore) {
      fs.rmSync(configFile, { force: true });
      throw new Error('The migrated configuration could not be read back; the source is unchanged and no switch was made');
    }

    return {
      target,
      home: plan.targetHome,
      store: plan.targetStore,
      // Stated so a caller can tell a rehearsal from a run without parsing prose, matching the
      // `dryRun: true, executed: false` the plan branch prints.
      dryRun: false,
      executed: true,
      // Counted to match `plan.counts.files`, which counts the configuration too: the number a user
      // was shown before the run has to be the number they can verify after it.
      files: copied.length + 1,
      bytes: plan.counts.bytes,
      switched: true,
      configChanges: plan.configChanges,
      aliases: plan.aliases,
      // Stated plainly, because the next step a user takes after a migration is usually "delete the
      // old one", and that is exactly the step this tool will not take for them.
      sourceRetained: { home: config.policyRoot, store: config.vaultRoot },
      next: [
        `Point MEMKEEL_HOME at ${plan.targetHome} (or pass --home) and run \`memkeel doctor\` to confirm it reads the migrated store.`,
        'Run `memkeel setup --check` to see whether the host bindings still point at the previous home, then `memkeel setup` to rebind them.',
        `Only after the new location is verified, remove the old home (${config.policyRoot}) yourself. Nothing here deletes it.`,
      ],
    };
  });
}
