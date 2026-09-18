// Coverage for backup, verification and restore (DATA-01).
//
// The acceptance criterion is a real restore: an archive taken from a store with events in it,
// restored into an empty directory, must read back the same events and answer the same query. The
// rest of the file exists because of the two ways that goes wrong — an archive that is quietly
// incomplete, and a restore that writes somewhere it should not — so the faults are injected rather
// than assumed away.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BACKUP_FORMAT, MANIFEST, classifyHomePath, collectEntries, createBackup, freeBytes, readManifest,
  restoreBackup, reviewRestore, verifyBackup,
} from '../lib/backup.mjs';
import { loadConfig } from '../lib/config.mjs';
import { loadEvents } from '../lib/core.mjs';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  const out = path.join(root, 'archive');
  const into = path.join(root, 'restored');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_LOCALE: 'en' } });
  assert.equal(run('init', '--store', store).status, 0);
  return { root, home, store, out, into, run, config: loadConfig(home).config };
}

/** A store with a real event in it, recorded through the CLI so the whole path is exercised. */
function withEvent(t) {
  const f = fixture(t);
  const note = path.join(f.store, 'evidence.md');
  fs.writeFileSync(note, '# Evidence\n\nA note the event can cite.\n');
  // A pending capture, so the archive has something under state/ that is *not* rebuildable: the
  // classification must not be "everything under state/ is a cache".
  fs.mkdirSync(path.join(f.home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'state', 'captures.json'), '{"pending-capture":{"event":{"event_id":"x"}}}\n');
  // Something rebuildable, so the manifest has an omission to declare.
  fs.writeFileSync(path.join(f.home, 'state', 'index.json'), '{"entries":{}}\n');

  // A workspace id is derived from the project root, so it is read back rather than assumed.
  const project = path.join(f.root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const added = f.run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  const workspace = JSON.parse(added.stdout).id;
  const topic = `${workspace}/backup`;
  const registered = f.run('register', '--topic', topic, '--workspace', workspace, '--title', 'Backup drill');
  assert.equal(registered.status, 0, registered.stderr);

  fs.writeFileSync(path.join(f.root, 'event.json'), JSON.stringify({
    event_id: '20260916-dsh-backup-drill-01',
    workspace,
    topic,
    agent: 'dsh',
    // `record` states the occurrence time explicitly; `capture` is the one that can infer it.
    occurred_at: '2026-09-16T00:00:00.000Z',
    evidence: ['evidence.md'],
    facts: [{ key: 'restore-drill', text: 'the restored store answers the same query' }],
    verification: ['recorded so the archive has something real to carry'],
  }, null, 2));

  const record = f.run('record', '--file', path.join(f.root, 'event.json'));
  assert.equal(record.status, 0, record.stderr);
  // Re-read the config: the one loaded before `register` has no topic routes, and an event whose
  // topic is not registered is rejected as unknown rather than read.
  const config = loadConfig(f.home).config;
  const events = loadEvents(config);
  assert.equal(events.length, 1, 'the fixture must contain exactly one event');
  return { ...f, config, events, workspace, topic };
}

// ------------------------------------------------------------------ classification

test('what cannot be recomputed is data, and what can is not carried', () => {
  for (const relative of ['config.json', 'bootstrap.md', 'event-schema.md', 'dsh-hooks.json', 'state/setup-receipt.json', 'state/retention.json', 'state/captures.json', 'state/consumed.json', 'state/hook-queue/abc.json', 'backups/setup-1/x.toml', 'anything/else.md']) {
    assert.equal(classifyHomePath(relative), 'data', `${relative} should be carried`);
  }
  // Rebuilt from the journal by `memkeel index` and `consolidate`.
  for (const relative of ['state/index.json', 'state/legacy-catalog.json', 'state/access-log.json', 'state/last-bootstrap.json', 'state/adapters.json', 'state/setup.json']) {
    assert.equal(classifyHomePath(relative), 'derived', `${relative} is rebuildable`);
  }
  // Ephemeral: locks and per-session hook bookkeeping.
  for (const relative of ['state/writer.lock', 'state/hook-sessions/abc/session.json', 'state/setup-lock/writer.lock', 'state/index.json.tmp']) {
    assert.equal(classifyHomePath(relative), 'runtime', `${relative} is runtime state`);
  }
  // The receipt is the one to get right: it is the restore chain for host configuration.
  assert.equal(classifyHomePath('state/setup-receipt.json'), 'data');
  // A path that merely starts with a data directory's name is not inside it.
  assert.equal(classifyHomePath('state/hook-queue-backup/x.json'), 'data');
});

// ------------------------------------------------------------------ create

test('an archive carries the journal, the non-rebuildable state, and a manifest that describes it', (t) => {
  const f = withEvent(t);
  const result = createBackup(f.config, { out: f.out, version: '1.0.0', now: '2026-09-16T00:00:00.000Z' });

  const manifest = readManifest(f.out);
  assert.equal(manifest.format, BACKUP_FORMAT);
  assert.equal(manifest.createdAt, '2026-09-16T00:00:00.000Z');
  assert.equal(manifest.source.memkeel, '1.0.0');
  assert.equal(manifest.home.path, f.home);
  assert.equal(manifest.home.store, f.store);
  assert.equal(manifest.counts.files, manifest.files.length);
  assert.equal(manifest.counts.bytes, manifest.files.reduce((sum, row) => sum + row.bytes, 0));
  for (const row of manifest.files) {
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.equal(row.kind, 'data');
    assert.ok(row.path.startsWith('home/') || row.path.startsWith('store/'), row.path);
  }

  const carried = manifest.files.map((row) => row.path);
  // The journal.
  assert.ok(carried.some((p) => p.startsWith('store/events/')), JSON.stringify(carried));
  // The configuration and the shared policy source.
  assert.ok(carried.includes('home/config.json'));
  assert.ok(carried.includes('home/bootstrap.md'));
  assert.ok(carried.includes('home/event-schema.md'));
  // Pending work and user decisions are carried even though they live under state/.
  assert.ok(carried.includes('home/state/captures.json'));
  // The derived index is not carried, and the manifest says so rather than leaving it a mystery.
  assert.equal(carried.includes('home/state/index.json'), false);
  assert.equal(result.files, manifest.files.length);
  assert.equal(result.notCarried, manifest.notCarried.length);
});

test('a live writer lock is not reported as a deliberate omission', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const manifest = readManifest(f.out);
  // The backup holds the writer lock while it walks, so the lock exists during collection; it is
  // runtime state, not something a reader should be told was left out.
  assert.equal(manifest.notCarried.some((row) => row.path.endsWith('writer.lock')), false, JSON.stringify(manifest.notCarried));
});

test('a destination inside the home or the store is refused', (t) => {
  const f = withEvent(t);
  for (const inside of [path.join(f.home, 'archive'), path.join(f.store, 'archive'), f.home, f.store]) {
    assert.throws(() => createBackup(f.config, { out: inside }), /outside the (memory home|store)/, inside);
  }
});

test('a destination that already holds something is refused rather than merged', (t) => {
  const f = withEvent(t);
  fs.mkdirSync(f.out, { recursive: true });
  fs.writeFileSync(path.join(f.out, 'something.txt'), 'x');
  assert.throws(() => createBackup(f.config, { out: f.out }), /not empty/);
});

// ------------------------------------------------------------------ verify, with faults injected

test('a fresh archive verifies', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const report = verifyBackup(f.out);
  assert.equal(report.ok, true, JSON.stringify(report.problems));
  assert.equal(report.format, BACKUP_FORMAT);
  assert.deepEqual(report.issues, { corrupted: [], missing: [], extra: [] });
});

/** Rewrite one archived file, so the bytes no longer match the checksum recorded for them. */
function corrupt(archive, relative) {
  const file = path.join(archive, relative.replaceAll('/', path.sep));
  fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}\n# tampered\n`);
}

test('a tampered file is reported as corrupted, and named', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  corrupt(f.out, 'home/config.json');
  const report = verifyBackup(f.out);
  assert.equal(report.ok, false);
  assert.equal(report.issues.corrupted.length, 1);
  assert.equal(report.issues.corrupted[0].path, 'home/config.json');
  assert.notEqual(report.issues.corrupted[0].expected, report.issues.corrupted[0].actual);
  // The other files are still reported as fine: "which parts are good" is the useful answer.
  assert.deepEqual(report.issues.missing, []);
});

test('a file that never made it into the archive is reported as missing', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  fs.rmSync(path.join(f.out, 'store', 'habits.md'), { force: true });
  const report = verifyBackup(f.out);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.missing, ['store/habits.md']);
});

test('an unlisted file in the archive is reported, not ignored', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  fs.writeFileSync(path.join(f.out, 'sneaked-in.md'), 'not in the manifest\n');
  const report = verifyBackup(f.out);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues.extra, ['sneaked-in.md']);
});

test('an archive from another format is refused rather than guessed at', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const manifest = readManifest(f.out);
  fs.writeFileSync(path.join(f.out, MANIFEST), JSON.stringify({ ...manifest, format: BACKUP_FORMAT + 1 }, null, 2));
  const report = verifyBackup(f.out);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => problem.kind === 'format'));
  assert.equal(reviewRestore(readManifest(f.out), { into: f.into }).ok, false);
});

test('something that is not an archive at all is refused clearly', (t) => {
  const f = fixture(t);
  assert.throws(() => readManifest(f.out), /is not a memkeel backup/);
  fs.mkdirSync(f.out, { recursive: true });
  fs.writeFileSync(path.join(f.out, MANIFEST), '{ not json');
  assert.throws(() => readManifest(f.out), /not valid JSON/);
  fs.writeFileSync(path.join(f.out, MANIFEST), JSON.stringify({ format: 1 }));
  assert.throws(() => readManifest(f.out), /no file list/);
});

// ------------------------------------------------------------------ restore review

test('the restore plan refuses a manifest that would write outside the destination', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const manifest = readManifest(f.out);
  const base = { ...manifest, files: [...manifest.files] };

  const absolute = reviewRestore({ ...base, files: [...manifest.files, { path: process.platform === 'win32' ? 'C:/Windows/Temp/evil.txt' : '/tmp/evil.txt', kind: 'data', bytes: 1, sha256: 'x' }] }, { into: f.into });
  assert.equal(absolute.ok, false);
  assert.ok(absolute.issues.some((issue) => issue.kind === 'traversal'));

  const climbing = reviewRestore({ ...base, files: [...manifest.files, { path: 'home/../../evil.txt', kind: 'data', bytes: 1, sha256: 'x' }] }, { into: f.into });
  assert.equal(climbing.ok, false);
  assert.ok(climbing.issues.some((issue) => issue.kind === 'traversal'));

  const misplaced = reviewRestore({ ...base, files: [...manifest.files, { path: 'elsewhere/file.md', kind: 'data', bytes: 1, sha256: 'x' }] }, { into: f.into });
  assert.equal(misplaced.ok, false);
  assert.ok(misplaced.issues.some((issue) => issue.kind === 'layout'));
});

test('the restore plan refuses a destination that already holds data', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const manifest = readManifest(f.out);
  assert.equal(reviewRestore(manifest, { into: f.into }).ok, true);

  fs.mkdirSync(f.into, { recursive: true });
  fs.writeFileSync(path.join(f.into, 'occupied'), 'x');
  const occupied = reviewRestore(manifest, { into: f.into });
  assert.equal(occupied.ok, false);
  assert.ok(occupied.issues.some((issue) => issue.kind === 'conflict'));
});

test('the restore plan refuses when the destination has too little space', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const manifest = readManifest(f.out);
  const required = manifest.files.reduce((sum, row) => sum + row.bytes, 0);

  const tight = reviewRestore(manifest, { into: f.into, free: required - 1 });
  assert.equal(tight.ok, false);
  assert.ok(tight.issues.some((issue) => issue.kind === 'space'));
  assert.equal(tight.required, required);

  // One byte more is enough, and the free-space measurement itself is real where the platform has it.
  assert.equal(reviewRestore(manifest, { into: f.into, free: required }).ok, true);
  const measured = freeBytes(f.root);
  assert.ok(measured === null || measured > 0, `freeBytes returned ${measured}`);
});

// ------------------------------------------------------------------ restore

test('a restore into a new directory reproduces the events and the query', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  const review = reviewRestore(readManifest(f.out), { into: f.into });
  assert.equal(review.ok, true, JSON.stringify(review.issues));

  const result = restoreBackup(f.out, { into: f.into });
  assert.equal(result.files, readManifest(f.out).files.length);

  // The restored configuration must point at the restored store, or the restore produces a directory
  // that looks fine and reads somebody else's data.
  const restored = loadConfig(result.home).config;
  assert.equal(path.resolve(restored.vaultRoot), path.resolve(result.store));
  assert.equal(path.resolve(restored.policyRoot), result.home);
  assert.ok(result.configRewritten.some((row) => row.key === 'vaultRoot'));

  // The acceptance criterion: same events, same answers.
  const original = loadEvents(f.config);
  const recovered = loadEvents(restored);
  assert.equal(recovered.length, original.length);
  assert.deepEqual(recovered.map((event) => event.event_id).sort(), original.map((event) => event.event_id).sort());
  assert.deepEqual(recovered[0].facts, original[0].facts);
  // The evidence note travelled with the journal rather than being left behind.
  assert.equal(fs.existsSync(path.join(result.store, 'evidence.md')), true);
});

test('a restore interrupted while repointing the configuration leaves no half-written config', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });

  // The rewrite is the one in-place write in a restore, and a direct write truncates the file first:
  // a crash there leaves a configuration naming the old store inside a directory that otherwise looks
  // like a completed restore. The write is matched by its content, so this holds whichever file the
  // implementation writes first.
  const real = fs.writeFileSync;
  fs.writeFileSync = function (target, content, ...rest) {
    if (String(content).includes('policyRoot')) {
      real.call(fs, target, String(content).slice(0, 8));
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    }
    return real.call(fs, target, ...rest);
  };
  t.after(() => { fs.writeFileSync = real; });

  assert.throws(() => restoreBackup(f.out, { into: f.into }), /ENOSPC/);
  const configFile = path.join(f.into, 'home', 'config.json');
  // Either no configuration is left, or a whole one that no longer points at the source store. A
  // partial one, or one still naming the store it was restored from, is the outcome this rewrite
  // exists to prevent: the directory would look restored and read somebody else's data.
  if (fs.existsSync(configFile)) {
    let saved = null;
    assert.doesNotThrow(() => { saved = JSON.parse(fs.readFileSync(configFile, 'utf8')); }, 'a failed rewrite must not leave a partial configuration');
    const pointedAt = path.resolve(saved.vaultRoot ?? saved.memoryRoot ?? '');
    assert.notEqual(pointedAt, path.resolve(f.config.vaultRoot), 'a destination must never be left pointing at the source store');
  }
});

test('a restore refuses a tampered archive and writes nothing', (t) => {
  const f = withEvent(t);
  createBackup(f.config, { out: f.out });
  corrupt(f.out, 'store/habits.md');
  const executed = f.run('restore', '--dir', f.out, '--into', f.into, '--execute');
  assert.equal(executed.status, 1);
  assert.match(executed.stderr, /the archive failed verification/);
  // Nothing was half-written: the integrity check runs before the first byte is copied.
  assert.equal(fs.existsSync(f.into), false);
});

test('the CLI reports a plan by default and only writes with --execute', (t) => {
  const f = withEvent(t);
  assert.equal(f.run('backup', 'create', '--out', f.out).status, 0);

  const planned = f.run('restore', '--dir', f.out, '--into', f.into);
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).dryRun, true);
  assert.equal(fs.existsSync(f.into), false, 'the plan wrote to disk');

  const executed = f.run('restore', '--dir', f.out, '--into', f.into, '--execute');
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(JSON.parse(executed.stdout).files > 0, true);
  assert.equal(fs.existsSync(path.join(f.into, 'home', 'config.json')), true);
});

test('the CLI verifies an archive and exits non-zero when it is bad', (t) => {
  const f = withEvent(t);
  assert.equal(f.run('backup', 'create', '--out', f.out).status, 0);
  assert.equal(f.run('backup', 'verify', '--dir', f.out).status, 0);
  corrupt(f.out, 'home/config.json');
  const bad = f.run('backup', 'verify', '--dir', f.out);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
});

test('collectEntries is a read-only description of what a backup would contain', (t) => {
  const f = withEvent(t);
  const before = JSON.stringify(collectEntries(f.config).entries);
  assert.equal(fs.existsSync(f.out), false, 'describing an archive must not create one');
  const second = JSON.stringify(collectEntries(f.config).entries);
  // Only the writer lock is transient, and it is not part of the description.
  assert.equal(second, before);
});
