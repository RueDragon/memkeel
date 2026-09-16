import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { apply, childEnv } from '../dsh-memory-plugin.mjs';

async function fixture(t, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-hook-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runner = path.join(dir, 'runner.mjs');
  await fs.writeFile(runner, source);
  return { dir, runner };
}

function harness(runner, { timeoutMs = 5000, cwd = os.tmpdir(), signal, text = 'test' } = {}) {
  const handlers = {};
  const warnings = [];
  let nextCalls = 0;
  apply({ on: (name, fn) => { handlers[name] = fn; }, logger: { warn: (value) => warnings.push(value) } }, { runner, timeoutMs });
  const invoke = () => handlers['tools/pre-execute']({
    agent: { session: { header: { id: 'isolated-runner-test', cwd } } },
    name: 'read', arguments: { text }, signal,
  }, async () => { nextCalls++; return { kind: 'continued' }; });
  return { invoke, warnings, nextCalls: () => nextCalls };
}

const readInput = "import fs from 'node:fs'; const input = JSON.parse(fs.readFileSync(0, 'utf8')); ";

test('valid hook output preserves deny decisions', async (t) => {
  const { runner } = await fixture(t, readInput + "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,permissionDecision:'deny',permissionDecisionReason:'fixture'}}));");
  const h = harness(runner);
  assert.deepEqual(await h.invoke(), { kind: 'deny', reason: 'fixture' });
  assert.equal(h.nextCalls(), 0);
  assert.deepEqual(h.warnings, []);
});

test('early child exit during a large stdin write does not crash the host', async (t) => {
  const { runner } = await fixture(t, 'process.exit(0);');
  for (let i = 0; i < 4; i++) {
    const h = harness(runner, { text: 'x'.repeat(1024 * 1024) });
    assert.deepEqual(await h.invoke(), { kind: 'continued' });
    assert.equal(h.warnings.length, 1);
    assert.match(h.warnings[0], /stdin|invalid hook output/);
  }
});

test('empty output includes exit diagnostics', async (t) => {
  const { runner } = await fixture(t, readInput);
  const h = harness(runner);
  await h.invoke();
  assert.match(h.warnings[0], /invalid hook output.*code=0.*stdoutBytes=0/);
});

test('nonzero exit includes bounded stderr and code', async (t) => {
  const { runner } = await fixture(t, readInput + "process.stderr.write('fixture failure'); process.exitCode=7;");
  const h = harness(runner);
  await h.invoke();
  assert.match(h.warnings[0], /code=7.*fixture failure/);
});

test('timeout rejects and removes abort listener', async (t) => {
  const { runner } = await fixture(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const h = harness(runner, { timeoutMs: 100, signal: controller.signal });
  await h.invoke();
  assert.match(h.warnings[0], /timed out/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation rejects and removes abort listener', async (t) => {
  const { runner } = await fixture(t, 'setInterval(() => {}, 1000);');
  const controller = new AbortController();
  const h = harness(runner, { signal: controller.signal });
  const pending = h.invoke();
  controller.abort();
  await pending;
  assert.match(h.warnings[0], /aborted/);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-aborted requests do not spawn a runner', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = harness('missing-runner.mjs', { signal: controller.signal });
  await h.invoke();
  assert.match(h.warnings[0], /aborted before spawn/);
});

test('oversized input is rejected before spawning', async () => {
  const h = harness('missing-runner.mjs', { text: 'x'.repeat(4 * 1024 * 1024) });
  await h.invoke();
  assert.match(h.warnings[0], /exceeds bounded input/);
});

test('spawn failure remains handled', async (t) => {
  const { runner, dir } = await fixture(t, readInput);
  const h = harness(runner, { cwd: path.join(dir, 'missing') });
  assert.deepEqual(await h.invoke(), { kind: 'continued' });
  assert.equal(h.warnings.length, 1);
});

// The rule behind Electron mode, covered on every platform. The integration test below can
// only run under Electron itself, so this is its coverage alternative rather than a mock of
// the spawn path: it pins exactly the decision that test observes end to end.
test('Electron mode adds node mode to a copy, never to the parent environment', () => {
  const base = { PATH: '/usr/bin', ELECTRON_RUN_AS_NODE: undefined };
  const child = childEnv(base, true);
  assert.equal(child.ELECTRON_RUN_AS_NODE, '1');
  assert.notEqual(child, base, 'the parent environment object must not be handed to the child');
  assert.equal(base.ELECTRON_RUN_AS_NODE, undefined, 'the parent must not be mutated');
  assert.equal(base.PATH, '/usr/bin');
});

test('a non-Electron host passes its environment through untouched', () => {
  const base = { PATH: '/usr/bin' };
  const child = childEnv(base, false);
  assert.equal(child, base);
  assert.equal('ELECTRON_RUN_AS_NODE' in child, false);
});

test('an inherited node-mode value is overridden for the child and preserved in the parent', () => {
  const base = { ELECTRON_RUN_AS_NODE: '0' };
  const child = childEnv(base, true);
  assert.equal(child.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(base.ELECTRON_RUN_AS_NODE, '0');
});

// Skipped outside Electron by construction: this asserts the real spawned child, which is
// only reachable when the host process is Electron. See the childEnv tests above for the
// platform-independent coverage of the same rule.
test('Electron hook children use Node mode without changing the parent environment', { skip: !process.versions.electron }, async (t) => {
  const { runner } = await fixture(t, readInput + "console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,permissionDecision:'deny',permissionDecisionReason:process.env.ELECTRON_RUN_AS_NODE}}));");
  const previous = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    const h = harness(runner);
    assert.deepEqual(await h.invoke(), { kind: 'deny', reason: '1' });
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = previous;
  }
});
