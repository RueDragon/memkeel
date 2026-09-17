#!/usr/bin/env node
/**
 * Measures `consolidate` on a settled synthetic store, for two pending shapes, and can profile the
 * measured call. `scripts/perf-bench.mjs` times a store end to end; this isolates the one call whose
 * cost is hardest to attribute, because its inputs (how many events are pending, and how many distinct
 * days they span) change what it does far more than the store size does.
 *
 *   node scripts/perf-consolidate.mjs --events=8000                 # both shapes, timed
 *   node scripts/perf-consolidate.mjs --events=8000 --profile=out.cpuprofile
 *
 * The profile is taken with node:inspector around the measured call only. A whole-process `--cpu-prof`
 * is mostly the generator and the settle, which drowns the signal it is supposed to show.
 *
 *   one — one consumed hash removed, so a single event is pending (one pending day)
 *   all — consumed.json deleted, so every event is pending (events / 400 pending days)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import inspector from 'node:inspector';
import { generate } from './perf-bench.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { consolidate, loadEvents, localDay } from '../lib/core.mjs';

const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const events = Number(arg('events', 8000));
const workspaces = Number(arg('workspaces', 8));
const profileOut = arg('profile', '');
const keep = process.argv.includes('--keep');

const root = arg('root', fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-consolidate-')));
const timer = (name, fn) => {
  const started = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`  ${name.padEnd(24)} ${ms.toFixed(1)} ms`);
  return { value, ms };
};

const built = timer('generate', () => generate({ events, workspaces, root }));
const config = built.value.config;
const transport = createTransport(config);
const stateFile = path.join(config.policyRoot, 'state', 'consumed.json');
timer('settle (all pending)', () => consolidate(config, transport));

const all = loadEvents(config);
const days = new Set(all.map((event) => localDay(event.recorded_at)));
console.log(`  events=${all.length} workspaces=${workspaces} distinctDays=${days.size}`);

const results = [];
for (const mode of ['one', 'all']) {
  if (mode === 'one') {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const keys = Object.keys(state.hashes);
    delete state.hashes[keys[keys.length - 1]];
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } else {
    fs.rmSync(stateFile, { force: true });
  }

  const session = new inspector.Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) => session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))));
  if (profileOut) {
    await post('Profiler.enable');
    await post('Profiler.start');
  }
  const run = timer(`consolidate (${mode})`, () => consolidate(config, transport));
  if (profileOut) {
    const stopped = await post('Profiler.stop');
    const target = mode === 'all' ? profileOut : profileOut.replace(/\.cpuprofile$/, `-${mode}.cpuprofile`);
    fs.writeFileSync(target, JSON.stringify(stopped.profile));
    console.log(`  profile ${target}`);
  }
  session.disconnect();

  results.push({ mode, ms: Number(run.ms.toFixed(1)), pendingBefore: run.value.pendingBefore, changed: run.value.changed.length });
  console.log(`  -> ${mode}: pendingBefore=${run.value.pendingBefore} changed=${run.value.changed.length}`);
}

console.log(JSON.stringify({ events, workspaces, distinctDays: days.size, root, results }, null, 2));
if (!keep) fs.rmSync(root, { recursive: true, force: true });
