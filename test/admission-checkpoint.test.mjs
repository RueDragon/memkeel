import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHook } from '../lib/hooks.mjs';
import { retryCheckpoint, reconcileSkippedCheckpoint } from '../lib/checkpoints.mjs';
import { loadEvents, record } from '../lib/core.mjs';
import { capture } from '../lib/lifecycle.mjs';
import { sha } from '../lib/transport.mjs';

function fixture(t, { collection = undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-admission-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = {
    policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work',
    projectRoot: 'work/projects', inboxRoot: 'work/inbox', eventsRoot: 'work/events', habitsNote: 'work/habits.md',
    actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', experienceNote: 'work/experience.md',
    preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics: [],
    ...(collection ? { collection } : {}),
  };
  fs.mkdirSync(path.join(config.vaultRoot, config.projectRoot), { recursive: true });
  fs.mkdirSync(path.join(config.vaultRoot, config.eventsRoot), { recursive: true });
  fs.mkdirSync(path.join(config.vaultRoot, config.inboxRoot), { recursive: true });
  fs.mkdirSync(path.join(config.vaultRoot, 'work'), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n');
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  const cwd = path.join(root, 'repo'); fs.mkdirSync(cwd);
  const transport = {
    create(relative, content) { const file = path.join(config.vaultRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); },
    append(relative, content) { fs.appendFileSync(path.join(config.vaultRoot, relative), `\n\n${content}`); },
    verify(relative) { return fs.readFileSync(path.join(config.vaultRoot, relative), 'utf8'); },
    managed(relative, header, body) { const file = path.join(config.vaultRoot, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${header}\n${body}`); },
  };
  const queue = path.join(config.policyRoot, 'state', 'hook-queue');
  fs.mkdirSync(queue, { recursive: true });
  return { root, config, cwd, transport, queue };
}

test('low-value automatic hook turn is not persisted to the checkpoint queue', (t) => {
  const { config, cwd, queue } = fixture(t);
  processHook(config, 'claude', { hook_event_name: 'UserPromptSubmit', session_id: 'low', cwd, prompt: 'ok' });
  processHook(config, 'claude', { hook_event_name: 'Stop', session_id: 'low', cwd, last_assistant_message: 'thanks' });
  assert.deepEqual(fs.readdirSync(queue), []);
  const session = path.join(config.policyRoot, 'state', 'hook-sessions', sha('claude\0low').slice(0, 24), 'session.json');
  assert.equal(JSON.parse(fs.readFileSync(session, 'utf8')).checkpoint.reason, 'low-importance');
});

test('explicit retry refuses a secret-bearing checkpoint without changing its payload', (t) => {
  const { config, transport, queue } = fixture(t);
  const id = `hook-${'a'.repeat(24)}-1-${'b'.repeat(10)}`;
  const row = {
    id, host: 'claude', cwd: 'C:/repo', workspace: 'repo', at: '2026-10-27T00:00:00.000Z',
    context: 'private evidence', task: 'remember this', status: 'needs_attention', attempts: 1,
    capture: { event: {}, evidence_text: 'password: fakevalue' },
  };
  const file = path.join(queue, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(row));
  const before = fs.readFileSync(file);
  assert.throws(() => retryCheckpoint(config, transport, id), /Possible secret/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(loadEvents(config).length, 0);
});

test('explicit retry has a bounded attempt count and requires needs_attention state', (t) => {
  const { config, transport, queue } = fixture(t);
  const id = `hook-${'c'.repeat(24)}-1-${'d'.repeat(10)}`;
  const file = path.join(queue, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, status: 'needs_attention', attempts: 6 }));
  assert.throws(() => retryCheckpoint(config, transport, id), /retry limit/);
  fs.writeFileSync(file, JSON.stringify({ id, status: 'consumed', attempts: 1 }));
  assert.throws(() => retryCheckpoint(config, transport, id), /needs_attention/);
});

test('explicit retry respects collection-off and holds the original payload', (t) => {
  const { config, transport, queue } = fixture(t, { collection: { enabled: false } });
  const id = `hook-${'e'.repeat(24)}-1-${'f'.repeat(10)}`;
  const row = { id, host: 'claude', cwd: 'C:/repo', workspace: 'repo', at: '2026-10-27T00:00:00.000Z',
    context: 'important result and verified correction', task: 'fix the regression', status: 'needs_attention', attempts: 1 };
  const file = path.join(queue, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(row));
  const result = retryCheckpoint(config, transport, id);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.held, 1);
  assert.equal(after.status, 'held');
  assert.equal(after.context, row.context);
  assert.equal(loadEvents(config).length, 0);
});

test('a checkpoint already present in the ledger is consumed without a duplicate append', (t) => {
  const { config, transport, cwd, queue } = fixture(t);
  const id = `hook-${'1'.repeat(24)}-1-${'2'.repeat(10)}`;
  const topic = 'repo/task-context';
  config.topics = [{ id: topic, workspace: 'repo', title: 'Task context', aliases: [], path: 'work/projects/task-context.md' }];
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(config.vaultRoot, 'work/projects/workspace-repo.md'), `---\nworkspace: ${cwd.replaceAll('\\', '/')}\nproject: repo\nstatus: active\n---\n# repo`);
  const event = { event_id: id, workspace: 'repo', topic, agent: 'claude', occurred_at: '2026-10-27T00:00:00.000Z',
    contexts: [{ id: 'turn-1', task: 'adapter result', text: 'Confirmed a durable adapter contract.' }] };
  record(config, transport, { ...event, evidence: [config.habitsNote] });
  const row = { id, host: 'claude', cwd, workspace: 'repo', at: event.occurred_at, task: 'adapter result',
    context: 'Confirmed a durable adapter contract.', status: 'needs_attention', attempts: 1 };
  const file = path.join(queue, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify(row));
  const beforeEvents = loadEvents(config).length;
  const result = retryCheckpoint(config, transport, id);
  assert.equal(result.processed, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'consumed');
  assert.equal(loadEvents(config).length, beforeEvents);
});

test('capture no-record flag blocks even an explicit manual capture before persistence', (t) => {
  const { config, transport } = fixture(t);
  assert.deepEqual(capture(config, transport, { event_id: 'explicit-no-record', noRecord: true }, 'synthetic note', { explicit: true }),
    { status: 'skipped', recorded: false, reason: 'no-record' });
  assert.equal(fs.existsSync(path.join(config.policyRoot, 'state/captures.json')), false);
  assert.equal(loadEvents(config).length, 0);
});

test('explicit reconciliation only repairs an unrecorded false-consumed low-value capture and is byte-idempotent', (t) => {
  const { config, queue } = fixture(t);
  const id = `hook-${'3'.repeat(24)}-1-${'4'.repeat(10)}`;
  const file = path.join(queue, `${id}.json`);
  config.topics = [{ id: 'repo/task-context', workspace: 'repo', title: 'Task context', aliases: [] }];
  const row = { id, status: 'consumed', consumedAt: '2026-10-28T00:00:00.000Z',
    capture: { event: { event_id: id, workspace: 'repo', topic: 'repo/task-context', agent: 'claude',
      contexts: [{ id: 'turn-1', task: 'ok', text: 'thanks' }] }, evidence_text: 'Synthetic checkpoint evidence.' } };
  fs.writeFileSync(file, JSON.stringify({ ...row, event_id: 'claimed-event' }));
  assert.throws(() => reconcileSkippedCheckpoint(config, id), /empty event_id/);
  fs.writeFileSync(file, JSON.stringify(row));
  assert.throws(() => reconcileSkippedCheckpoint({ ...config, collection: { enabled: false } }, id), /revalidated low-importance/);
  assert.deepEqual(reconcileSkippedCheckpoint(config, id), { status: 'skipped', reason: 'low-importance', changed: true });
  const before = fs.readFileSync(file);
  assert.deepEqual(JSON.parse(before).capture, row.capture);
  assert.deepEqual(reconcileSkippedCheckpoint(config, id), { status: 'skipped', reason: 'low-importance', changed: false });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(loadEvents(config).length, 0);
});
