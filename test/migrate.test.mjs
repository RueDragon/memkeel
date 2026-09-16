// Coverage for data migration (DATA-02).
//
// The acceptance criterion is the same one the backup round used, stated the other way round: after
// moving a store with events in it, the new home must read back the same events and answer the same
// query, while the old home is still exactly as it was. Most of this file exists because of the ways
// a migration can look successful without being one — a copy into itself, a copy that stopped early,
// a configuration that names the old store — so those faults are injected rather than assumed away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { executeMigration, planMigration } from '../lib/migrate.mjs';
import { sha256File } from '../lib/backup.mjs';
import { loadConfig, validateConfig } from '../lib/config.mjs';
import { loadEvents } from '../lib/core.mjs';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
const REPOSITORY_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-migrate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  const to = path.join(root, 'moved');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8', windowsHide: true });
  assert.equal(run('init', '--store', store).status, 0);
  return { root, home, store, to, run, config: loadConfig(home).config };
}

/** Every file under a directory as `relative/path -> sha256`, for proving nothing moved. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(dir, full).replaceAll('\\', '/');
      // A lock is runtime state: the migration takes one, and that is not a change to the store.
      if (relative.includes('writer.lock')) continue;
      if (entry.isDirectory()) walk(full);
      else out[relative] = sha256File(full);
    }
  };
  walk(dir);
  return out;
}

/** A store with a real event, recorded through the CLI so the whole write path is exercised. */
function withEvent(t) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.store, 'evidence.md'), '# Evidence\n\nA note the event can cite.\n');
  fs.mkdirSync(path.join(f.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state', 'captures.json'), '{"pending-capture":{"event":{"event_id":"x"}}}\n');
  // A file deep in the store, so the "interrupted copy" test has a store-side path it can block.
  fs.mkdirSync(path.join(f.store, 'digest', '2026'), { recursive: true });
  fs.writeFileSync(path.join(f.store, 'digest', '2026', 'x.md'), '# Digest\n');

  const project = path.join(f.root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const added = f.run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  const workspace = JSON.parse(added.stdout).id;
  const topic = `${workspace}/migration`;
  assert.equal(f.run('register', '--topic', topic, '--workspace', workspace, '--title', 'Migration drill').status, 0);

  fs.writeFileSync(path.join(f.root, 'event.json'), JSON.stringify({
    event_id: '20260916-dsh-migration-drill-01',
    workspace,
    topic,
    agent: 'dsh',
    occurred_at: '2026-09-16T00:00:00.000Z',
    evidence: ['evidence.md'],
    facts: [{ key: 'migration-drill', text: 'the moved store answers the same query' }],
    verification: ['recorded so the migration has something real to carry'],
  }, null, 2));
  const record = f.run('record', '--file', path.join(f.root, 'event.json'));
  assert.equal(record.status, 0, record.stderr);

  // A workspace alias, so the migration has something it must carry verbatim and must not rewrite.
  fs.writeFileSync(path.join(f.home, 'config.json'), JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')),
    workspaceAliases: { [workspace]: [project] },
  }, null, 2));

  // Re-read: the config loaded before `register` has no topic routes, and a moved store has to be
  // read back through a fresh load or the test would be asserting against a stale object.
  const config = loadConfig(f.home).config;
  const events = loadEvents(config);
  assert.equal(events.length, 1, 'the fixture must contain exactly one event');
  return { ...f, config, events, workspace, topic, project };
}

// ------------------------------------------------------------------ refusals

test('a destination that is missing is refused rather than guessed', () => {
  const base = { policyRoot: path.join(os.tmpdir(), 'x', 'home'), vaultRoot: path.join(os.tmpdir(), 'x', 'store') };
  const plan = planMigration(base, {});
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.issues.map((issue) => issue.kind), ['target']);
  assert.match(plan.issues[0].message, /--to DIR/);
});

test('a destination inside the source, or a source inside the destination, is refused', (t) => {
  const f = fixture(t);
  for (const [label, to] of [
    ['inside the home', path.join(f.home, 'moved')],
    ['the home itself', f.home],
    ['inside the store', path.join(f.store, 'nested', 'moved')],
    ['the store itself', f.store],
  ]) {
    const plan = planMigration(f.config, { to });
    assert.equal(plan.ok, false, `${label} must be refused`);
    assert.ok(plan.issues.some((issue) => issue.kind === 'overlap'), `${label} must be reported as an overlap`);
  }
  // The other direction: the destination is an ancestor of the store, so the copy would be
  // overwritten by — or overwrite — what it is reading.
  const plan = planMigration(f.config, { to: f.root });
  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.kind === 'overlap'), 'an ancestor destination must be refused');
});

test('a destination inside the checkout is refused', (t) => {
  const f = fixture(t);
  const plan = planMigration(f.config, { to: path.join(REPOSITORY_ROOT, 'tmp-migrate-should-never-exist') });
  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.kind === 'repository'), 'a store inside the checkout must be refused');
});

test('a destination that already holds something is refused', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.to, { recursive: true });
  fs.writeFileSync(path.join(f.to, 'someone-elses-file.txt'), 'do not overwrite me\n');
  const plan = planMigration(f.config, { to: f.to });
  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.kind === 'conflict'));
  // An empty directory that merely exists is fine: that is what `mkdir -p` leaves behind.
  const empty = path.join(f.root, 'empty-target');
  fs.mkdirSync(empty);
  assert.equal(planMigration(f.config, { to: empty }).ok, true);
});

test('a symlink cannot hide an overlap', (t) => {
  const f = fixture(t);
  const link = path.join(f.root, 'link-to-home');
  try { fs.symlinkSync(f.home, link, 'junction'); }
  catch { t.skip('this host does not permit creating links'); return; }
  // The link and the home are the same directory; a naive string comparison would call this a
  // legitimate move and then copy the home into itself.
  const plan = planMigration(f.config, { to: link });
  assert.equal(plan.ok, false);
  assert.ok(plan.issues.some((issue) => issue.kind === 'overlap'), 'a spelled-around overlap must still be refused');
});

test('an overlap is refused when the destination does not exist yet', (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, 'alias-to-home');
  try { fs.symlinkSync(f.home, alias, 'junction'); }
  catch { t.skip('this host does not permit creating links'); return; }
  // The destination is written through the alias and does not exist yet, while the source is the
  // real path. Resolving symlinks only where the path exists leaves these two spellings unequal, so
  // the overlap goes unnoticed and the copy lands inside the tree it is reading. This is not
  // hypothetical: /var is a symlink on macOS, so every destination under os.tmpdir() misses.
  const plan = planMigration(f.config, { to: path.join(alias, 'moved') });
  assert.equal(plan.ok, false, 'a not-yet-existing destination under a link must still be compared');
  assert.ok(plan.issues.some((issue) => issue.kind === 'overlap'));
});

test('an unusable plan is never executed', (t) => {
  const f = fixture(t);
  const plan = planMigration(f.config, { to: path.join(f.home, 'moved') });
  assert.equal(plan.ok, false);
  assert.throws(() => executeMigration(f.config, plan), /Refusing to migrate/);
  assert.equal(fs.existsSync(path.join(f.home, 'moved')), false, 'a refused plan must not create anything');
});

// ------------------------------------------------------------------ the copy

test('the plan reports what it would carry, and rewrites only the paths that move', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  assert.equal(plan.ok, true, JSON.stringify(plan.issues));
  assert.ok(plan.counts.files > 0);
  assert.ok(plan.counts.bytes > 0);
  assert.equal(plan.targetHome, path.join(f.to, 'home'));
  assert.equal(plan.targetStore, path.join(f.to, 'store'));
  // Evidence paths inside events are not configuration, so they are not in the change list.
  assert.deepEqual(plan.configChanges.map((row) => row.key), ['policyRoot', 'memoryRoot', 'vaultRoot']);
  assert.deepEqual(plan.aliases.map((row) => row.id), [f.workspace]);
  assert.deepEqual(plan.aliases[0].paths, f.config.workspaceAliases[f.workspace]);
});

test('a migration carries the store, repoints it, and leaves the source alone', (t) => {
  const f = withEvent(t);
  const beforeSource = snapshot(f.home);
  const beforeStore = snapshot(f.store);

  const plan = planMigration(f.config, { to: f.to });
  const result = executeMigration(f.config, plan, { version: '0.0.0-test' });
  assert.equal(result.switched, true);
  assert.equal(result.home, plan.targetHome);
  assert.equal(result.files, plan.counts.files, 'the run must deliver the number the plan promised');

  // The source is a live store that has not been touched, not a leftover to be cleaned up by us.
  assert.deepEqual(snapshot(f.home), beforeSource, 'the source home must be byte-identical');
  assert.deepEqual(snapshot(f.store), beforeStore, 'the source store must be byte-identical');
  assert.deepEqual(result.sourceRetained, { home: f.home, store: f.store });

  // The new home reads the new store, and it says where it came from.
  const migrated = loadConfig(result.home).config;
  assert.equal(path.resolve(migrated.vaultRoot), path.resolve(result.store));
  assert.equal(path.resolve(migrated.policyRoot), path.resolve(result.home));
  assert.equal(migrated.migration.from.home, plan.source.home);
  assert.equal(migrated.migration.memkeel, '0.0.0-test');
  assert.equal(validateConfig(JSON.parse(fs.readFileSync(path.join(result.home, 'config.json'), 'utf8'))).ok, true,
    'a migrated store must not carry a configuration the validator rejects');

  // Aliases travel verbatim: they are how a moved project directory keeps resolving to its workspace.
  assert.deepEqual(migrated.workspaceAliases, f.config.workspaceAliases);
});

test('every file the plan counted arrives, with the same bytes', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  executeMigration(f.config, plan);
  for (const relative of ['store/evidence.md', 'home/state/captures.json']) {
    const source = path.join(f.root, relative);
    const destination = path.join(f.to, relative);
    assert.equal(fs.existsSync(destination), true, `${relative} must have been carried`);
    assert.deepEqual(fs.readFileSync(destination), fs.readFileSync(source), `${relative} must be byte-identical`);
  }
  // The carried configuration is the *new* one, and the old one is where it always was.
  assert.match(fs.readFileSync(path.join(f.to, 'home', 'config.json'), 'utf8'), /"policyRoot"/);
  assert.notEqual(
    fs.readFileSync(path.join(f.to, 'home', 'config.json'), 'utf8'),
    fs.readFileSync(path.join(f.home, 'config.json'), 'utf8'),
    'the destination configuration must be the rewritten one',
  );
});

// ------------------------------------------------------------------ the invariant that matters

test('an interrupted copy leaves no configuration at the destination', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  assert.equal(plan.ok, true);

  // Make one of the carried store files impossible to write by occupying the directory it needs with
  // a file. The plan was computed against an empty destination; this is the state a human or a
  // second process can create in between, which is exactly the window the invariant has to survive.
  // Store entries are copied after every home entry, so this fails genuinely mid-copy.
  fs.mkdirSync(path.join(f.to, 'store'), { recursive: true });
  fs.writeFileSync(path.join(f.to, 'store', 'digest'), 'not a directory\n');

  assert.throws(() => executeMigration(f.config, plan), /EEXIST|ENOTDIR|not a directory/i);
  assert.equal(fs.existsSync(path.join(f.to, 'home', 'config.json')), false,
    'a destination with no configuration cannot be mistaken for a working home');
  // The home was carried before the copy stopped, so this is a partial copy rather than a refusal
  // that never started — the state a half-finished migration actually leaves behind.
  assert.ok(fs.existsSync(path.join(f.to, 'home', 'bootstrap.md')), 'the copy must have begun');
  assert.equal(fs.existsSync(path.join(f.home, 'config.json')), true, 'the source keeps its configuration');
  // The source is still the live store: the CLI reads it and finds nothing missing. (It exits
  // non-zero because the fixture deliberately carries a pending capture, so only its content is
  // asserted — a failed migration must not change that.)
  const read = JSON.parse(f.run('doctor').stdout);
  assert.deepEqual(read.missing, [], 'the source home is untouched and still complete');
});

test('a rerun over a half-written destination does not inherit its configuration', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  assert.equal(plan.ok, true);
  // A previous run that died between "copy" and "switch" under an older build could have left a
  // configuration naming the old store. Pointing a home at it would read the source store and look
  // like a successful migration, so the rerun must remove it rather than trust it.
  fs.mkdirSync(path.join(f.to, 'home'), { recursive: true });
  fs.writeFileSync(path.join(f.to, 'home', 'config.json'), JSON.stringify({ ...f.config, vaultRoot: f.store }));

  executeMigration(f.config, plan);
  const migrated = loadConfig(path.join(f.to, 'home')).config;
  assert.equal(path.resolve(migrated.vaultRoot), path.resolve(path.join(f.to, 'store')),
    'the surviving configuration must be the rewritten one');
});

// ------------------------------------------------------------------ acceptance

test('the migrated store answers exactly what the original answered', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  const result = executeMigration(f.config, plan);

  const before = loadEvents(f.config);
  const after = loadEvents(loadConfig(result.home).config);
  assert.deepEqual(after, before, 'events and facts must be identical after a migration');
  assert.equal(after.length, 1);

  // And the entry points a host would actually use agree: the CLI run against the new home answers
  // the same fact and finds nothing missing, which is the difference between "the files are there"
  // and "the store works".
  const recalled = spawnSync(process.execPath, [cli, 'recall', '--query', 'migration drill', '--home', result.home], { encoding: 'utf8', windowsHide: true });
  assert.equal(recalled.status, 0, recalled.stderr);
  assert.match(recalled.stdout, /migration-drill/,
    'the migrated home must serve the recorded event through the CLI');

  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--home', result.home], { encoding: 'utf8', windowsHide: true });
  const report = JSON.parse(doctor.stdout);
  assert.equal(path.resolve(report.effectiveHome.path), path.resolve(result.home),
    'doctor must resolve the home it was pointed at');
  assert.deepEqual(report.missing, [], 'a migrated home must not be missing any file it expects');
  // `doctor` exits non-zero here because the fixture deliberately carries a pending capture; that is
  // reported state, not a failed migration, so the assertions above are about its content.
});

test('evidence keeps the paths it was written with', (t) => {
  const f = withEvent(t);
  const plan = planMigration(f.config, { to: f.to });
  const result = executeMigration(f.config, plan);
  const after = loadEvents(loadConfig(result.home).config);
  // Rewriting recorded evidence would be rewriting the ledger. The event still cites `evidence.md`.
  assert.deepEqual(after[0].evidence, ['evidence.md']);
  assert.equal(after[0].event_id, '20260916-dsh-migration-drill-01');
});

// ------------------------------------------------------------------ the CLI surface

test('the CLI defaults to a rehearsal and only writes when told to', (t) => {
  const f = withEvent(t);
  const rehearsal = f.run('migrate', '--to', f.to);
  assert.equal(rehearsal.status, 0, rehearsal.stderr);
  const planned = JSON.parse(rehearsal.stdout);
  assert.equal(planned.dryRun, true);
  assert.equal(planned.ok, true);
  assert.equal(fs.existsSync(path.join(f.to, 'home', 'config.json')), false, 'a rehearsal must write nothing');

  const executed = f.run('migrate', '--to', f.to, '--execute');
  assert.equal(executed.status, 0, executed.stderr);
  const done = JSON.parse(executed.stdout);
  assert.equal(done.switched, true);
  assert.equal(done.dryRun, false);
  assert.ok(fs.existsSync(path.join(f.to, 'home', 'config.json')));
  // The tool tells the user the three things it will not do for them rather than doing them silently.
  assert.equal(done.next.length, 3);
  assert.match(done.next.join(' '), /setup --check/);
});

test('the CLI refuses a bad destination with a non-zero status and writes nothing', (t) => {
  const f = fixture(t);
  const refused = f.run('migrate', '--to', path.join(f.home, 'inside'));
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /overlap/);
  assert.equal(fs.existsSync(path.join(f.home, 'inside')), false);
});

test('migrating twice to the same place is refused rather than silently half-done', (t) => {
  const f = withEvent(t);
  assert.equal(f.run('migrate', '--to', f.to, '--execute').status, 0);
  const second = f.run('migrate', '--to', f.to);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr + second.stdout, /not empty/);
});
