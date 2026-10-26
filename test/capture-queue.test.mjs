import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { submitCapture, captureStatus, drainCaptures } from '../lib/capture-queue.mjs';
import { capture } from '../lib/lifecycle.mjs';
import { loadEvents, consolidate, registerTopic, bootstrap, recall } from '../lib/core.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { initStore } from '../lib/init.mjs';
import { loadConfig } from '../lib/config.mjs';
import { atomicJson, withLock } from '../lib/transport.mjs';

function fixture(t) {
  const scratch = path.join(os.tmpdir(), 'agent-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'memkeel-reliability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const vault = path.join(root, 'vault');
  initStore({ home, store: vault });
  const config = loadConfig(home).config;
  config.topics = [{ id: 'demo/reliability', workspace: 'demo', title: 'Reliability', aliases: ['reliability'], path: 'topics/demo.md' }];
  atomicJson(path.join(home, 'config.json'), config);
  fs.writeFileSync(path.join(vault, config.projectRoot, 'workspace-demo.md'), `---\nworkspace: ${root.replaceAll('\\', '/')}\nproject: Demo\nstatus: active\n---\n# Demo`);
  const input = { event_id: 'queue-event-0001', workspace: 'demo', topic: 'demo/reliability', agent: 'codex',
    facts: [{ key: 'reliability', text: 'Synthetic verification completed.' }] };
  const evidence = 'Synthetic source inspected and the expected result checked.';
  return { root, home, config, transport: createTransport(config), input, evidence };
}

const tree = (root) => fs.readdirSync(root, { recursive: true }).filter((name) => fs.statSync(path.join(root, name)).isFile())
  .map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]);
const transient = () => Object.assign(new Error('Synthetic temporary IO'), { code: 'EIO' });
const proxy = (transport, changes) => new Proxy(transport, { get(target, name) { return changes[name] ?? (typeof target[name] === 'function' ? target[name].bind(target) : target[name]); } });

test('capture queue is durable and idempotent before any vault side effect; batch consolidates once', (t) => {
  const { config, transport, input, evidence } = fixture(t);
  const before = tree(config.vaultRoot);
  const first = submitCapture(config, JSON.stringify({ ...input, evidence_text: evidence }));
  assert.equal(first.status, 'queued');
  assert.equal(first.recorded, false);
  assert.equal(submitCapture(config, input, evidence).duplicate, true);
  assert.deepEqual(tree(config.vaultRoot), before);
  assert.throws(() => submitCapture(config, { ...input, facts: [{ key: 'reliability', text: 'Changed' }] }, evidence), /different/);
  submitCapture(config, { ...input, event_id: 'queue-event-0002' }, evidence);
  let consolidations = 0;
  config.spawnSync = () => { throw new Error('No CLI or external process is allowed by this filesystem fixture'); };
  const result = drainCaptures(config, createTransport(config), { consolidateBatch(...args) { consolidations++; return consolidate(...args); } });
  assert.equal(result.processed, 2);
  assert.deepEqual(result.errors, []);
  assert.equal(consolidations, 1);
  assert.equal(loadEvents(config).length, 2);
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
  assert.equal(captureStatus(config, input.event_id).view, 'not_required');
  assert.equal(drainCaptures(config, transport).processed, 0);
});

test('invalid and secret captures have no registration, queue, plan or evidence side effects', (t) => {
  const { root, config, input, evidence } = fixture(t);
  const before = tree(root);
  for (const event of [{ ...input, event_id: '../invalid', topic: 'demo/new-topic' },
    { ...input, topic: 'demo/new-topic', facts: [{ key: 'reliability', text: 'password: SyntheticSecret-123' }] },
    { ...input, evidence: ['missing-proof.md'] }]) {
    assert.throws(() => submitCapture(config, event, evidence));
    assert.throws(() => capture(config, createTransport(config), event, evidence));
  }
  assert.deepEqual(tree(root), before);
});

test('temporary failures persist backoff across fresh consumers and stop at a bounded attempt limit', (t) => {
  const { config, transport, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  const broken = proxy(transport, { create() { throw transient(); } });
  const now = Date.now();
  drainCaptures(config, broken, { now, maxAttempts: 2 });
  const first = captureStatus(config, input.event_id);
  assert.equal(first.status, 'queued');
  assert.equal(first.attempts, 1);
  assert.equal(drainCaptures(config, broken, { now: now + 500 }).processed, 0);
  assert.equal(captureStatus(config, input.event_id).attempts, 1);
  drainCaptures(config, broken, { now: Date.parse(first.nextAttemptAt), maxAttempts: 2 });
  assert.equal(captureStatus(config, input.event_id).status, 'needs_attention');
  assert.equal(captureStatus(config, input.event_id).failure.exhausted, true);
});

test('permanent failures are isolated and do not block later captures', (t) => {
  const { home, config, transport, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  submitCapture(config, { ...input, event_id: 'queue-event-0002' }, evidence);
  const file = path.join(home, 'state/capture-queue', input.event_id + '.json');
  const row = JSON.parse(fs.readFileSync(file));
  row.input.facts[0].text = 'Tampered after submission';
  atomicJson(file, row);
  const result = drainCaptures(config, transport);
  assert.equal(result.errors.length, 1);
  assert.equal(captureStatus(config, input.event_id).status, 'needs_attention');
  assert.equal(captureStatus(config, 'queue-event-0002').status, 'ready');
  assert.equal(loadEvents(config).length, 1);
});

test('partial journal success is reported as recorded, not queued-only; retry completes without duplication', (t) => {
  const { config, transport, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  let failed = false;
  const partial = proxy(transport, { append(relative, content) {
    transport.append(relative, content);
    if (content.includes('<!-- EVENT:') && !failed) { failed = true; throw transient(); }
  } });
  drainCaptures(config, partial);
  const first = captureStatus(config, input.event_id);
  assert.equal(first.status, 'recorded');
  assert.equal(first.disk, 'recorded');
  assert.equal(loadEvents(config).length, 1);
  drainCaptures(config, transport, { now: Date.parse(first.nextAttemptAt) });
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
  assert.equal(loadEvents(config).length, 1);
});

test('projection failure keeps recorded receipt and batch retry completes safely', (t) => {
  const { config, transport, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  drainCaptures(config, transport, { consolidateBatch() { throw transient(); } });
  const first = captureStatus(config, input.event_id);
  assert.equal(first.status, 'recorded');
  drainCaptures(config, transport, { now: Date.parse(first.nextAttemptAt) });
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
});

test('strict Obsidian read failure retains disk evidence and reports unhealthy view without fallback', (t) => {
  const { config, input, evidence } = fixture(t);
  config.storage = 'obsidian-cli'; config.obsidianCli = 'synthetic-cli'; config.vaultName = 'synthetic';
  let reads = 0;
  config.spawnSync = () => { reads++; return { status: 1, stdout: '', stderr: 'Synthetic closed application' }; };
  submitCapture(config, input, evidence);
  drainCaptures(config, createTransport(config));
  const status = captureStatus(config, input.event_id);
  assert.ok(reads > 0);
  assert.equal(status.status, 'queued');
  assert.equal(status.view, 'unhealthy');
  assert.equal(status.recorded, false);
  assert.ok(tree(config.vaultRoot).some(([name]) => name.includes('Evidence')));
  assert.equal(loadEvents(config).length, 0);
});

test('read status/bootstrap/recall do not mutate queue, receipts or vault, and pending topics are stale', (t) => {
  const { root, config, transport, input, evidence } = fixture(t);
  capture(config, transport, input, evidence);
  submitCapture(config, { ...input, event_id: 'queue-event-0002' }, evidence);
  const before = tree(root);
  captureStatus(config);
  const boot = bootstrap(config, root, 'reliability');
  assert.equal(boot.consumption.queued, 1);
  const result = recall(config, 'reliability', 'demo');
  assert.equal(result[0].stale, true);
  assert.deepEqual(tree(root), before);
});

test('topic registration refreshes stale caller configuration and is idempotent without duplicate topics', (t) => {
  const { config } = fixture(t);
  const other = JSON.parse(JSON.stringify(config));
  const input = { id: 'demo/concurrent', workspace: 'demo', title: 'Concurrent' };
  registerTopic(config, input);
  registerTopic(other, input);
  assert.equal(other.topics.filter((row) => row.id === input.id).length, 1);
  assert.throws(() => registerTopic(other, { ...input, title: 'Different' }), /different metadata/);
});

const queueModule = new URL('../lib/capture-queue.mjs', import.meta.url).href;
const configModule = new URL('../lib/config.mjs', import.meta.url).href;
function run(code, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; }); child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `Child exit ${code}`)));
  });
}

test('concurrent processes submit identical input once and consumers preserve a single immutable event', async (t) => {
  const { home, config, input, evidence } = fixture(t);
  const submit = `import {submitCapture} from ${JSON.stringify(queueModule)}; import {loadConfig} from ${JSON.stringify(configModule)}; console.log(JSON.stringify(submitCapture(loadConfig(process.argv[1]).config, JSON.parse(process.argv[2]), process.argv[3])));`;
  await Promise.all([run(submit, [home, JSON.stringify(input), evidence]), run(submit, [home, JSON.stringify(input), evidence])]);
  assert.equal(captureStatus(config).receipts.length, 1);
  const consume = `import {drainCaptures} from ${JSON.stringify(queueModule)}; import {loadConfig} from ${JSON.stringify(configModule)}; try { drainCaptures(loadConfig(process.argv[1]).config); } catch (error) { if (!/Writer locked/.test(error.message)) throw error; }`;
  await Promise.all([run(consume, [home]), run(consume, [home])]);
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
  assert.equal(loadEvents(config).length, 1);
});

test('fresh CLI process resumes queued work without an Obsidian installation', (t) => {
  const { home, config, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../memory.mjs', import.meta.url)), 'capture-drain', '--home', home], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
});

test('Windows v2 state locks recover killed holders, while legacy safety remains in the lock suite', { skip: process.platform !== 'win32' }, async (t) => {
  const { home } = fixture(t);
  const lockRoot = path.join(home, 'state');
  const module = new URL('../lib/transport.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withLock} from ${JSON.stringify(module)}; withLock(process.argv[1], () => { console.log('held'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000); });`, lockRoot], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill(); } catch {} });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); });
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(withLock(lockRoot, () => 'recovered'), 'recovered');
});
