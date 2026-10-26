import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { record, consolidate } from '../lib/core.mjs';
import { FilesystemTransport } from '../lib/storage/filesystem.mjs';
import { inspectLock } from '../lib/transport.mjs';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
test('page CLI and two refresh workers contend safely and retry to one fresh page', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-worker-contention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault'); fs.mkdirSync(vaultRoot);
  const config = { policyRoot: root, memoryRoot: vaultRoot, vaultRoot, storage: 'filesystem',
    eventsRoot: 'events', projectRoot: 'projects', workRoot: 'work', inboxRoot: 'digest',
    habitsNote: 'habits.md', actionsNote: 'actions.md', mistakesNote: 'mistakes.md',
    preferenceCandidatesNote: 'candidates.md', topics: [{ id: 'demo/a', workspace: 'demo', path: 'topics/a.md', title: 'Demo' }] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(vaultRoot, 'proof.md'), 'Recorded evidence');
  fs.writeFileSync(path.join(vaultRoot, 'habits.md'), '# Habits\n```json\n{"rules":[]}\n```');
  const transport = new FilesystemTransport(config);
  record(config, transport, { event_id: 'contention-source', workspace: 'demo', topic: 'demo/a', agent: 'codex',
    occurred_at: '2026-10-13T00:00:00Z', recorded_at: '2026-10-13T00:00:00Z', evidence: ['proof.md'],
    facts: [{ key: 'fact', text: 'Recorded evidence' }] });
  consolidate(config, transport);
  const pageFile = path.join(vaultRoot, 'projects/knowledge-upgrade/demo--a.md');
  fs.mkdirSync(path.dirname(pageFile), { recursive: true });
  const manual = 'Manual prefix\r\n';
  fs.writeFileSync(pageFile, manual);
  const pageArgs = [path.join(scripts, 'knowledge-upgrade.mjs'), 'page', '--home', root, '--workspace', 'demo', '--topic', 'demo/a', '--execute'];
  const workerArgs = [path.join(scripts, 'refresh-knowledge.mjs'), '--home', root, '--execute'];
  const children = [pageArgs, workerArgs, workerArgs].map((args) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    let stderr = ''; child.stderr.on('data', (data) => { stderr += data; });
    return { child, stderr: () => stderr, exit: once(child, 'exit') };
  });
  const exits = await Promise.all(children.map((row) => row.exit));
  assert.ok(exits.some(([code]) => code === 0));
  exits.forEach(([code], index) => {
    if (code !== 0) assert.match(children[index].stderr(), /Page changed|Writer locked|Sources changed|Concurrent edit/);
  });
  // A competing preview can legitimately become stale; retry from a new snapshot.
  // A competing worker records a bounded failed task. Retry is explicit by contract;
  // without --retry-failed the same revision is intentionally not re-enqueued.
  const retry = spawnSync(process.execPath, [...workerArgs, '--retry-failed'], { encoding: 'utf8', windowsHide: true });
  assert.equal(retry.status, 0, retry.stderr);
  const inspect = spawnSync(process.execPath, [path.join(scripts, 'knowledge-upgrade.mjs'), 'inspect', '--home', root, '--workspace', 'demo'], { encoding: 'utf8', windowsHide: true });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).pages[0].state, 'fresh');
  assert.ok(JSON.parse(inspect.stdout).refresh.every((task) => task.status === 'done'));
  const text = fs.readFileSync(pageFile, 'utf8');
  assert.ok(text.startsWith(manual));
  assert.equal(text.split('MEMKEEL-KNOWLEDGE:START').length, 2);
  assert.equal(text.split('- Recorded evidence\n').length, 2);
  const derived = path.join(root, 'state/knowledge-upgrade');
  assert.ok(!fs.readdirSync(derived).some((name) => name.endsWith('.pending')));
  assert.equal(inspectLock(path.join(root, 'state')).present, false);
  assert.equal(inspectLock(derived).present, false);
});
