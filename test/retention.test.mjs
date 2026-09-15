import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyDigestBody } from '../lib/digest.mjs';
import { applyRetention, droppedEventIds, ineligibleReason, retentionCandidates } from '../lib/retention.mjs';

// Regression coverage for the 2026-09-14 conversation-thread digest and the soft
// retention ledger: a multi-turn session must render as one parent node with a
// child per turn, and a nightly judgment must be able to retire a worthless
// checkpoint without deleting an immutable event.

const topic = { id: 'ws/task-context', workspace: 'ws', title: 'ws 近期任务上下文', aliases: [], path: 'topics/task-context.md' };

function checkpoint(turn, session = 'abc123def456') {
  return {
    event_id: `hook-${session}-${turn}-deadbeef`,
    workspace: 'ws',
    topic: topic.id,
    agent: 'dsh',
    occurred_at: `2026-09-14T12:0${turn}:00.000Z`,
    recorded_at: `2026-09-14T12:0${turn}:00.000Z`,
    evidence: [`work/events/Evidence/2026-09-14-ws.md#hook-${session}-${turn}-deadbeef`],
    contexts: [{
      id: `session-${session}`,
      task: `第${turn}个问题`,
      text: `用户输入：第${turn}个问题\n最近回复（未复核，不是当前事实）：第${turn}个回复`,
      certainty: 'reported',
      ttl_days: 30,
    }],
  };
}

function substantial() {
  return {
    event_id: 'agent-written-0001',
    workspace: 'ws',
    topic: topic.id,
    agent: 'dsh',
    occurred_at: '2026-09-14T13:00:00.000Z',
    recorded_at: '2026-09-14T13:00:00.000Z',
    evidence: ['work/events/Evidence/2026-09-14-ws.md#agent-written-0001'],
    facts: [{ key: 'verified-point', text: 'A conclusion that must survive any nightly pass.' }],
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault') };
  fs.mkdirSync(path.join(config.policyRoot, 'state'), { recursive: true });
  return { config };
}

test('a multi-turn session renders as one parent with a child per turn', () => {
  const body = dailyDigestBody([checkpoint(1), checkpoint(2), substantial()], [topic]);
  assert.match(body, /会话线/, 'the session must become a parent node');
  assert.match(body, /（2 轮）/, 'the parent must state how many turns it groups');
  assert.match(body, /#### 第 1\/2 轮/, 'each turn must be a child node');
  assert.match(body, /#### 第 2\/2 轮/);
  assert.match(body, /^### ws 近期任务上下文 · 会话线/m, 'the parent title comes from the topic, not a raw prompt');
  assert.match(body, /^### ws · 第1个问题|^### ws 近期任务上下文\n/m, 'the substantive event keeps its own section');
});

test('a retained turn does not point at a turn that was dropped', () => {
  const first = checkpoint(1);
  const second = checkpoint(2);
  second.contexts[0].supersedes = first.event_id;
  const shown = dailyDigestBody([first, second], [topic]);
  assert.match(shown, /更新自事件/, 'without a retention set the pointer is printed as before');
  const hidden = dailyDigestBody([first, second], [topic], { dropped: new Set([first.event_id]) });
  assert.doesNotMatch(hidden, /更新自事件/, 'a pointer to a dropped turn is suppressed');
  // The single-event rendering path prints its own pointer line and must honour it too.
  assert.match(dailyDigestBody([second], [topic]), /更新自事件/);
  assert.doesNotMatch(dailyDigestBody([second], [topic], { dropped: new Set([first.event_id]) }), /更新自事件/);
});

test('a lone checkpoint is not wrapped in a parent node', () => {
  const body = dailyDigestBody([checkpoint(1)], [topic]);
  assert.doesNotMatch(body, /### [^\n]*· 会话线/, 'a single checkpoint gets no parent heading');
  assert.doesNotMatch(body, /#### 第 1\/1 轮/, 'a single checkpoint gets no child turn nodes');
  assert.match(body, /### ws · 第1个问题/, 'it keeps the plain per-event rendering');
});

test('only automatic conversation checkpoints are droppable', () => {
  assert.equal(ineligibleReason(checkpoint(1)), undefined);
  assert.match(ineligibleReason(substantial()), /carries facts/);
  assert.match(ineligibleReason({ event_id: 'x', workspace: 'ws', topic: topic.id, agent: 'dsh', evidence: [] }), /no conversation context/);
});

test('a drop needs a known event and a reason, and then hides the event', (t) => {
  const { config } = fixture(t);
  const events = [checkpoint(1), checkpoint(2), substantial()];

  assert.throws(() => applyRetention(config, { decisions: [{ event_id: 'hook-abc123def456-1-deadbeef', decision: 'drop' }] }, events), /requires a reason/);
  assert.throws(() => applyRetention(config, { decisions: [{ event_id: 'missing-0001', decision: 'drop', reason: 'x' }] }, events), /Unknown event/);
  assert.throws(() => applyRetention(config, { decisions: [{ event_id: 'agent-written-0001', decision: 'drop', reason: 'boring title' }] }, events), /only automatic conversation checkpoints/);
  assert.equal(fs.existsSync(path.join(config.policyRoot, 'state', 'retention.json')), false, 'a rejected pass must not persist state');

  const applied = applyRetention(config, { decisions: [
    { event_id: 'hook-abc123def456-1-deadbeef', decision: 'drop', reason: 'one-line aside with nothing durable' },
  ] }, events);
  assert.equal(applied.applied, 1);
  assert.equal(applied.dropped, 1);
  assert.deepEqual([...droppedEventIds(config)], ['hook-abc123def456-1-deadbeef']);
});

test('a later pass can flip a drop back to keep, and candidates exclude decided events', (t) => {
  const { config } = fixture(t);
  const events = [checkpoint(1), checkpoint(2)];
  applyRetention(config, { decisions: [{ event_id: 'hook-abc123def456-1-deadbeef', decision: 'drop', reason: 'noise' }] }, events);
  assert.equal(retentionCandidates(config, events).length, 1, 'a decided event is no longer a candidate');

  applyRetention(config, { decisions: [{ event_id: 'hook-abc123def456-1-deadbeef', decision: 'keep', reason: 'turned out to hold the incident timeline' }] }, events);
  assert.equal(droppedEventIds(config).size, 0);
  const remaining = retentionCandidates(config, events).map((row) => row.event_id);
  assert.deepEqual(remaining, ['hook-abc123def456-2-deadbeef'], 'a kept event is decided, so only the untouched turn stays a candidate');
});
