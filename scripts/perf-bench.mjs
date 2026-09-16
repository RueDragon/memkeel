// Performance baseline harness (PERF-01).
//
// The plan asks for synthetic datasets at three scales covering long text, duplicated facts, conflicts
// and several workspaces; for P50/P95, peak memory and cold/warm differences across bootstrap, recall,
// search, the dashboard home and detail views, capture and consolidate; and for the correctness of
// reduction to be compared at the same time. It also says to find the bottleneck before optimising and
// not to presuppose a database. So this file measures and reports; it changes no production code.
//
// Two things about method are worth stating, because they are easy to get wrong and would make the
// numbers meaningless:
//
//   1. The dataset is written straight into the journal instead of through `record()`. That is not a
//      shortcut around the code under test — it is a consequence of what the code does. `record()`
//      replays the whole journal and recomputes the preference projection on *every* write, so
//      generating N events through it costs O(N^2). The generator's job is to produce a realistic
//      store, not to time the write path N times; the write path is measured separately, on a few
//      writes, against the finished dataset.
//   2. Cold and warm are measured as separate phases on the same process where possible, and the
//      difference is reported rather than averaged away: "first call after start" is what a user feels.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrap, loadEvents, recallFacts, recallLearning, record, refreshIndex, consolidate } from '../lib/core.mjs';
import { applyLayout } from '../lib/layout.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { accessLogSummary, settingsSnapshot } from '../lib/dashboard-data.mjs';
import { createServer } from '../dashboard.mjs';

export const SCALES = Object.freeze([1000, 10000, 100000]);

/** Deterministic PRNG, so two runs of the same scale are the same dataset. */
function prng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = 'ledger evidence recall projection retention checkpoint workspace topic supersedes conflict digest bootstrap policy store vault session capture'.split(' ');

function sentence(random, words) {
  const out = [];
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(random() * WORDS.length)]);
  return out.join(' ');
}

/**
 * Build a synthetic memory home + store with `events` events.
 *
 * The shape deliberately includes the cases that make reduction expensive rather than only the easy
 * one: many workspaces, some very long context bodies, fact keys that repeat *without* `supersedes`
 * (which is what a conflict is), and keys that repeat *with* `supersedes` (a resolved chain).
 */
export function generate({ events = 1000, workspaces = 8, seed = 20260916, root } = {}) {
  const home = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-perf-'));
  const vaultRoot = path.join(home, 'store');
  const policyRoot = path.join(home, 'home');
  for (const dir of ['events', 'topics', 'projects', 'digest']) fs.mkdirSync(path.join(vaultRoot, dir), { recursive: true });
  fs.mkdirSync(policyRoot, { recursive: true });
  const config = applyLayout({ memoryRoot: vaultRoot, vaultRoot, policyRoot, storage: 'filesystem', layout: 'neutral', vaultName: '', obsidianCli: '', topics: [], workspaceAliases: {} });
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(config, null, 2));
  const transport = createTransport(config);
  transport.create('habits.md', '# Habits\n\n```json\n{"rules":[{"id":"global-cn","status":"confirmed","scope":"global","text":"Reply in Chinese"}]}\n```\n');
  transport.create('digest/evidence.md', '---\ntype: session-closeout\ndate: 2026-09-01\n---\n# Evidence\n\nSynthetic evidence for the performance baseline.\n');

  const random = prng(seed);
  const lanes = Array.from({ length: workspaces }, (_, index) => {
    const id = `perf-${String(index).padStart(2, '0')}`;
    const alias = path.join(home, 'projects', id);
    fs.mkdirSync(alias, { recursive: true });
    const topic = { id: `${id}/perf`, workspace: id, title: `Perf ${index}`, aliases: [], path: `topics/${id}--perf.md` };
    return { id, alias, topic };
  });
  config.topics = lanes.map((lane) => lane.topic);
  config.workspaceAliases = Object.fromEntries(lanes.map((lane) => [lane.id, [lane.alias]]));
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(config, null, 2));

  // Fact keys are drawn from a small pool so that repeats — and therefore conflicts and supersede
  // chains — actually happen at every scale rather than only in theory.
  const keys = Array.from({ length: Math.max(16, Math.floor(events / 8)) }, (_, index) => `perf-key-${index}`);
  const seen = new Map();
  let longBodies = 0; let repeatedKeys = 0; let superseded = 0; let conflicted = 0;

  const byFile = new Map();
  for (let index = 0; index < events; index++) {
    const lane = lanes[index % lanes.length];
    const day = new Date(Date.UTC(2026, 0, 1 + Math.floor(index / 400))).toISOString().slice(0, 10);
    const relative = `${config.eventsRoot}/${day}-${lane.id}-perf.md`;
    if (!byFile.has(relative)) {
      byFile.set(relative, true);
      transport.create(relative, `---\ntype: memory-events\nscope: perf\nworkspace: '${lane.id}'\ndate: ${day}\n---\n# Agent 增量日志\n\n每个事件只追加一次；创建日期不随追加刷新。`);
    }
    const key = keys[Math.floor(random() * keys.length)];
    const prior = seen.get(key);
    const event = {
      event_id: `perf-${String(index).padStart(8, '0')}`,
      workspace: lane.id,
      topic: lane.topic.id,
      agent: 'perf',
      occurred_at: `${day}T00:00:00.000Z`,
      recorded_at: `${day}T00:00:00.000Z`,
      evidence: ['digest/evidence.md'],
      facts: [],
      contexts: [],
      actions: [],
    };
    // Every fourth event carries a long context body, which is the case that stresses the render and
    // injection paths rather than the parse path. "Long" means at the contract's ceiling, not beyond
    // it: `validateLearning` rejects text over 1600 characters, so a dataset that ignored that would
    // be measuring a store this program cannot actually hold.
    if (index % 4 === 0) {
      event.contexts.push({ id: `ctx-${index}`, task: sentence(random, 8).slice(0, 160), text: sentence(random, 150).slice(0, 1500), certainty: 'reported', ttl_days: 30 });
      longBodies += 1;
    }
    // Every sixth event carries a supersede chain link: the new claim explicitly replaces the old one.
    if (prior && index % 6 === 0) {
      event.facts.push({ key, text: `supersedes ${sentence(random, 12)}`, supersedes: prior });
      superseded += 1;
      repeatedKeys += 1;
    } else if (prior) {
      // A repeated key with no `supersedes` is a conflict by definition: the reducer must keep the
      // current claim and report the difference rather than silently overwriting it.
      event.facts.push({ key, text: `differs ${sentence(random, 12)}` });
      conflicted += 1;
      repeatedKeys += 1;
    } else {
      event.facts.push({ key, text: sentence(random, 12) });
    }
    if (index % 5 === 0) event.actions.push({ id: `todo-${index}`, status: index % 10 === 0 ? 'done' : 'open', text: sentence(random, 8) });
    seen.set(key, event.event_id);
    transport.append(relative, `<!-- EVENT:${event.event_id} -->\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\`\n<!-- END-EVENT -->`);
  }

  return {
    home, policyRoot, vaultRoot, config, transport,
    shape: { events, workspaces, longBodies, repeatedKeys, superseded, conflicted, factKeys: keys.length },
  };
}

/** Percentiles from raw samples; no interpolation, so the numbers are observed values. */
export function summarise(samples) {
  if (!samples.length) return { n: 0, p50: null, p95: null, max: null, mean: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    n: sorted.length,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
    mean: Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
  };
}

/** Time one operation. `warmup` calls run first so the first-call cost is reported separately. */
export async function measure(fn, { iterations = 10, warmup = 1 } = {}) {
  const samples = [];
  let firstCall = null;
  for (let index = 0; index < warmup; index++) {
    const started = process.hrtime.bigint();
    await fn();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (firstCall === null) firstCall = Number(ms.toFixed(2));
  }
  for (let index = 0; index < iterations; index++) {
    const started = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  return { ...summarise(samples), firstCall };
}

function storeBytes(dir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? storeBytes(full) : fs.statSync(full).size;
  }
  return bytes;
}

/**
 * Measure every operation the plan lists, plus a correctness reading taken at the same time.
 *
 * `iterations` is scaled down by the caller for the large datasets: a 100k bootstrap is a second-scale
 * operation, and 10 iterations of it would measure patience rather than latency.
 */
export async function runBench({ events = 1000, workspaces = 8, iterations = 10, writes = 10, httpIterations = 5, seed = 20260916, root } = {}) {
  const generated = generate({ events, workspaces, seed, root });
  const { config, transport } = generated;

  // One index build so the read paths have the derived state a real store would have.
  const indexStarted = process.hrtime.bigint();
  refreshIndex(config, { force: true });
  const indexBuildMs = Number(process.hrtime.bigint() - indexStarted) / 1e6;

  const lane = `perf-00`;
  const cwd = path.join(generated.home, 'projects', lane);
  const results = {};

  results['loadEvents (full replay)'] = await measure(() => loadEvents(config), { iterations, warmup: 1 });
  // The scenario a write actually faces: one journal file changed and the journal has to be read
  // again. Measuring only the unchanged case reports the fingerprint cache and says nothing about the
  // cost a write pays. The mutation is a bare newline, which changes the file's size without adding a
  // marker, so the journal stays structurally valid.
  const journalDir = path.join(config.vaultRoot, config.eventsRoot);
  const journalFile = fs.readdirSync(journalDir).filter((name) => name.endsWith('.md')).map((name) => path.join(journalDir, name))[0];
  if (journalFile) {
    results['loadEvents after one file changed'] = await measure(() => {
      fs.appendFileSync(journalFile, '\n');
      return loadEvents(config);
    }, { iterations, warmup: 1 });
  }
  results['refreshIndex (cached)'] = await measure(() => refreshIndex(config), { iterations, warmup: 1 });
  results['refreshIndex (force)'] = await measure(() => refreshIndex(config, { force: true }), { iterations: Math.max(2, Math.floor(iterations / 3)), warmup: 0 });
  results['bootstrap'] = await measure(() => bootstrap(config, cwd, 'ledger evidence'), { iterations, warmup: 1 });
  results['recallFacts'] = await measure(() => recallFacts(config, 'ledger evidence'), { iterations, warmup: 1 });
  results['recallLearning'] = await measure(() => recallLearning(config, { cwd, query: 'ledger evidence' }), { iterations, warmup: 1 });
  results['settingsSnapshot'] = await measure(() => settingsSnapshot(config, { home: generated.home, env: {} }), { iterations, warmup: 1 });
  results['accessLogSummary'] = await measure(() => accessLogSummary(config), { iterations, warmup: 1 });

  // Writes are measured on their own, and separately from generation, precisely because they scale
  // with the size of the journal rather than with the size of the write.
  let writeIndex = 0;
  results['record (write)'] = await measure(() => {
    writeIndex += 1;
    record(config, transport, {
      event_id: `perf-live-${String(writeIndex).padStart(6, '0')}`,
      workspace: lane, topic: `${lane}/perf`, agent: 'perf',
      occurred_at: '2026-09-16T00:00:00.000Z',
      evidence: ['digest/evidence.md'],
      facts: [{ key: 'perf-live-key', text: 'a live write against a large journal' }],
    });
  }, { iterations: writes, warmup: 0 });

  results['consolidate'] = await measure(() => consolidate(config, transport, {}), { iterations: Math.max(2, Math.floor(iterations / 3)), warmup: 0 });

  // The dashboard home and a detail view, through the real server rather than through a guess about
  // what the page would have called.
  const server = createServer(() => config);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await (await fetch(`${base}/api/overview`)).json();
    const detailId = first?.events?.[0]?.event_id ?? first?.events?.[0]?.id ?? null;
    results['http /api/overview'] = await measure(async () => { await (await fetch(`${base}/api/overview`)).text(); }, { iterations: httpIterations, warmup: 1 });
    if (detailId) {
      // The detail view is a query on one route, which is what the console actually calls.
      results['http /api/detail'] = await measure(async () => {
        await (await fetch(`${base}/api/detail?type=event&id=${encodeURIComponent(detailId)}`)).text();
      }, { iterations: httpIterations, warmup: 1 });
    }
    results['http /api/events'] = await measure(async () => { await (await fetch(`${base}/api/events`)).text(); }, { iterations: httpIterations, warmup: 1 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // Correctness at the measured scale, taken from the same dataset the timings came from: a fast
  // projection that dropped supersedes or retention would be a regression, not an optimisation.
  const events_ = loadEvents(config);
  const byKey = new Map();
  const current = new Map();
  let conflicts = 0; let resolved = 0;
  for (const event of [...events_].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id))) {
    for (const fact of event.facts ?? []) {
      if (fact.supersedes) { resolved += 1; current.set(fact.key, { text: fact.text, event_id: event.event_id }); continue; }
      if (current.has(fact.key)) { conflicts += 1; continue; }
      current.set(fact.key, { text: fact.text, event_id: event.event_id });
    }
    byKey.set(event.topic, (byKey.get(event.topic) ?? 0) + 1);
  }

  return {
    scale: { events, workspaces },
    shape: generated.shape,
    home: generated.home,
    // Returned so a caller can re-derive the correctness numbers from the same store the timings came
    // from, instead of trusting the counters this function computed.
    config,
    storeBytes: storeBytes(generated.vaultRoot),
    indexBuildMs: Number(indexBuildMs.toFixed(2)),
    rssBytes: process.memoryUsage().rss,
    iterations: { read: iterations, write: writes, http: httpIterations },
    results,
    correctness: {
      eventsRead: events_.length,
      topics: byKey.size,
      currentFacts: current.size,
      conflicts,
      supersedeLinks: resolved,
      note: '读完整个账本得到的事件数必须等于生成数；冲突数必须等于「重复键且没有 supersedes」的数量。',
    },
  };
}

function pad(value, width) { return String(value).padEnd(width); }

function report(row) {
  const lines = [];
  lines.push(`# scale: ${row.scale.events} events across ${row.scale.workspaces} workspaces`);
  lines.push(`store: ${(row.storeBytes / 1024 / 1024).toFixed(1)} MiB | index build: ${row.indexBuildMs} ms | rss: ${(row.rssBytes / 1024 / 1024).toFixed(0)} MiB`);
  lines.push(`${pad('operation', 28)}${pad('n', 4)}${pad('first', 9)}${pad('p50', 9)}${pad('p95', 9)}${pad('max', 9)}`);
  for (const [label, value] of Object.entries(row.results)) {
    lines.push(`${pad(label, 28)}${pad(value.n, 4)}${pad(value.firstCall ?? '-', 9)}${pad(value.p50 ?? '-', 9)}${pad(value.p95 ?? '-', 9)}${pad(value.max ?? '-', 9)}`);
  }
  const c = row.correctness;
  lines.push(`correctness: events=${c.eventsRead} topics=${c.topics} currentFacts=${c.currentFacts} conflicts=${c.conflicts} supersedes=${c.supersedeLinks}`);
  return lines.join('\n');
}

const isMain = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  const arg = (name, fallback) => {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? Number(hit.split('=')[1]) : fallback;
  };
  const jsonArg = process.argv.find((value) => value.startsWith('--json='));
  const jsonPath = jsonArg ? jsonArg.slice('--json='.length) : null;
  const scales = process.argv.includes('--all') ? SCALES : [arg('events', 1000)];
  const rows = [];
  for (const scale of scales) {
    // Iterations shrink with the scale: a second-scale operation repeated ten times measures patience.
    const iterations = scale >= 100000 ? 3 : scale >= 10000 ? 5 : 10;
    const started = process.hrtime.bigint();
    const row = await runBench({ events: scale, iterations, writes: scale >= 100000 ? 5 : 10, httpIterations: scale >= 100000 ? 3 : 5, seed: arg('seed', 20260916), root: process.env.MEMKEEL_PERF_ROOT || undefined });
    row.wallMs = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(0));
    rows.push(row);
    console.log(report(row));
    console.log('');
  }
  if (jsonPath) {
    fs.writeFileSync(jsonPath, JSON.stringify({ node: process.versions.node, platform: process.platform, arch: process.arch, at: new Date().toISOString(), rows }, null, 2));
    console.log(`wrote ${jsonPath}`);
  }
}
