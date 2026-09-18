// `doctor`'s read-only diagnosis of work that is waiting.
//
// doctor is what a person runs when something looks wrong, so it has to separate three states that
// used to look alike: work waiting to be consumed, work blocked by a lock nobody holds any more, and
// state that cannot be read at all. It also has to say what to do, and it must not promise that pending
// work settles itself while a stale lock is in the way - every writer refuses to enter while that lock
// exists, so the next run cannot consume anything until a human removes it.
//
// Read-only is the other half of the contract, and these tests check it by asserting that the files
// doctor inspected are still there afterwards, byte for byte. A check that clears the lock it just
// reported is not a check.
//
// The fixture uses the documented commands rather than hand-written store files (init, workspace-add,
// register), because that is the sequence the container smoke runs and a failure here reproduces it
// without a container runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const store = path.join(root, 'store');
  const project = path.join(root, 'project');
  for (const dir of [home, store, project]) fs.mkdirSync(dir);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_HOME: home } });
  const init = run('init', '--store', store);
  assert.equal(init.status, 0, init.stderr);

  // A repository, because workspace identity is derived from the repository's common directory.
  const git = spawnSync('git', ['-C', project, 'init', '--quiet'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, `the fixture needs git to register a workspace: ${git.error?.message ?? git.stderr}`);

  const added = run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  const workspace = JSON.parse(added.stdout).id;
  const registered = run('register', '--topic', `${workspace}/ci`, '--workspace', workspace, '--title', 'CI smoke');
  assert.equal(registered.status, 0, registered.stderr);

  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const doctor = () => {
    const result = run('doctor');
    let report = null;
    try { report = JSON.parse(result.stdout); } catch { /* a run that printed no report is judged by its status */ }
    return { status: result.status, report, stdout: result.stdout, stderr: result.stderr };
  };
  // A committed event, written straight into the journal: `record` would also consolidate, and the
  // point of these fixtures is the state doctor finds before anything consumes it.
  const writeEvent = (id) => {
    const note = path.join(store, config.roles.eventsRoot, `2026-09-10-${workspace}-dsh.md`);
    fs.mkdirSync(path.dirname(note), { recursive: true });
    fs.writeFileSync(path.join(store, 'evidence.md'), '# Evidence\n\nA note the event cites.\n');
    const event = { event_id: id, workspace, topic: `${workspace}/ci`, agent: 'dsh', occurred_at: '2026-09-10T03:00:00.000Z', recorded_at: '2026-09-10T03:00:00.000Z',
      evidence: ['evidence.md'], facts: [{ key: 'doctor-pending', text: 'an event waiting to be consumed' }] };
    fs.writeFileSync(note, `---\ntype: memory-events\nscope: dsh\nworkspace: '${workspace}'\ndate: 2026-09-10\n---\n# Agent 增量日志\n\n<!-- EVENT:${id} -->\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\`\n<!-- END-EVENT -->\n`);
    return note;
  };
  // A lock whose recorded holder cannot be running. The pid is above every platform's ceiling, so
  // "provably gone" is a fact rather than a probability, and the host has to match for the check to be
  // allowed to answer at all.
  const writeStaleSetupLock = () => {
    const dir = path.join(home, 'state', 'setup-lock');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'writer.lock');
    fs.writeFileSync(file, `${JSON.stringify({ pid: 2147483646, host: os.hostname(), at: '2026-09-10T03:00:00.000Z', command: 'setup' }, null, 2)}\n`);
    return file;
  };
  return { root, home, store, project, workspace, config, topicPath: JSON.parse(registered.stdout).path, run, doctor, writeEvent, writeStaleSetupLock };
}

const rowFor = (report, needle) => (report.recovery ?? []).find((row) => row.what.includes(needle));

test('a registered topic with no note yet is reported as unbuilt rather than as a broken store', (t) => {
  const { doctor, store, topicPath } = fixture(t);

  // `register` writes the configuration row; consolidation writes the note, once the topic has events to
  // project. A note that does not exist yet is therefore a projection waiting to be built, and calling it
  // a missing file made `register` followed by `doctor` fail on a store that was working as documented.
  const result = doctor();
  assert.equal(result.status, 0, `a store that is merely waiting for its first event must be healthy: ${result.stdout}`);
  assert.deepEqual(result.report.missing, [], 'no required input file is absent');
  assert.deepEqual(result.report.unbuilt, [path.resolve(store, topicPath)], 'the topic note has not been built yet');
  assert.equal(result.report.pending.unbuiltNotes, 1);
  const hint = rowFor(result.report, 'have not been built');
  assert.ok(hint, `the report must say how a projection is built: ${result.stdout}`);
  assert.match(hint.next, /maintenance --rebuild/);
});

test('an event waiting to be consumed is reported as pending, and the documented step clears it', (t) => {
  const { doctor, run, writeEvent, workspace, config, store } = fixture(t);
  writeEvent('20260910-dsh-doctor-pending');

  const waiting = doctor();
  assert.equal(waiting.status, 1, `work waiting to be consumed is not a healthy store: ${waiting.stdout}`);
  assert.equal(waiting.report.ledger.ok, true, 'the journal itself is readable');
  assert.equal(waiting.report.pending.events, 1);
  assert.deepEqual(waiting.report.pending.topics, [`${workspace}/ci`]);
  const hint = rowFor(waiting.report, 'are not consumed yet');
  assert.ok(hint, `the report must name the backlog: ${waiting.stdout}`);
  assert.equal(hint.state, 'pending');
  assert.match(hint.next, /consolidate/);
  // No lock is in the way here, so nothing may be described as blocked.
  assert.equal(waiting.report.recovery.some((row) => row.state === 'blocked'), false, JSON.stringify(waiting.report.recovery));

  // And the advice works: consolidate consumes the backlog and builds the projection it describes.
  assert.equal(run('consolidate').status, 0);
  const settled = doctor();
  assert.equal(settled.status, 0, settled.stdout);
  assert.equal(settled.report.pending.events, 0);
  assert.deepEqual(settled.report.unbuilt, [], 'the topic note exists once its event has been consolidated');
});

test('a stale setup lock blocks the pending work, and doctor neither clears it nor promises self-healing', (t) => {
  const { doctor, writeEvent, writeStaleSetupLock } = fixture(t);
  writeEvent('20260910-dsh-doctor-locked');
  const lock = writeStaleSetupLock();
  const before = fs.readFileSync(lock, 'utf8');

  const result = doctor();
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.report.setupLock.present, true, 'the setup lock has to be visible in the report');
  assert.ok(result.report.setupLock.stale, `a lock whose holder is gone must be reported as stale: ${JSON.stringify(result.report.setupLock)}`);

  const lockHint = rowFor(result.report, 'whose holder is gone');
  assert.ok(lockHint, result.stdout);
  assert.equal(lockHint.state, 'blocked');
  assert.ok(lockHint.what.includes(lock), `the hint must name the file to remove: ${lockHint.what}`);
  assert.match(lockHint.next, /delete/);

  // The backlog is still pending, but it is not self-healing while that lock is in the way: every writer
  // refuses to enter, so the hint has to send the reader to the lock first rather than to consolidate.
  const backlog = rowFor(result.report, 'are not consumed yet');
  assert.ok(backlog, result.stdout);
  assert.equal(backlog.state, 'blocked');
  assert.match(backlog.next, /remove the stale lock first/);
  assert.doesNotMatch(backlog.next, /run consolidate:/);

  // Read-only: the lock doctor just diagnosed is still there, unchanged, and nothing was written beside it.
  assert.equal(fs.readFileSync(lock, 'utf8'), before, 'doctor must not rewrite the lock it reported');
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['writer.lock'], 'and must not leave anything beside it');
});

test('a consumption checkpoint that cannot be read is corruption, not a backlog', (t) => {
  const { doctor, home, writeEvent } = fixture(t);
  writeEvent('20260910-dsh-doctor-corrupt');
  const state = path.join(home, 'state', 'consumed.json');
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, `${JSON.stringify({ hashes: [] }, null, 2)}\n`);
  const before = fs.readFileSync(state, 'utf8');

  const result = doctor();
  // The report has to be produced at all: an unreadable checkpoint used to take down the whole run.
  assert.ok(result.report, `doctor must still report: ${result.stderr}`);
  assert.equal(result.status, 1);
  assert.equal(result.report.pending.events, null, 'the backlog cannot be counted from a checkpoint that cannot be read');
  const hint = rowFor(result.report, 'consolidation checkpoint cannot be read');
  assert.ok(hint, result.stdout);
  assert.equal(hint.state, 'corrupt');
  assert.match(hint.next, /needs a person/);
  assert.equal(fs.readFileSync(state, 'utf8'), before, 'doctor must not repair what it reports');
});

test('a journal that cannot be parsed is reported as corruption instead of failing the command', (t) => {
  const { doctor, store, config } = fixture(t);
  const broken = path.join(store, config.roles.eventsRoot, '2026-09-10-broken.md');
  fs.mkdirSync(path.dirname(broken), { recursive: true });
  fs.writeFileSync(broken, '# Agent 增量日志\n\n<!-- EVENT:20260910-dsh-half-written -->\n');
  const before = fs.readFileSync(broken, 'utf8');

  const result = doctor();
  assert.ok(result.report, `an unreadable journal must still produce the report: ${result.stderr}`);
  assert.equal(result.status, 1);
  assert.equal(result.report.ledger.ok, false);
  assert.match(result.report.ledger.error, /Incomplete journal/);
  const hint = rowFor(result.report, 'event journal cannot be read');
  assert.ok(hint, result.stdout);
  assert.equal(hint.state, 'corrupt');
  // The half-written note is the evidence, and doctor must leave it exactly as it found it: repairing or
  // tidying it here would destroy the only copy of whatever a human has to look at.
  assert.equal(fs.readFileSync(broken, 'utf8'), before, 'doctor must not rewrite the note it could not read');
});
