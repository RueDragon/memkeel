import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTransport } from '../lib/storage/index.mjs';
import { loadEvents, localDay, record, walk } from '../lib/core.mjs';

// Atomic publish, as seen from a process that dies in the middle of it.
//
// Storage used to write the target in place: the file was truncated first and the new bytes were
// copied into it. A process killed inside that window destroyed the bytes that were already there,
// so an append that never completed could delete every event the note had accumulated. A `catch`
// that writes the old bytes back does not fix that - a killed process runs no `catch`, and a
// rollback would also overwrite whatever a second writer had put there in the meantime. The fix is
// to write a sibling temporary and rename it over the target, so a reader sees the old note or the
// new one and never a mixture.
//
// What these tests hold the implementation to:
//
//   - the committed note survives every crash boundary byte-for-byte;
//   - a retry after a crash neither loses the old events nor appends the same block twice;
//   - the temporary a crash leaves behind cannot be read as an event, and is never deleted for the
//     caller - a later run cannot prove it owns that file;
//   - a *failed* publish, unlike a killed one, cleans up its own temporary and reports the failure.
//
// The children are killed with SIGKILL, because a failed write lets the process clean up after
// itself and so proves nothing about a crash. They run `record()` and the storage factory the CLI
// itself uses, so the boundary under test is the real one rather than a stand-in.
const OCCURRED = '2026-09-10T03:00:00.000Z';
const EVIDENCE = 'work/evidence/demo.md';

// The child script and the fault injector are written into the test's own temporary directory: the
// repository stays unchanged, and `--import` injects the injector before any application module is
// loaded. The injector kills the process at one named boundary of the publish protocol.
const CHILD = `
import fs from 'node:fs';
import { createTransport } from ${JSON.stringify(new URL('../lib/storage/index.mjs', import.meta.url).href)};
import { record } from ${JSON.stringify(new URL('../lib/core.mjs', import.meta.url).href)};
const config = JSON.parse(fs.readFileSync(process.env.MEMKEEL_TEST_CONFIG, 'utf8'));
const event = JSON.parse(fs.readFileSync(process.env.MEMKEEL_TEST_EVENT, 'utf8'));
process.stdout.write('RESULT:' + JSON.stringify(record(config, createTransport(config), event)));
`;

const BARRIER = `
import fs from 'node:fs';
const kind = process.env.MEMKEEL_BARRIER_KIND;
const target = process.env.MEMKEEL_BARRIER_TARGET;
const marker = process.env.MEMKEEL_BARRIER_MARKER;
let fired = false;
function kill() {
  if (fired) return;
  fired = true;
  process.kill(process.pid, 'SIGKILL');
}
if (kind === 'mid-write') {
  // A publish writes its temporary through a file descriptor, so the call carrying the bytes sees an
  // integer rather than a path; an in-place write names the target itself. Both shapes are matched, and
  // the marker content decides which write is the one under test, so this injector still fires against
  // an implementation that truncates the target in place - which is what makes the test evidence about
  // the data loss rather than a description of one particular mechanism.
  const real = fs.writeFileSync;
  fs.writeFileSync = function (to, content, ...rest) {
    const name = String(to);
    const writesTarget = typeof to === 'number' || name === target || name.startsWith(target + '.');
    if (!fired && writesTarget && String(content).includes(marker)) {
      real.call(fs, to, String(content).slice(0, Math.floor(String(content).length / 2)));
      kill();
    }
    return real.call(fs, to, content, ...rest);
  };
} else {
  const real = fs.renameSync;
  fs.renameSync = function (from, to, ...rest) {
    if (!fired && String(to) === target) {
      // 'before-publish': the temporary is complete and flushed, the rename has not happened.
      if (kind === 'before-publish') kill();
      const done = real.call(fs, from, to, ...rest);
      // 'after-publish': the new bytes are live and the caller has not read them back yet.
      if (kind === 'after-publish') kill();
      return done;
    }
    return real.call(fs, from, to, ...rest);
  };
}
`;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-publish-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'),
    workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', topicsRoot: 'work/topics',
    habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md',
    preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000,
    // Filesystem storage is what a store without an Obsidian CLI runs on, so this is the same
    // backend the documented headless path uses.
    storage: 'filesystem',
    topics: [{ id: 'demo/notes', workspace: 'demo', title: 'Demo notes' }],
  };
  for (const dir of ['work/projects', 'work/events', 'work/inbox', 'work/evidence']) fs.mkdirSync(path.join(config.vaultRoot, dir), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n```json\n{"rules":[]}\n```\n');
  fs.writeFileSync(path.join(config.vaultRoot, EVIDENCE), '# Evidence\n\nA note.\n');
  fs.writeFileSync(path.join(root, 'child.mjs'), CHILD);
  fs.writeFileSync(path.join(root, 'barrier.mjs'), BARRIER);
  return { root, config };
}

// Both timestamps are explicit: `record` would otherwise stamp its own clock, and a retry a moment
// later would then look like the same id carrying different content rather than a retry.
function sampleEvent(id, text) {
  return {
    event_id: id, workspace: 'demo', topic: 'demo/notes', agent: 'dsh',
    occurred_at: OCCURRED, recorded_at: OCCURRED,
    evidence: [EVIDENCE],
    facts: [{ key: 'demo-fact', text }],
  };
}

const journalNote = (config) => `${config.eventsRoot}/${localDay(OCCURRED)}-demo-dsh.md`;

// The temporary a kill leaves behind, named by the publish and therefore never a `.md` itself.
function residueOf(config, relative) {
  const dir = path.dirname(path.join(config.vaultRoot, relative));
  const base = path.basename(relative);
  return fs.readdirSync(dir).filter((name) => name.startsWith(`${base}.`) && name.endsWith('.tmp'))
    .map((name) => ({ name, file: path.join(dir, name), text: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

// A killed writer leaves the writer lock behind exactly as a killed run of the CLI does, and this
// build never removes a lock it did not create. Clearing it is the documented human recovery step
// for a writer that is provably gone, not something the retry does for itself.
function clearLock(config) {
  fs.rmSync(path.join(config.policyRoot, 'state', 'writer.lock'), { force: true });
}

function spawnKilled(t, { root, config, event, kind, marker, target }) {
  const eventFile = path.join(root, `event-${event.event_id}.json`);
  fs.writeFileSync(eventFile, JSON.stringify(event));
  const child = spawn(process.execPath, [path.join(root, 'child.mjs')], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(path.join(root, 'barrier.mjs')).href}`,
      MEMKEEL_TEST_CONFIG: path.join(config.policyRoot, 'config.json'),
      MEMKEEL_TEST_EVENT: eventFile,
      MEMKEEL_BARRIER_KIND: kind,
      MEMKEEL_BARRIER_MARKER: marker,
      MEMKEEL_BARRIER_TARGET: target,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const state = { code: null, signal: null, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { state.stdout += chunk; });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  // A child that is never killed by the injector is a broken test, not a slow one: the timeout
  // fails it rather than hanging the suite.
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 30000);
  timer.unref?.();
  t.after(() => { clearTimeout(timer); try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  return new Promise((resolve) => {
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ ...state, code, signal }); });
  });
}

function assertKilled(result) {
  assert.equal(result.stdout.includes('RESULT'), false, `the child must not have completed: ${result.stderr.trim()}`);
  assert.notEqual(result.code, 0, `the killed child must not report success: ${result.stderr.trim()}`);
}

const attempt = (config, event) => record(config, createTransport(config), event);

test('a kill in the middle of the temporary leaves the committed events byte-identical and the residue unreadable', async (t) => {
  const { root, config } = fixture(t);
  const note = journalNote(config);
  const first = sampleEvent('demo-event-0001', 'The first committed event.');
  const second = sampleEvent('demo-event-0002', 'The event the crash interrupted.');
  assert.equal(attempt(config, first).duplicate, false);
  const committed = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');

  const result = await spawnKilled(t, { root, config, event: second, kind: 'mid-write', marker: second.event_id, target: path.join(config.vaultRoot, note) });
  assertKilled(result);

  // The append had already read the committed note and was writing its replacement. The note must
  // still hold exactly the bytes it held before, or the crash has deleted committed events.
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, note), 'utf8'), committed, 'the committed note must survive a torn temporary');
  const residue = residueOf(config, note);
  assert.equal(residue.length, 1, `the kill must leave exactly one temporary: ${JSON.stringify(fs.readdirSync(path.dirname(path.join(config.vaultRoot, note))))}`);

  // Residue is not an event: the scanner matches `.md` only, so a half-written temporary can never be
  // parsed, and it cannot make the journal look incomplete either.
  assert.deepEqual(walk(path.join(config.vaultRoot, config.eventsRoot)).map((file) => path.relative(config.vaultRoot, file).replaceAll('\\', '/')), [note]);
  const afterCrash = loadEvents(config).map((event) => event.event_id);
  assert.deepEqual(afterCrash, [first.event_id], 'only the committed event may be visible');

  clearLock(config);
  assert.equal(attempt(config, second).duplicate, false);
  const recovered = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id, second.event_id]);

  // The retry published exactly the write the killed process was building, cut short in the temporary:
  // that is what makes it the same append retried rather than a second, differently shaped one.
  assert.ok(recovered.startsWith(committed), 'the retry must keep the committed events');
  assert.ok(residue[0].text.length < recovered.length, 'the temporary must be a genuinely partial write');
  assert.equal(recovered.startsWith(residue[0].text), true, 'and it must be that same write');
  assert.equal(residue[0].text.endsWith('<!-- END-EVENT -->'), false, 'a torn temporary must not hold a complete event');
  assert.deepEqual(residueOf(config, note).map((row) => row.text), residue.map((row) => row.text), 'the residue must still be there: no run can prove it owns that file');
});

test('a kill just before the publish leaves the note untouched and the complete temporary behind', async (t) => {
  const { root, config } = fixture(t);
  const note = journalNote(config);
  const first = sampleEvent('demo-event-0001', 'The first committed event.');
  const second = sampleEvent('demo-event-0002', 'The event the crash interrupted.');
  assert.equal(attempt(config, first).duplicate, false);
  const committed = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');

  const result = await spawnKilled(t, { root, config, event: second, kind: 'before-publish', marker: second.event_id, target: path.join(config.vaultRoot, note) });
  assertKilled(result);

  assert.equal(fs.readFileSync(path.join(config.vaultRoot, note), 'utf8'), committed, 'the rename had not happened, so the note must be untouched');
  const residue = residueOf(config, note);
  assert.equal(residue.length, 1);
  // The temporary is complete: the bytes were written and flushed before the crash, and only the
  // rename that would have published them was missing. That is the difference between this boundary
  // and the torn write above.
  assert.ok(residue[0].text.startsWith(committed), 'the temporary must hold the whole replacement');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id]);

  clearLock(config);
  assert.equal(attempt(config, second).duplicate, false);
  const recovered = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');
  // Publishing the same content again reproduces the flushed temporary byte for byte.
  assert.equal(recovered, residue[0].text, 'the retry must publish exactly what the crash left flushed');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id, second.event_id]);
  assert.equal(recovered.split(`<!-- EVENT:${second.event_id} -->`).length - 1, 1, 'the interrupted event must appear exactly once');
});

test('a kill just after the publish is retried as a duplicate instead of appending the event twice', async (t) => {
  const { root, config } = fixture(t);
  const note = journalNote(config);
  const first = sampleEvent('demo-event-0001', 'The first committed event.');
  const second = sampleEvent('demo-event-0002', 'The event the crash interrupted.');
  assert.equal(attempt(config, first).duplicate, false);
  const committed = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');

  const result = await spawnKilled(t, { root, config, event: second, kind: 'after-publish', marker: second.event_id, target: path.join(config.vaultRoot, note) });
  assertKilled(result);

  // The publish landed and the process died before it could read the note back, so the new event is
  // live even though the writer never reported success.
  const published = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');
  assert.notEqual(published, committed);
  assert.equal(published.split(`<!-- EVENT:${second.event_id} -->`).length - 1, 1);
  assert.deepEqual(residueOf(config, note), [], 'a published temporary no longer exists');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id, second.event_id]);

  clearLock(config);
  // The retry must recognise what is already committed rather than append it a second time.
  assert.equal(attempt(config, second).duplicate, true);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, note), 'utf8'), published, 'a duplicate retry must not rewrite the note');
  assert.equal(published.split(`<!-- EVENT:${second.event_id} -->`).length - 1, 1, 'the event must not be appended twice');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id, second.event_id]);
});

for (const kind of ['mid-write', 'before-publish', 'after-publish']) {
  test(`a crash while creating a journal note (${kind}) is retried without writing the header twice`, async (t) => {
    const { root, config } = fixture(t);
    const note = journalNote(config);
    const first = sampleEvent('demo-event-0001', 'The only event.');
    const absolute = path.join(config.vaultRoot, note);

    // Nothing has created the note yet, so the first publish to this path is the `create` of the note
    // itself - the boundary where a killed writer would otherwise leave a truncated header behind.
    const marker = kind === 'mid-write' ? 'type: memory-events' : first.event_id;
    const result = await spawnKilled(t, { root, config, event: first, kind, marker, target: absolute });
    assertKilled(result);

    const exists = fs.existsSync(absolute);
    if (kind === 'after-publish') assert.equal(exists, true, 'the create had been published');
    else assert.equal(exists, false, 'the note must not exist when its own publish was interrupted');
    assert.deepEqual(loadEvents(config), []);
    const residue = residueOf(config, note);
    assert.equal(residue.length, kind === 'after-publish' ? 0 : 1);

    clearLock(config);
    assert.equal(attempt(config, first).duplicate, false);
    const recovered = fs.readFileSync(absolute, 'utf8');
    assert.equal(recovered.split('# Agent 增量日志').length - 1, 1, 'the retry must not write the header twice');
    assert.equal(recovered.split(`<!-- EVENT:${first.event_id} -->`).length - 1, 1);
    assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id]);
    // A header that had been flushed but not published is reproduced byte for byte by the retry, which
    // is what keeps an interrupted create idempotent rather than a source of two headers.
    if (kind === 'before-publish') assert.equal(recovered.startsWith(residue[0].text), true, 'the retry must publish the header the crash left flushed');
  });
}

test('a failed publish reports the failure, removes its own temporary and leaves the note untouched', (t) => {
  const { config } = fixture(t);
  const note = journalNote(config);
  const first = sampleEvent('demo-event-0001', 'The first committed event.');
  const second = sampleEvent('demo-event-0002', 'The event the failure interrupted.');
  assert.equal(attempt(config, first).duplicate, false);
  const committed = fs.readFileSync(path.join(config.vaultRoot, note), 'utf8');

  // A write that fails part-way is not a crash: the process is alive, so the failure is reported and
  // the temporary is cleaned up by the code that created it. Only a killed process leaves residue. The
  // hook matches a path-based write to the note as well, which is how an in-place implementation would
  // take this failure - straight into the note, after truncating it.
  const file = path.join(config.vaultRoot, note);
  const real = fs.writeFileSync;
  fs.writeFileSync = function (to, content, ...rest) {
    const name = String(to);
    if ((typeof to === 'number' || name === file || name.startsWith(`${file}.`)) && String(content).includes(second.event_id)) {
      real.call(fs, to, String(content).slice(0, 32));
      const error = new Error('ENOSPC: no space left on device, write');
      error.code = 'ENOSPC';
      throw error;
    }
    return real.call(fs, to, content, ...rest);
  };
  t.after(() => { fs.writeFileSync = real; });

  assert.throws(() => attempt(config, second), /ENOSPC/);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, note), 'utf8'), committed, 'a failed publish must leave the committed events');
  assert.deepEqual(residueOf(config, note), [], 'a failed publish removes its own temporary');
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id]);

  fs.writeFileSync = real;
  assert.equal(attempt(config, second).duplicate, false);
  assert.deepEqual(loadEvents(config).map((event) => event.event_id), [first.event_id, second.event_id]);
});
