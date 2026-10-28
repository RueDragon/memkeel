import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { withQueueMutex } from '../lib/checkpoint-worker.mjs';
import { processHook } from '../lib/hooks.mjs';
import { sha } from '../lib/transport.mjs';

const windows = process.platform === 'win32';
const moduleUrl = new URL('../lib/checkpoint-worker.mjs', import.meta.url).href;
test('kernel queue mutex excludes contenders and releases after killed owner', { skip: !windows }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-kernel-test-'));
  const ready = path.join(root, 'ready');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; import {withQueueMutex} from ${JSON.stringify(moduleUrl)}; withQueueMutex(${JSON.stringify(root)},()=>{fs.writeFileSync(${JSON.stringify(ready)},'ready'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);});`], { windowsHide: true, stdio: 'ignore' });
  t.after(() => { child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'owner acquired mutex');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(withQueueMutex(root, () => assert.fail('second writer entered')).busy, true);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(); await exited;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(withQueueMutex(root, () => 'recovered'), 'recovered');
});
test('kernel owner archives dead legacy lock but refuses a live writer', { skip: !windows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-kernel-test-'));
  try {
    const file = path.join(root, 'writer.lock');
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483646, host: os.hostname() }));
    assert.equal(withQueueMutex(root, () => 'ok'), 'ok');
    assert.equal(fs.existsSync(file), false);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    assert.throws(() => withQueueMutex(root, () => assert.fail()), /still running/);
    assert.equal(fs.existsSync(file), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('real Stop recovers a dead session lock without changing session identity', { skip: !windows }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-session-test-'));
  try {
    const session = 'existing-session';
    const key = sha(`codex\0${session}`).slice(0, 24);
    const sessionRoot = path.join(root, 'state/hook-sessions', key);
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, 'writer.lock'), JSON.stringify({ pid: 2147483646, host: os.hostname() }));
    fs.writeFileSync(path.join(sessionRoot, 'session.json'), JSON.stringify({ revision: 1, injected: [], counts: {}, observations: [], turn: 1, prompt: 'Please remember this verified session lock recovery result.', tools: 1 }));
    const config = { policyRoot: root, vaultRoot: root, topics: [], workRoot: 'work', projectRoot: 'work/projects', eventsRoot: 'work/events', inboxRoot: 'work/inbox', habitsNote: 'work/habits.md' };
    processHook(config, 'codex', { hook_event_name: 'Stop', session_id: session, cwd: root, last_assistant_message: 'result' });
    const state = JSON.parse(fs.readFileSync(path.join(sessionRoot, 'session.json'), 'utf8'));
    assert.equal(state.sessionId, session);
    assert.equal(state.checkpoint.status, 'queued');
    assert.equal(fs.existsSync(path.join(sessionRoot, 'writer.lock')), false);
    assert.equal(fs.readdirSync(path.join(root, 'state/hook-queue')).filter((name) => name.endsWith('.json')).length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
