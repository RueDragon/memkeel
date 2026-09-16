// Coverage for the performance harness (PERF-01).
//
// The plan asks for the correctness of reduction to be compared *at the same time* as the timings, so
// a faster projection that silently dropped a supersede or a retention decision would not read as a
// win. That is what most of this file checks: the synthetic dataset's shape is asserted, and the
// numbers it was built with are re-derived independently from the journal.
//
// It runs at a deliberately small scale. The harness is a measurement tool, not a unit under test, so
// CI verifies that it measures the right thing quickly; the 1k/10k/100k runs are recorded in
// PERFORMANCE.md where the machine and version are stated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generate, runBench, summarise } from '../scripts/perf-bench.mjs';
import { loadEvents } from '../lib/core.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-perf-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** Re-derive the conflict/supersede counts from the journal itself, independently of the generator. */
function recount(events) {
  const current = new Map();
  let conflicts = 0;
  let supersedes = 0;
  for (const event of [...events].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.event_id.localeCompare(b.event_id))) {
    for (const fact of event.facts ?? []) {
      if (fact.supersedes) { supersedes += 1; current.set(fact.key, fact.text); continue; }
      if (current.has(fact.key)) conflicts += 1;
      else current.set(fact.key, fact.text);
    }
  }
  return { conflicts, supersedes, currentFacts: current.size };
}

test('the synthetic dataset has the shape the plan asks for, and the counts are honest', (t) => {
  const root = fixture(t);
  const generated = generate({ events: 120, workspaces: 4, root });
  const shape = generated.shape;
  assert.equal(shape.events, 120);
  assert.equal(shape.workspaces, 4);
  // Long text: some events carry a body near the 1600-character contract ceiling.
  assert.ok(shape.longBodies > 0, 'the dataset must include long bodies');
  // Duplicated fact keys, both resolved (supersedes) and unresolved (conflict).
  assert.ok(shape.repeatedKeys > 0, 'the dataset must contain repeated fact keys');
  assert.ok(shape.superseded > 0, 'the dataset must contain supersede chains');
  assert.ok(shape.conflicted > 0, 'the dataset must contain conflicts');

  const events = loadEvents(generated.config);
  assert.equal(events.length, 120, 'every generated event must be readable and valid');
  // The generator's own counters must match an independent recount of what landed in the journal.
  const counted = recount(events);
  assert.equal(counted.conflicts, shape.conflicted);
  assert.equal(counted.supersedes, shape.superseded);
  // More than one workspace really is present in the journal, not just in the config.
  assert.equal(new Set(events.map((event) => event.workspace)).size, 4);
  // Long bodies survived the round trip at their full length rather than being truncated somewhere.
  const longest = Math.max(...events.map((event) => Math.max(0, ...(event.contexts ?? []).map((row) => row.text.length))));
  assert.ok(longest > 1000, `expected a long context body, longest was ${longest}`);
  assert.ok(longest <= 1600, 'the dataset must stay inside the contract ceiling');
});

test('the same seed produces the same dataset, so a recorded baseline is reproducible', (t) => {
  const a = generate({ events: 60, workspaces: 3, seed: 7, root: fixture(t) });
  const b = generate({ events: 60, workspaces: 3, seed: 7, root: fixture(t) });
  assert.deepEqual(a.shape, b.shape);
  const first = loadEvents(a.config).map((event) => event.event_id).join(',');
  const second = loadEvents(b.config).map((event) => event.event_id).join(',');
  assert.equal(first, second);
  // A different seed is a different dataset, which is what makes the seed worth recording.
  const other = generate({ events: 60, workspaces: 3, seed: 8, root: fixture(t) });
  assert.notDeepEqual(other.shape, a.shape);
});

test('a measurement reports observed percentiles, not interpolated ones', () => {
  const row = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(row.n, 10);
  assert.equal(row.p50, 6, 'the median is an observed sample');
  assert.equal(row.p95, 10);
  assert.equal(row.max, 10);
  assert.equal(row.mean, 5.5);
  assert.deepEqual(summarise([]), { n: 0, p50: null, p95: null, max: null, mean: null });
});

test('the harness measures every operation the plan lists, and checks reduction at the same time', async (t) => {
  const root = fixture(t);
  const row = await runBench({ events: 80, workspaces: 4, iterations: 2, writes: 3, httpIterations: 2, root });

  // The operations the plan names: bootstrap, recall, search, the home page and a detail view,
  // capture/write, and consolidate — plus the journal replay they all sit on.
  for (const label of ['loadEvents (full replay)', 'refreshIndex (cached)', 'bootstrap', 'recallFacts', 'recallLearning', 'settingsSnapshot', 'record (write)', 'consolidate', 'http /api/overview', 'http /api/detail', 'http /api/events']) {
    assert.ok(row.results[label], `${label} must be measured`);
    assert.equal(typeof row.results[label].p50, 'number');
    assert.ok(row.results[label].p95 >= row.results[label].p50);
  }
  assert.equal(row.results['record (write)'].n, 3);
  assert.ok(row.storeBytes > 0);
  assert.ok(row.rssBytes > 0);
  assert.equal(row.shape.events, 80);

  // Correctness taken from the same dataset the timings came from: the live writes the harness made
  // are all readable, and the conflict/supersede counts still match what the generator claimed.
  const counted = recount(loadEvents(row.config));
  assert.ok(row.correctness.eventsRead >= 80, 'the writes the harness made must also be readable');
  assert.equal(row.correctness.conflicts, counted.conflicts);
  assert.equal(row.correctness.supersedeLinks, counted.supersedes);
  assert.equal(row.correctness.currentFacts, counted.currentFacts);
});
