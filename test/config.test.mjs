// Coverage for the shared config contract (CFG-01).
//
// Four entry points read the same `config.json`: the CLI, the MCP server, the hook runner and
// the web console. They used to repeat the same read-and-normalise line, so a default or a
// validation rule could drift between them. These tests pin the single contract they now share:
// one home precedence, one loader, one validator, and a migration plan that never rewrites the
// release version or invents a store root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_SCHEMA_VERSION, applyConfigMigration, effectiveConfigView, inspectConfigGroups, loadConfig,
  planConfigMigration, resolveHome, validateConfig,
} from '../lib/config.mjs';
import { settingsSnapshot } from '../lib/dashboard-data.mjs';
import { applyLayout } from '../lib/layout.mjs';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(store, { recursive: true });
  const write = (raw) => { fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(raw, null, 2)); };
  const complete = (extra = {}) => ({
    version: '1.0.0',
    configSchema: CONFIG_SCHEMA_VERSION,
    memoryRoot: store,
    vaultRoot: store,
    layout: 'neutral',
    storage: 'filesystem',
    activeLimit: 6,
    recentLimit: 6,
    recentDays: 14,
    budgetBytes: 14000,
    roles: { eventsRoot: 'events', topicsRoot: 'topics', projectRoot: 'projects', habitsNote: 'habits.md',
      actionsNote: 'actions.md', mistakesNote: 'mistakes.md', candidatesNote: 'candidates.md',
      experienceNote: 'experience.md', inboxRoot: 'digest' },
    ...extra,
  });
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_LOCALE: 'en' } });
  return { root, home, store, write, complete, run };
}

// ------------------------------------------------------------------ home precedence

test('home precedence is --home, then MEMKEEL_HOME, then the per-user default', () => {
  const env = { MEMKEEL_HOME: path.join(os.tmpdir(), 'from-env') };
  const explicit = resolveHome({ home: path.join(os.tmpdir(), 'from-flag'), env });
  assert.equal(explicit.home, path.resolve(path.join(os.tmpdir(), 'from-flag')));
  assert.match(explicit.source, /--home/);

  const fromEnv = resolveHome({ home: '', env });
  assert.equal(fromEnv.home, path.resolve(env.MEMKEEL_HOME));
  assert.equal(fromEnv.source, 'MEMKEEL_HOME');

  const fallback = resolveHome({ home: '', env: {}, homedir: path.join(os.tmpdir(), 'someone') });
  assert.equal(fallback.home, path.resolve(path.join(os.tmpdir(), 'someone', '.memkeel')));
  assert.match(fallback.source, /default/);
});

test('a blank or non-string --home never silently becomes a directory name', () => {
  const env = { MEMKEEL_HOME: path.join(os.tmpdir(), 'from-env') };
  // `--home` with no value arrives as `true` from the CLI parser; it must not win.
  assert.equal(resolveHome({ home: true, env }).home, path.resolve(env.MEMKEEL_HOME));
  assert.equal(resolveHome({ home: '   ', env }).home, path.resolve(env.MEMKEEL_HOME));
});

test('the CLI rejects --home with no value instead of falling back to another store', () => {
  const result = spawnSync(process.execPath, [cli, 'config', 'validate', '--home'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_LOCALE: 'en' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--home requires a directory/);
});

// ------------------------------------------------------------------ loading

test('loadConfig returns the applied layout and pins policyRoot to the home it read', (t) => {
  const { home, store, write, complete } = fixture(t);
  write(complete());
  const loaded = loadConfig(home);
  assert.equal(loaded.home, home);
  assert.equal(loaded.config.policyRoot, home);
  assert.equal(loaded.config.vaultRoot, store);
  assert.equal(loaded.config.role('eventsRoot'), 'events');
  // Same normalisation the core uses, so the loader cannot drift from the layout rules.
  assert.equal(loaded.config.roles.eventsRoot, applyLayout({ ...loaded.raw, policyRoot: home }).roles.eventsRoot);
});

test('a missing home fails with an actionable line, not a raw ENOENT', (t) => {
  const { root } = fixture(t);
  assert.throws(() => loadConfig(path.join(root, 'absent')), (error) => {
    assert.match(error.message, /No memory home at/);
    assert.match(error.message, /memkeel init/);
    assert.doesNotMatch(error.message, /ENOENT/);
    return true;
  });
});

// ------------------------------------------------------------------ validation

test('a complete document validates', (t) => {
  const { write, complete } = fixture(t);
  write(complete());
  const report = validateConfig(complete());
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.deepEqual(report.issues, []);
});

const INVALID = [
  ['an unknown layout', { layout: 'not-a-layout' }, /布局只能是/],
  ['an unknown storage backend', { storage: 'gcs' }, /存储后端只能是/],
  ['a relative store root', { memoryRoot: 'relative/store' }, /必须是绝对路径/],
  ['a store root inside this repository', { memoryRoot: path.resolve(fileURLToPath(new URL('..', import.meta.url))) }, /不能指向本项目仓库目录/],
  ['an out-of-range number', { activeLimit: 0 }, /activeLimit/],
  ['a non-integer number', { budgetBytes: 12.5 }, /budgetBytes/],
  ['obsidian-cli without a CLI path', { storage: 'obsidian-cli' }, /必须填写 obsidianCli/],
  ['an empty role', { roles: {} }, /不能为空/],
  ['a non-integer configSchema', { configSchema: 'one' }, /configSchema 必须是整数/],
  ['a configSchema newer than this build', { configSchema: CONFIG_SCHEMA_VERSION + 1 }, /请升级 memkeel/],
];

for (const [label, patch, expected] of INVALID) {
  test(`${label} is reported as an issue`, (t) => {
    const { complete } = fixture(t);
    const raw = complete(patch);
    const report = validateConfig(raw);
    assert.equal(report.ok, false, `${label} was accepted`);
    assert.ok(report.issues.some((issue) => expected.test(issue.message)), JSON.stringify(report.issues));
  });
}

test('memoryRoot and vaultRoot must agree, and the ambiguity is never resolved silently', (t) => {
  const { root, store, complete } = fixture(t);
  const report = validateConfig(complete({ memoryRoot: store, vaultRoot: path.join(root, 'elsewhere') }));
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.field === 'memoryRoot' && /指向不同目录/.test(issue.message)));
});

test('memoryRoot is the stated root and vaultRoot is derived from it', (t) => {
  const { store, complete } = fixture(t);
  const onlyMemory = complete();
  delete onlyMemory.vaultRoot;
  const derived = validateConfig(onlyMemory);
  assert.equal(derived.ok, true, JSON.stringify(derived.issues));
  assert.ok(derived.notes.some((note) => /vaultRoot 为空/.test(note)));

  // The other direction is a rejection, not a silent guess: note paths resolve against
  // vaultRoot, but the store root has to be stated, and migration is what offers to derive it.
  const onlyVault = complete();
  delete onlyVault.memoryRoot;
  const missing = validateConfig(onlyVault);
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.field === 'memoryRoot'));
  assert.equal(planConfigMigration(onlyVault).next.memoryRoot, store);
});

test('a missing configSchema is a note, not a rejection', (t) => {
  const { complete } = fixture(t);
  const raw = complete();
  delete raw.configSchema;
  const report = validateConfig(raw);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.ok(report.notes.some((note) => /缺少 configSchema/.test(note)));
});

test('an unknown top-level key is preserved and reported, never dropped', (t) => {
  const { complete } = fixture(t);
  const report = validateConfig(complete({ vaultroot: '/typo' }));
  assert.equal(report.ok, true);
  assert.ok(report.notes.some((note) => /未知字段 vaultroot/.test(note)));
});

test('a deprecated flat role key is still read, and reported', (t) => {
  const { complete } = fixture(t);
  const raw = complete({ habitsNote: 'legacy-habits.md' });
  delete raw.roles.habitsNote;
  const report = validateConfig(raw);
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.ok(report.notes.some((note) => /habitsNote 是旧写法/.test(note)));
  // Compatible reading is the point: the runtime resolves the old spelling.
  assert.equal(applyLayout(raw).roles.habitsNote, 'legacy-habits.md');
});

test('the settings editor is stricter than the runtime on purpose', (t) => {
  const { complete } = fixture(t);
  const raw = complete({ habitsNote: 'legacy-habits.md' });
  delete raw.roles.habitsNote;
  // The runtime and `config validate` accept the old spelling, because the store works...
  assert.equal(validateConfig(raw).ok, true);
  // ...while the editor, which writes the `roles` block, refuses to save an incomplete one
  // instead of quietly rewriting the user's file into a different shape.
  assert.ok(inspectConfigGroups(raw, { createRoots: false }).issues.some((issue) => issue.field === 'roles.habitsNote'));
});

test('validation never creates a directory, even for a store root that does not exist', (t) => {
  const { root, complete } = fixture(t);
  const ghost = path.join(root, 'not-created-by-validation');
  const report = validateConfig(complete({ memoryRoot: ghost, vaultRoot: ghost, layout: 'bad' }));
  assert.equal(report.ok, false);
  assert.equal(fs.existsSync(ghost), false, 'validation created the store root');
  assert.equal(fs.existsSync(path.join(root, 'not-created-by-validation')), false);
});

// ------------------------------------------------------------------ CLI and console agree

test('the CLI and the settings page reach the same verdict on the same file', (t) => {
  const { home, write, complete } = fixture(t);
  for (const raw of [complete(), complete({ layout: 'nope' }), complete({ activeLimit: 0 })]) {
    write(raw);
    const cliReport = JSON.parse(spawnSync(process.execPath, [cli, 'config', 'validate', '--home', home], { encoding: 'utf8', windowsHide: true }).stdout);
    // The console validates the file it is editing through the same function the CLI uses.
    const page = settingsSnapshot({ policyRoot: home, vaultRoot: raw.vaultRoot, roles: raw.roles, topics: [] }, { home: os.homedir(), env: {} });
    assert.equal(cliReport.ok, page.validation.ok, `CLI and console disagreed for ${JSON.stringify(raw.layout ?? '')}`);
    assert.equal(cliReport.ok, validateConfig(raw).ok);
    assert.deepEqual(cliReport.issues, inspectConfigGroups(raw, { createRoots: false }).issues);
  }
});

// ------------------------------------------------------------------ effective view

test('the effective view reports where each value came from', (t) => {
  const { complete } = fixture(t);
  const raw = complete({ habitsNote: 'legacy-habits.md' });
  delete raw.roles.habitsNote;
  const view = effectiveConfigView(raw);
  const byKey = Object.fromEntries(view.entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.storage.source, 'file');
  assert.equal(byKey['roles.habitsNote'].source, 'legacy habitsNote');
  assert.equal(byKey['roles.eventsRoot'].source, 'roles');
  assert.equal(byKey.layout.source, 'file');
  assert.deepEqual(view.deprecated, ['habitsNote']);
});

test('the effective view masks paths unless reveal is asked for explicitly', (t) => {
  const { store, complete } = fixture(t);
  const raw = complete();
  const masked = effectiveConfigView(raw).entries.find((entry) => entry.key === 'vaultRoot');
  assert.notEqual(masked.value, store);
  assert.match(masked.value, /…/);
  const shown = effectiveConfigView(raw, { revealPaths: true }).entries.find((entry) => entry.key === 'vaultRoot');
  assert.equal(shown.value, store);
});

test('a value absent from the file is reported as a default, not as content', (t) => {
  const { complete } = fixture(t);
  const raw = complete();
  delete raw.storage;
  delete raw.layout;
  const byKey = Object.fromEntries(effectiveConfigView(raw).entries.map((entry) => [entry.key, entry]));
  assert.equal(byKey.storage.value, 'filesystem');
  assert.equal(byKey.storage.source, 'default');
  assert.equal(byKey.layout.value, 'neutral');
  assert.equal(byKey.layout.source, 'default');
});

// ------------------------------------------------------------------ migration

test('migration folds legacy flat keys into roles and drops the duplicate', (t) => {
  const { complete } = fixture(t);
  const raw = complete({ habitsNote: 'legacy-habits.md', preferenceCandidatesNote: 'legacy-candidates.md' });
  delete raw.roles.habitsNote;
  delete raw.roles.candidatesNote;
  delete raw.configSchema;
  const plan = planConfigMigration(raw);
  assert.equal(plan.fromSchema, null);
  assert.equal(plan.toSchema, CONFIG_SCHEMA_VERSION);
  assert.equal(plan.next.roles.habitsNote, 'legacy-habits.md');
  assert.equal(plan.next.roles.candidatesNote, 'legacy-candidates.md');
  assert.equal(plan.next.habitsNote, undefined, 'the flat key must not survive alongside roles');
  assert.equal(plan.next.configSchema, CONFIG_SCHEMA_VERSION);
  assert.ok(plan.changes.some((change) => change.kind === 'fold-legacy' && change.field === 'habitsNote'));
});

test('migration never rewrites the release version', (t) => {
  const { complete } = fixture(t);
  const raw = complete();
  delete raw.configSchema;
  const plan = planConfigMigration(raw);
  assert.equal(plan.next.version, '1.0.0', 'version records the release, not the schema');
  assert.ok(!plan.changes.some((change) => change.field === 'version'));
});

test('migration is idempotent: planning an already-migrated document changes nothing', (t) => {
  const { complete } = fixture(t);
  const legacy = complete({ habitsNote: 'legacy-habits.md' });
  delete legacy.roles.habitsNote;
  delete legacy.configSchema;
  const once = planConfigMigration(legacy);
  assert.ok(once.changes.length > 0);
  const twice = planConfigMigration(once.next);
  assert.deepEqual(twice.changes, [], `second plan was not empty: ${JSON.stringify(twice.changes)}`);
  assert.deepEqual(twice.next, once.next);
});

test('migration fills an absent store root from the one that exists, and invents nothing', (t) => {
  const { store, complete } = fixture(t);
  const raw = complete();
  delete raw.memoryRoot;
  const plan = planConfigMigration(raw);
  assert.equal(plan.next.memoryRoot, store);
  assert.ok(plan.changes.some((change) => change.kind === 'derive' && change.field === 'memoryRoot'));
});

test('a fresh init needs no migration at all', (t) => {
  const { home, store, run } = fixture(t);
  assert.equal(run('init', '--store', store).status, 0);
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(raw.configSchema, CONFIG_SCHEMA_VERSION);
  assert.deepEqual(planConfigMigration(raw).changes, []);
});

// ------------------------------------------------------------------ CLI behaviour

test('config validate exits non-zero on an invalid document and reports every field', (t) => {
  const { write, complete, run } = fixture(t);
  write(complete({ layout: 'nope', activeLimit: 0 }));
  const result = run('config', 'validate');
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.homeSource, 'explicit --home');
  assert.ok(report.issues.some((issue) => issue.field === 'layout'));
  assert.ok(report.issues.some((issue) => issue.field === 'activeLimit'));
  // Every problem at once, so the user fixes the file in one pass.
  assert.ok(report.issues.length >= 2);
});

test('config validate on an invalid document creates nothing', (t) => {
  const { root, store, write, complete, run } = fixture(t);
  const ghost = path.join(root, 'ghost-store');
  write(complete({ memoryRoot: ghost, vaultRoot: ghost }));
  assert.equal(run('config', 'validate').status, 0);
  assert.equal(fs.existsSync(ghost), false);
  assert.equal(fs.existsSync(store), true);
});

test('config migrate is read-only', (t) => {
  const { home, write, complete, run } = fixture(t);
  const raw = complete();
  delete raw.configSchema;
  write(raw);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const result = run('config', 'migrate');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.applied, false);
  assert.ok(report.changes.length > 0);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before, 'migrate wrote to the config file');
});

test('config migrate --dry-run is accepted and still writes nothing', (t) => {
  const { home, write, complete, run } = fixture(t);
  write(complete());
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const result = run('config', 'migrate', '--dry-run');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.dryRun, true);
  assert.equal(report.applied, false);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
});

test('config show masks paths by default and reveals them on request', (t) => {
  const { store, write, complete, run } = fixture(t);
  write(complete());
  const masked = JSON.parse(run('config', 'show').stdout);
  const vault = masked.effective.find((entry) => entry.key === 'vaultRoot');
  assert.notEqual(vault.value, store);
  const revealed = JSON.parse(run('config', 'show', '--reveal-paths').stdout);
  assert.equal(revealed.effective.find((entry) => entry.key === 'vaultRoot').value, store);
});

test('an unknown config action fails with usage rather than doing something', (t) => {
  const { run } = fixture(t);
  const result = run('config', 'destroy');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: memkeel config validate\|show\|migrate/);
});

test('config validate reports a missing memory home instead of crashing', (t) => {
  const { root } = fixture(t);
  const result = spawnSync(process.execPath, [cli, 'config', 'validate', '--home', path.join(root, 'absent')], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_LOCALE: 'en' } });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.match(JSON.stringify(report.issues), /does not exist/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});

// ------------------------------------------------------------------ migration apply

/** A legacy document: no schema number, and a role only present in the old flat spelling. */
function legacyDocument(raw) {
  const next = { ...raw, habitsNote: 'legacy-habits.md', roles: { ...raw.roles } };
  delete next.roles.habitsNote;
  delete next.configSchema;
  return next;
}

test('apply migrates the document and keeps the original bytes as a rollback path', (t) => {
  const { home, write, complete } = fixture(t);
  const raw = legacyDocument(complete());
  write(raw);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');

  const outcome = applyConfigMigration(home);
  assert.equal(outcome.applied, true);
  assert.ok(outcome.changes.length > 0);
  // The rollback is real: the backup holds exactly what was there before.
  assert.equal(fs.readFileSync(outcome.backup, 'utf8'), before);

  const after = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  assert.equal(after.configSchema, CONFIG_SCHEMA_VERSION);
  assert.equal(after.roles.habitsNote, 'legacy-habits.md');
  assert.equal(after.habitsNote, undefined, 'the flat key must be folded, not duplicated');
  assert.equal(after.version, '1.0.0', 'the release version is never rewritten');
});

test('apply is idempotent: a second run writes nothing and leaves no second backup', (t) => {
  const { home, write, complete } = fixture(t);
  write(legacyDocument(complete()));
  assert.equal(applyConfigMigration(home).applied, true);
  const settled = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const backups = fs.readdirSync(path.join(home, 'backups', 'config-migrations'));

  const second = applyConfigMigration(home);
  assert.equal(second.applied, false);
  assert.equal(second.backup, null);
  assert.match(second.reason, /无需迁移/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), settled);
  assert.deepEqual(fs.readdirSync(path.join(home, 'backups', 'config-migrations')), backups);
});

test('apply refuses to write a migration whose result would be invalid', (t) => {
  const { home, write, complete } = fixture(t);
  // A broken layout stays broken, so the migrated document would be invalid too and the
  // original file must survive untouched.
  write(legacyDocument(complete({ layout: 'not-a-layout' })));
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.throws(() => applyConfigMigration(home), (error) => {
    assert.match(error.message, /校验未通过/);
    // The refusal carries the issues themselves as well as the sentence built from them, which is what
    // lets a caller word them in the reader's own language.
    assert.ok(Array.isArray(error.issues) && error.issues.length > 0,
      `the refusal must carry structured issues, got ${JSON.stringify(error.issues)}`);
    return true;
  });
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, 'backups', 'config-migrations')), false, 'nothing was written, so no backup either');
});

test('config migrate --apply writes, reports the backup, and exits zero', (t) => {
  const { home, write, complete, run } = fixture(t);
  write(legacyDocument(complete()));
  const result = run('config', 'migrate', '--apply');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.applied, true);
  assert.equal(report.toSchema, CONFIG_SCHEMA_VERSION);
  assert.ok(fs.existsSync(report.backup));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).configSchema, CONFIG_SCHEMA_VERSION);
});

test('config migrate --apply on an up-to-date document is a no-op that still exits zero', (t) => {
  const { home, store, run } = fixture(t);
  // `complete()` is a hand-written minimum. The canonical document is what `init` writes, and
  // that is the shape a migration has to recognise as already current.
  assert.equal(run('init', '--store', store).status, 0);
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  assert.deepEqual(planConfigMigration(JSON.parse(before)).changes, []);
  const result = run('config', 'migrate', '--apply');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.applied, false);
  assert.equal(report.backup, null);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
});

test('config migrate without --apply still writes nothing, and --apply is refused elsewhere', (t) => {
  const { home, write, complete, run } = fixture(t);
  write(legacyDocument(complete()));
  const before = fs.readFileSync(path.join(home, 'config.json'), 'utf8');
  const planned = run('config', 'migrate');
  assert.equal(planned.status, 0);
  assert.equal(JSON.parse(planned.stdout).dryRun, true);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before, 'the default must stay read-only');

  // --apply on an action that cannot write is a usage error, not a silent ignore.
  const wrong = run('config', 'validate', '--apply');
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /Usage: memkeel config validate\|show\|migrate/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);

  // Asking for the plan and the write at once is contradictory, so it is refused rather than
  // resolved by an arbitrary precedence.
  const contradictory = run('config', 'migrate', '--dry-run', '--apply');
  assert.equal(contradictory.status, 2);
  assert.match(contradictory.stderr, /Usage: memkeel config/);
  assert.equal(fs.readFileSync(path.join(home, 'config.json'), 'utf8'), before);
});
