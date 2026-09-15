import test from 'node:test';
import assert from 'node:assert/strict';
import { settleWeight, settleProjection, idleDaysFrom, weightFactor, DEFAULT_WEIGHT } from '../lib/weight.mjs';

test('a read boosts weight by the configured step', () => {
  assert.equal(settleWeight(1, { readsSinceLastPass: 1 }), 1.5);
});

test('boosts are capped per pass so one burst cannot dominate', () => {
  // maxBoostsPerPass default is 2, so 10 reads still yield only 2 boosts.
  assert.equal(settleWeight(1, { readsSinceLastPass: 10 }), 2);
});

test('an idle item decays only after the decay threshold', () => {
  assert.equal(settleWeight(2, { readsSinceLastPass: 0, idleDays: 10 }), 2);
  assert.equal(settleWeight(2, { readsSinceLastPass: 0, idleDays: 31 }), 1.9);
});

test('weight is clamped to floor and ceiling', () => {
  assert.equal(settleWeight(DEFAULT_WEIGHT.ceiling, { readsSinceLastPass: 2 }), DEFAULT_WEIGHT.ceiling);
  assert.equal(settleWeight(DEFAULT_WEIGHT.floor, { readsSinceLastPass: 0, idleDays: 90 }), DEFAULT_WEIGHT.floor);
});

test('a non-finite stored weight falls back to the baseline', () => {
  assert.equal(settleWeight(Number.NaN, { readsSinceLastPass: 0 }), 1);
  assert.equal(settleWeight(undefined, { readsSinceLastPass: 0 }), 1);
});

test('idle time starts from creation when there is no access history', () => {
  // A never-read entry must not decay on its first settlement; idle is measured
  // from its own creation time instead.
  assert.equal(idleDaysFrom(undefined), 0);
  assert.equal(idleDaysFrom('not-a-date'), 0);
  assert.equal(idleDaysFrom(undefined, new Date('2026-09-11T00:00:00Z'), '2026-09-01T00:00:00Z'), 10);
  assert.equal(idleDaysFrom('2026-09-01T00:00:00Z', new Date('2026-09-11T00:00:00Z')), 10);
});

test('projection settlement reports only entries that actually changed', () => {
  const entries = [
    { type: 'facts', id: 'a', topic: 't', weight: 1 },
    { type: 'facts', id: 'b', topic: 't', weight: 2 },
  ];
  const reads = new Map([['facts\u0000a', 1]]);
  const changed = settleProjection(entries, { readsSinceLastPass: reads, lastAccess: new Map(), now: new Date('2026-09-11T00:00:00Z') });
  assert.equal(changed.length, 1);
  assert.equal(changed[0].id, 'a');
  assert.equal(changed[0].before, 1);
  assert.equal(changed[0].after, 1.5);
});

test('weight factor is bounded and never zero', () => {
  assert.equal(weightFactor(1), 1);
  assert.equal(weightFactor(999), DEFAULT_WEIGHT.ceiling);
  assert.equal(weightFactor(0), DEFAULT_WEIGHT.floor);
  assert.equal(weightFactor(-5), DEFAULT_WEIGHT.floor);
});
