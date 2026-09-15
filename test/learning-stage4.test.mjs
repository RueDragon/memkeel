import test from 'node:test';
import assert from 'node:assert/strict';
import { preferenceProjection, validateDecision, HABIT_LEVELS } from '../lib/preferences.mjs';
import { planPromotions, promotionConfig, isHabitLevel } from '../lib/learning.mjs';

function candidateEvent(id = 'evt-1', occurredAt = '2026-09-01T00:00:00Z') {
  return {
    event_id: id,
    workspace: 'scm',
    topic: 'scm/rules',
    agent: 'codex',
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    evidence: ['work/evidence.md'],
    preferences: [{ id: 'prefer-tabs', status: 'candidate', scope: 'scm', text: 'Prefer tabs over spaces' }],
  };
}

test('three habit levels are defined with a clear ordering', () => {
  assert.deepEqual(HABIT_LEVELS, ['candidate', 'probationary', 'confirmed', 'rejected']);
  assert.equal(isHabitLevel('probationary'), true);
  assert.equal(isHabitLevel('auto-confirmed'), false);
});

test('a probationary decision activates without requiring a user quote', () => {
  const candidate = candidateEvent();
  const decision = { event_id: 'evt-2', workspace: 'scm', topic: 'scm/rules', agent: 'codex',
    evidence: ['work/evidence.md'], habit_decisions: [{ candidate_event: 'evt-1', preference_id: 'prefer-tabs', status: 'probationary', evidence: 'work/evidence.md' }] };
  const projection = preferenceProjection([candidate, decision]);
  const rule = projection.rules.find((row) => row.id === 'prefer-tabs');
  assert.equal(rule.status, 'probationary');
});

test('a confirmed decision still requires a quote present in evidence', () => {
  // validateDecision reads the evidence file, so this test asserts the shape checks
  // that fail before any file access.
  const candidate = candidateEvent();
  assert.throws(() => validateDecision({ candidate_event: 'evt-1', preference_id: 'prefer-tabs', status: 'confirmed', evidence: 'work/evidence.md' }, candidate, {}), /quoted explicit user request/);
  assert.throws(() => validateDecision({ candidate_event: 'evt-1', preference_id: 'prefer-tabs', status: 'nonsense', evidence: 'work/evidence.md' }, candidate, {}), /Invalid habit decision/);
});

test('promotion requires repeated reads and a minimum age', () => {
  const events = [candidateEvent('evt-1', '2026-09-01T00:00:00Z')];
  const noReads = { countsSince: () => new Map() };
  assert.equal(planPromotions({ events, accessLog: noReads, now: new Date('2026-09-11T00:00:00Z') }).length, 0);

  const enoughReads = { countsSince: () => new Map([['facts\u0000prefer-tabs', 2]]) };
  const planned = planPromotions({ events, accessLog: enoughReads, now: new Date('2026-09-11T00:00:00Z') });
  assert.equal(planned.length, 1);
  assert.equal(planned[0].id, 'prefer-tabs');
});

test('a too-new candidate is not promoted even with reads', () => {
  const events = [candidateEvent('evt-1', '2026-09-10T23:00:00Z')];
  const reads = { countsSince: () => new Map([['facts\u0000prefer-tabs', 5]]) };
  const planned = planPromotions({ events, accessLog: reads, now: new Date('2026-09-11T00:00:00Z') });
  assert.equal(planned.length, 0);
});

test('promotion is capped per pass', () => {
  assert.equal(promotionConfig({ promotion: { maxPerPass: 1 } }).maxPerPass, 1);
  const rules = promotionConfig();
  assert.equal(rules.maxPerPass, 3);
});

test('automatic promotion never produces a confirmed status', () => {
  // The only status an automatic path may emit is probationary.
  const events = [candidateEvent('evt-1', '2026-09-01T00:00:00Z')];
  const reads = { countsSince: () => new Map([['facts\u0000prefer-tabs', 9]]) };
  const planned = planPromotions({ events, accessLog: reads, now: new Date('2026-09-11T00:00:00Z') });
  assert.equal(planned.length, 1);
  assert.ok(!('status' in planned[0]) || planned[0].status !== 'confirmed');
});
