// Coverage for retention enforcement (PRIV-01, plan item 5).
//
// This is the only place in the program that deletes files a user might want, so the tests are
// mostly about what it must NOT touch: the ledger, the store, the user's own archives, and the
// rollback directory an in-flight atomic write depends on. The dangerous cases are exercised with a
// crafted plan rather than assumed away, because a plan is data and may be stale or hand-edited.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLEANUP_FORMAT, CLEANUP_PROTECTED, executeCleanup, planCleanup } from '../lib/cleanup.mjs';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
const DAY = 86400000;

function fixture(t, { backups = 2, diagnosticsDays = 14, contextDays = 30 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policyRoot = path.join(root, 'home');
  const vaultRoot = path.join(root, 'store');
  for (const dir of ['backups/config-migrations', 'backups/replacements', 'state/hook-sessions']) {
    fs.mkdirSync(path.join(policyRoot, dir), { recursive: true });
  }
  // The ledger lives in the store, not the home: a retention pass must not reach it at all.
  fs.mkdirSync(path.join(vaultRoot, 'events'), { recursive: true });
  const collection = { retention: { backups, diagnosticsDays, contextDays } };
  // Written into the file as well as handed to the library, because the CLI reads the file — a
  // fixture that only sets the in-memory value would test the defaults instead of the setting.
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify({ policyRoot, vaultRoot, collection }));
  fs.writeFileSync(path.join(policyRoot, 'backups/replacements/keepme.txt'), 'operational rollback state\n');
  const config = { policyRoot, vaultRoot, collection };
  return { root, policyRoot, vaultRoot, config };
}

/** Backdate a path by N days. Applied to the path the decision actually reads, which for a session is
 * the directory rather than the file inside it. */
function age(target, days) {
  const when = new Date(Date.now() - days * DAY);
  fs.utimesSync(target, when, when);
  return target;
}

function populate(f) {
  // Higher number = newer, so "keep the newest two" has an unambiguous answer.
  for (const n of [1, 2, 3, 4]) {
    const dir = path.join(f.policyRoot, `backups/setup-${1000 + n}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'x.toml'), `snap ${n}`);
    age(dir, 20 - n);
  }
  for (const n of [1, 2, 3]) {
    const file = path.join(f.policyRoot, `backups/config-migrations/2026-09-0${n}-config.json`);
    fs.writeFileSync(file, `{"n":${n}}`);
    age(file, 20 - n);
  }
  for (const [name, days] of [['stale-a', 40], ['stale-b', 40], ['fresh-c', 1]]) {
    const dir = path.join(f.policyRoot, 'state/hook-sessions', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.json'), '{"prompt":""}');
    age(dir, days);
  }
  const boot = path.join(f.policyRoot, 'state/last-bootstrap.json');
  fs.writeFileSync(boot, '{"audit":true}');
  age(boot, 40);
  return f;
}

const relatives = (plan, group) => plan.targets.filter((row) => row.group === group).map((row) => row.relative).sort();

// ------------------------------------------------------------------ the plan

test('the plan keeps the newest backups and names the rest', (t) => {
  const f = populate(fixture(t));
  const plan = planCleanup(f.config);
  assert.equal(plan.format, CLEANUP_FORMAT);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.executed, false);
  assert.deepEqual(plan.policy, { backups: 2, diagnosticsDays: 14, contextDays: 30 });
  // Newest two survive: setup-1004 and setup-1003.
  assert.deepEqual(relatives(plan, 'setup-snapshots'), ['backups/setup-1001', 'backups/setup-1002']);
  assert.deepEqual(plan.kept.filter((row) => row.group === 'setup-snapshots').map((row) => row.relative), ['backups/setup-1004', 'backups/setup-1003']);
  // Same count applied to the migration files.
  assert.deepEqual(relatives(plan, 'config-migrations'), ['backups/config-migrations/2026-09-01-config.json']);
  assert.deepEqual(plan.issues, []);
  assert.ok(plan.bytes > 0);
  // A rehearsal deletes nothing.
  assert.ok(fs.existsSync(path.join(f.policyRoot, 'backups/setup-1001')));
});

test('age decides the runtime state, and a fresh session is left alone', (t) => {
  const f = populate(fixture(t));
  const plan = planCleanup(f.config);
  assert.deepEqual(relatives(plan, 'session-state'), ['state/hook-sessions/stale-a', 'state/hook-sessions/stale-b']);
  assert.deepEqual(relatives(plan, 'bootstrap-diagnostics'), ['state/last-bootstrap.json']);
  assert.ok(plan.kept.some((row) => row.relative === 'state/hook-sessions/fresh-c'));

  // A longer window keeps everything, which is what a retention setting is supposed to mean.
  const patient = planCleanup(f.config, { diagnosticsDays: 365 });
  assert.deepEqual(relatives(patient, 'session-state'), []);
  assert.deepEqual(relatives(patient, 'bootstrap-diagnostics'), []);
});

test('retention never proposes anything outside its own two groups', (t) => {
  const f = populate(fixture(t));
  const plan = planCleanup(f.config);
  for (const row of plan.targets) {
    assert.ok(/^(backups|state)\//.test(row.relative), `${row.relative} is outside the allowed roots`);
    assert.equal(path.isAbsolute(row.relative), false);
  }
  // The rollback directory is named as protected rather than silently skipped, so a reader can see
  // it was considered and deliberately spared.
  assert.deepEqual(plan.protected, ['backups/replacements']);
  assert.equal(plan.targets.some((row) => row.relative.includes('replacements')), false);
  // And the scope statement says what is out of reach.
  assert.ok(plan.notCovered.some((line) => /replacements/.test(line)));
  assert.ok(plan.notCovered.some((line) => /事件账本/.test(line)));
});

test('a home with nothing to prune produces an empty plan', (t) => {
  const f = fixture(t);
  const plan = planCleanup(f.config);
  assert.deepEqual(plan.targets, []);
  assert.equal(plan.bytes, 0);
  assert.deepEqual(plan.issues, []);
});

// ------------------------------------------------------------------ the deletion

test('executing removes exactly the planned paths and nothing else', (t) => {
  const f = populate(fixture(t));
  const ledger = path.join(f.vaultRoot, 'events/2026-09-16.md');
  fs.writeFileSync(ledger, 'an immutable record\n');
  const plan = planCleanup(f.config);
  const result = executeCleanup(f.config, plan);

  assert.equal(result.executed, true);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.errors, []);
  assert.equal(result.removed.length, plan.targets.length);
  assert.equal(result.bytes, plan.bytes);
  for (const row of plan.targets) assert.equal(fs.existsSync(path.join(f.policyRoot, row.relative)), false, `${row.relative} should be gone`);

  // What must survive: the newest backups, the fresh session, the protected rollback state, the
  // configuration, and the ledger.
  for (const keep of ['backups/setup-1003', 'backups/setup-1004', 'backups/config-migrations/2026-09-02-config.json', 'backups/config-migrations/2026-09-03-config.json', 'state/hook-sessions/fresh-c', 'backups/replacements/keepme.txt', 'config.json']) {
    assert.equal(fs.existsSync(path.join(f.policyRoot, keep)), true, `${keep} must be kept`);
  }
  assert.equal(fs.readFileSync(ledger, 'utf8'), 'an immutable record\n');
  assert.equal(fs.existsSync(f.vaultRoot), true);

  // Running the plan again now finds nothing: the prune is complete, not merely attempted.
  assert.deepEqual(planCleanup(f.config).targets, []);
});

test('a crafted or stale plan cannot point the deletion somewhere else', (t) => {
  const f = populate(fixture(t));
  const outside = path.join(f.root, 'outside.txt');
  fs.writeFileSync(outside, 'not mine to delete\n');
  const plan = {
    format: CLEANUP_FORMAT,
    targets: [
      { group: 'setup-snapshots', relative: '../outside.txt', bytes: 1 },
      { group: 'not-a-group', relative: 'backups/setup-1001', bytes: 1 },
      { group: 'setup-snapshots', relative: 'backups/replacements/keepme.txt', bytes: 1 },
      { group: 'setup-snapshots', relative: path.join(f.root, 'absolute-escape'), bytes: 1 },
    ],
  };
  const result = executeCleanup(f.config, plan);
  assert.deepEqual(result.removed, []);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some((row) => /未知分组/.test(row.message)));
  assert.ok(result.errors.some((row) => /memory home 之外/.test(row.message)));
  assert.ok(result.errors.some((row) => /回滚目录/.test(row.message)));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'not mine to delete\n');
  assert.equal(fs.existsSync(path.join(f.policyRoot, 'backups/replacements/keepme.txt')), true);
  assert.equal(fs.existsSync(path.join(f.policyRoot, 'backups/setup-1001')), true, 'a rejected target must survive');
});

test('executing needs a real plan', (t) => {
  const f = fixture(t);
  assert.throws(() => executeCleanup(f.config, {}), /plan is required/);
  assert.throws(() => executeCleanup(f.config, { format: CLEANUP_FORMAT }), /plan is required/);
});

// ------------------------------------------------------------------ the CLI

test('the CLI previews by default and only deletes when told to', (t) => {
  const f = populate(fixture(t));
  const before = fs.readdirSync(path.join(f.policyRoot, 'backups')).sort();

  const run = (...args) => spawnSync(process.execPath, [cli, 'privacy', 'cleanup', ...args, '--home', f.policyRoot], { encoding: 'utf8', windowsHide: true, cwd: path.dirname(cli) });

  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  const planned = JSON.parse(preview.stdout);
  assert.equal(planned.dryRun, true);
  assert.equal(planned.plan.dryRun, true);
  assert.ok(planned.plan.targets.length > 0);
  assert.deepEqual(fs.readdirSync(path.join(f.policyRoot, 'backups')).sort(), before, 'a preview must not delete anything');

  const executed = run('--execute');
  assert.equal(executed.status, 0, executed.stderr);
  const done = JSON.parse(executed.stdout);
  assert.equal(done.executed, true);
  assert.equal(done.dryRun, false);
  assert.equal(done.removed.length, planned.plan.targets.length);
  assert.equal(done.executedPlan.targets, planned.plan.targets.length);
  assert.deepEqual(done.errors, []);
  assert.equal(fs.existsSync(path.join(f.policyRoot, 'backups/setup-1001')), false);
  assert.equal(fs.existsSync(path.join(f.policyRoot, 'backups/replacements/keepme.txt')), true);
});
