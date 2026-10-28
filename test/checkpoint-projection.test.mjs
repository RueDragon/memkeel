import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initStore } from '../lib/init.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { capture } from '../lib/lifecycle.mjs';
import { submitCapture, captureStatus } from '../lib/capture-queue.mjs';
import { drainPendingProjection, runCheckpointWorker } from '../lib/checkpoint-worker.mjs';
import { loadEvents, consumptionStatus, consolidate } from '../lib/core.mjs';
import { atomicJson } from '../lib/transport.mjs';

function fixture(t) {
  const scratch = path.join(os.tmpdir(), 'agent-scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'memkeel-projection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  initStore({ home, store: path.join(root, 'vault') });
  const config = loadConfig(home).config;
  config.topics = [{ id: 'demo/reliability', workspace: 'demo', title: 'Reliability', aliases: [], path: 'topics/demo.md' }];
  atomicJson(path.join(home, 'config.json'), config);
  const input = { event_id: 'projection-event-0001', workspace: 'demo', topic: 'demo/reliability', agent: 'codex',
    contexts: [{ id: 'worker-task', task: 'Synthetic task', text: 'Important conclusion: the worker must retry transient projection failures because the journal is already recorded.', certainty: 'reported', ttl_days: 30 }] };
  return { home, config, input, evidence: 'Synthetic isolated verification only.' };
}

function failingProjection(config, beforeManaged) {
  const transport = createTransport(config);
  return new Proxy(transport, { get(target, name) {
    if (name === 'managed') return (...args) => { beforeManaged(...args); return target.managed(...args); };
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
}
const transient = () => Object.assign(new Error('Synthetic temporary projection IO'), { code: 'EIO' });

test('worker waits for capture projection backoff and reaches ready without another hook', (t) => {
  const { home, config, input, evidence } = fixture(t);
  submitCapture(config, input, evidence);
  const start = Date.now(); let at = start;
  const attempts = []; const waits = [];
  const result = runCheckpointWorker(home, {
    now: () => at,
    transportFactory: (current) => failingProjection(current, (relative) => {
      if (relative !== 'topics/demo.md') return;
      attempts.push(at);
      if (attempts.length <= 2) throw transient();
    }),
    sleep(delay) {
      const receipt = captureStatus(config, input.event_id);
      assert.equal(receipt.status, 'recorded');
      assert.equal(receipt.attempts, waits.length + 1);
      assert.equal(Date.parse(receipt.nextAttemptAt) - at, delay);
      waits.push(delay); at += delay;
    },
  });
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(attempts, [start, start + 1000, start + 3000]);
  assert.equal(result.state, 'idle');
  assert.equal(captureStatus(config, input.event_id).status, 'ready');
  assert.equal(loadEvents(config).length, 1);
});

test('checkpoint projection retry survives interruption and a fresh worker respects its deadline', (t) => {
  const { home, config, input, evidence } = fixture(t);
  const start = Date.now(); let at = start;
  const attempts = [];
  const rowFile = path.join(home, 'state/hook-queue', input.event_id + '.json');
  atomicJson(rowFile, { id: input.event_id, at: new Date(start).toISOString(), status: 'pending',
    host: 'codex', workspace: 'demo', cwd: home, task: input.contexts[0].task, context: input.contexts[0].text,
    capture: { event: input, evidence_text: evidence } });
  const transportFactory = (current) => failingProjection(current, (relative) => {
    if (relative !== 'topics/demo.md') return;
    attempts.push(at);
    if (attempts.length === 1) throw transient();
  });
  assert.throws(() => runCheckpointWorker(home, { now: () => at, transportFactory,
    sleep() { throw new Error('Synthetic worker interruption'); } }), /Synthetic worker interruption/);
  assert.equal(JSON.parse(fs.readFileSync(rowFile, 'utf8')).status, 'consumed');
  assert.equal(consumptionStatus(config, loadEvents(config)).pending, 1);
  const retryFile = path.join(home, 'state/checkpoint-projection.json');
  const retry = JSON.parse(fs.readFileSync(retryFile, 'utf8'));
  assert.equal(retry.attempts, 1);
  assert.equal(Date.parse(retry.nextAttemptAt), start + 1000);
  at++;
  const waits = [];
  const result = runCheckpointWorker(home, { now: () => at, transportFactory,
    sleep(delay) { assert.equal(attempts.length, 1); waits.push(delay); at += delay; } });
  assert.deepEqual(waits, [999]);
  assert.deepEqual(attempts, [start, start + 1000]);
  assert.equal(result.state, 'idle');
  assert.equal(consumptionStatus(config, loadEvents(config)).pending, 0);
  assert.equal(loadEvents(config).length, 1);
});

test('checkpoint projection stops after six transient failures, including on a fresh worker', (t) => {
  const { home, config, input, evidence } = fixture(t);
  capture(config, createTransport(config), input, evidence, { deferConsolidation: true });
  let at = Date.now(); let calls = 0;
  const transportFactory = (current) => failingProjection(current, () => { calls++; throw transient(); });
  const options = { now: () => at, transportFactory, sleep(delay) { at += delay; } };
  assert.equal(runCheckpointWorker(home, options).state, 'needs_attention');
  assert.equal(calls, 6);
  assert.equal(runCheckpointWorker(home, options).state, 'needs_attention');
  assert.equal(calls, 6);
  const retry = JSON.parse(fs.readFileSync(path.join(home, 'state/checkpoint-projection.json'), 'utf8'));
  assert.equal(retry.failure.exhausted, true);
  assert.equal(retry.nextAttemptAt, null);
  consolidate(config, createTransport(config));
  assert.equal(runCheckpointWorker(home, options).state, 'idle');
  assert.equal(calls, 6);
});

test('permanent projection errors stop once and never persist sensitive exception text', (t) => {
  const { home, config, input, evidence } = fixture(t);
  capture(config, createTransport(config), input, evidence, { deferConsolidation: true });
  let calls = 0;
  const transport = failingProjection(config, () => { calls++; throw new Error('Synthetic sensitive exception detail'); });
  const first = drainPendingProjection(config, transport);
  assert.equal(first.status, 'needs_attention');
  assert.equal(first.failure.kind, 'permanent');
  assert.equal(drainPendingProjection(config, transport).status, 'needs_attention');
  assert.equal(calls, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(home, 'state/checkpoint-projection.json'), 'utf8'), /sensitive exception detail/);
});
