#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { loadEvents, reduceEvents, consumptionStatus } from '../lib/core.mjs';
import { atomicJson, withLock, inside, sha } from '../lib/transport.mjs';
import { pageRevision, inspectPage } from '../lib/knowledge/pages.mjs';
import { mergeRefreshQueue } from '../lib/knowledge/refresh.mjs';

// Explicit one-shot worker. No scheduler or startup hook is installed.
try {
  const args = process.argv.slice(2);
  let home; let execute = false; let retryFailed = false;
  const seen = new Set();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('Duplicate argument');
    seen.add(arg);
    if (arg === '--execute') execute = true;
    else if (arg === '--retry-failed') retryFailed = true;
    else if (arg === '--home' && args[i + 1] && !args[i + 1].startsWith('--')) home = args[++i];
    else throw new Error('Invalid arguments');
  }
  if (!home) throw new Error('--home required');
  const { config } = loadConfig(home);
  const dir = path.join(config.policyRoot, 'state', 'knowledge-upgrade');
  const events = loadEvents(config); const projection = reduceEvents(events);
  const pending = consumptionStatus(config, events).pendingTopics;
  const tasks = config.topics.map((topic) => {
    const file = path.join(dir, `${topic.id.replace('/', '--')}.page.json`);
    const manifest = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
    const pageFile = inside(config.vaultRoot, `${config.projectRoot}/knowledge-upgrade/${topic.id.replace('/', '--')}.md`);
    const text = fs.existsSync(pageFile) ? fs.readFileSync(pageFile, 'utf8') : null;
    const intentFile = `${file}.pending`;
    const intent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : null;
    const relative = `${config.projectRoot}/knowledge-upgrade/${topic.id.replace('/', '--')}.md`;
    const recoverable = !!intent && text !== null && intent.relative === relative
      && sha(text) === intent.nextHash && !projection.conflicts.some((r) => r.topic === topic.id);
    return { topic: topic.id, workspace: topic.workspace, revision: pageRevision(projection, topic.id),
      ...inspectPage(manifest, projection, topic.id, pending, text), recoverable };
  });
  const queueFile = path.join(dir, 'refresh-queue.json');
  const queuedRetryTopics = retryFailed && fs.existsSync(queueFile)
    ? new Set(JSON.parse(fs.readFileSync(queueFile, 'utf8'))
      .filter((task) => ['failed', 'deferred'].includes(task.status)).map((task) => task.topic))
    : new Set();
  const refreshTasks = tasks.filter((task) =>
    ((['missing', 'dirty'].includes(task.state) || task.recoverable) || queuedRetryTopics.has(task.topic))
    && !pending.includes(task.topic));
  if (!execute) console.log(JSON.stringify({ mode: 'plan', retryFailed, tasks }, null, 2));
  else {
    // A worker-specific lock serialises queues; each child separately acquires
    // the canonical writer lock only for its short publication transaction.
    fs.mkdirSync(dir, { recursive: true });
    const result = withLock(dir, () => {
      const file = queueFile;
      const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
      const queue = mergeRefreshQueue(previous, refreshTasks, { retryFailed });
      const eligible = new Set(refreshTasks.map((task) => task.topic));
      atomicJson(file, queue);
      const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'knowledge-upgrade.mjs');
      // Synchronous child execution keeps the worker lock held until the pass ends.
      const results = queue.map((task) => {
        if (!eligible.has(task.topic) && task.status !== 'done') return { ...task, status: 'deferred', error: 'refresh-not-eligible' };
        if (task.status === 'done' || task.attempts >= 3) return task;
        const child = spawnSync(process.execPath, [script, 'page', '--home', home,
          '--workspace', task.workspace, '--topic', task.topic, '--execute'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
        let fresh = false;
        try { fresh = child.status === 0 && JSON.parse(child.stdout).state === 'fresh'; }
        catch { /* Invalid child output is a visible failed task, not a queue abort. */ }
        if (!fresh && child.stderr?.trim()) {
          // Keep JSON mode machine-readable on stdout, but do not erase the concrete
          // concurrency/transport diagnosis: callers and operators need to distinguish
          // a stale publication from an arbitrary refresh failure.
          process.stderr.write(child.stderr.trim() + '\n');
        }
        const updated = { ...task, attempts: task.attempts + 1,
          status: fresh ? 'done' : 'failed',
          ...(fresh ? {} : { error: 'refresh-failed' }) };
        return updated;
      });
      atomicJson(file, results);
      return results;
    });
    console.log(JSON.stringify({ mode: 'executed', tasks: result }, null, 2));
    if (result.some((task) => task.status !== 'done')) process.exitCode = 2;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
