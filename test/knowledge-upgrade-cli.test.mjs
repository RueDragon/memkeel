import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, consolidate } from '../lib/core.mjs';
import { FilesystemTransport } from '../lib/storage/filesystem.mjs';
import { sha } from '../lib/transport.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('upgrade CLI previews without writes and publishes candidates/pages only on execute', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault'); fs.mkdirSync(vaultRoot);
  const config = { policyRoot: root, memoryRoot: vaultRoot, vaultRoot, storage: 'filesystem',
    eventsRoot: 'events', projectRoot: 'projects', workRoot: 'work', inboxRoot: 'digest',
    habitsNote: 'habits.md', actionsNote: 'actions.md', mistakesNote: 'mistakes.md',
    preferenceCandidatesNote: 'candidates.md', topics: [{ id: 'demo/shell', workspace: 'demo', path: 'topics/shell.md', title: 'Shell' }] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(vaultRoot, 'proof.md'), '传参使用文件。');
  fs.writeFileSync(path.join(vaultRoot, 'habits.md'), '# Habits\n```json\n{"rules":[]}\n```');
  const transport = new FilesystemTransport(config);
  record(config, transport, { event_id: 'synthetic-source', workspace: 'demo', topic: 'demo/shell', agent: 'codex',
    occurred_at: '2026-10-13T00:00:00Z', recorded_at: '2026-10-13T00:00:00Z', evidence: ['proof.md'],
    facts: [{ key: 'shell', text: '传参使用文件。' }] });
  consolidate(config, transport);
  const run = (command, args = []) => spawnSync(process.execPath, [path.join(rootDir, 'scripts/knowledge-upgrade.mjs'),
    command, '--home', root, '--workspace', 'demo', ...args], { encoding: 'utf8' });
  let response = run('page', ['--topic', 'demo/shell']);
  const indexPlan = run('index', ['--model-revision', 'weights-test', '--query-prefix', 'query: ']);
  assert.equal(indexPlan.status, 0, indexPlan.stderr);
  assert.equal(JSON.parse(indexPlan.stdout).profile.modelRevision, 'weights-test');
  assert.equal(response.status, 0, response.stderr);
  assert.ok(!fs.existsSync(path.join(root, 'state/knowledge-upgrade')));
  response = run('page', ['--topic', 'demo/shell', '--execute']);
  assert.equal(response.status, 0, response.stderr);
  const file = path.join(vaultRoot, 'projects/knowledge-upgrade/demo--shell.md');
  const before = fs.readFileSync(file, 'utf8');
  response = run('page', ['--topic', 'demo/shell', '--execute']);
  assert.equal(response.status, 0, response.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  const badIndexFile = path.join(root, 'state/knowledge-upgrade/demo.index.json');
  fs.writeFileSync(badIndexFile, '{broken');
  response = run('inspect');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).index.issue, 'invalid-index-file');
  response = run('recall', ['--query', '传参']);
  assert.equal(response.status, 2, response.stderr);
  assert.ok(JSON.parse(response.stdout).routes.keyword.length);
  assert.equal(fs.readFileSync(badIndexFile, 'utf8'), '{broken');
  fs.rmSync(badIndexFile);
  const manifestFile = path.join(root, 'state/knowledge-upgrade/demo--shell.page.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  fs.writeFileSync(`${manifestFile}.pending`, JSON.stringify({ relative: 'projects/knowledge-upgrade/demo--shell.md',
    previousHash: sha('old page'), nextHash: sha(before), manifest }));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, bodyHash: sha('old generated body') }));
  const worker = spawnSync(process.execPath, [path.join(rootDir, 'scripts/refresh-knowledge.mjs'),
    '--home', root, '--execute'], { encoding: 'utf8' });
  assert.equal(worker.status, 0, worker.stderr);
  assert.equal(JSON.parse(worker.stdout).tasks[0].status, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.ok(!fs.existsSync(`${manifestFile}.pending`));
  fs.writeFileSync(file, before.replace('传参使用文件。', '手工内容。'));
  response = run('page', ['--topic', 'demo/shell', '--execute']);
  assert.notEqual(response.status, 0);
  assert.ok(fs.readFileSync(file, 'utf8').includes('手工内容。'));
  response = run('inspect');
  assert.equal(JSON.parse(response.stdout).pages[0].state, 'blocked');
  assert.equal(JSON.parse(response.stdout).pages[0].integrity, 'managed-content-changed');
  fs.rmSync(file);
  response = run('inspect');
  assert.equal(JSON.parse(response.stdout).pages[0].state, 'missing');
  response = run('page', ['--topic', 'demo/shell']);
  assert.equal(JSON.parse(response.stdout).state, 'missing');
  const proposal = path.join(root, 'proposal.json');
  fs.writeFileSync(proposal, JSON.stringify({ claim: '文件传参可能更可靠。', kind: 'failure-pattern',
    support: [{ id: 'synthetic-source/shell', quote: '传参使用文件。' }] }));
  response = run('observation', ['--topic', 'demo/shell', '--proposal', proposal, '--execute']);
  assert.equal(response.status, 0, response.stderr);
  const observation = JSON.parse(response.stdout).observation;
  assert.equal(observation.status, 'candidate');
  assert.equal(fs.readdirSync(path.join(root, 'state/knowledge-upgrade/observation-journal')).length, 1);
  response = run('inspect');
  assert.equal(response.status, 0, response.stderr);
  assert.equal(JSON.parse(response.stdout).index.exists, false);
  assert.equal(JSON.parse(response.stdout).locks.writer.present, false);
  assert.equal(JSON.parse(response.stdout).locks.refresh.present, false);
  assert.equal(JSON.parse(response.stdout).index.weightRevisionDeclared, false);
  const current = JSON.parse(response.stdout).observations[0];
  response = run('retire', ['--topic', 'demo/shell', '--key', current.key, '--supersedes', current.version,
    '--reason', '验收撤销', '--execute']);
  assert.equal(response.status, 0, response.stderr);
  response = run('inspect');
  assert.equal(JSON.parse(response.stdout).observations[0].usable, false);
  assert.equal(fs.readdirSync(path.join(root, 'state/knowledge-upgrade/observation-journal')).length, 2);
  fs.writeFileSync(path.join(root, 'state/knowledge-upgrade/refresh-queue.json'), JSON.stringify([
    { workspace: 'demo', topic: 'demo/shell', revision: 'test', status: 'failed', attempts: 3, error: 'private provider log' },
    { workspace: 'other', topic: 'other/a', status: 'failed', attempts: 3 },
  ]));
  response = run('inspect');
  const refresh = JSON.parse(response.stdout).refresh;
  assert.equal(refresh.length, 1);
  assert.equal(refresh[0].retryExhausted, true);
  assert.equal(refresh[0].error, 'refresh-failed');
  const exhaustedWorker = spawnSync(process.execPath, [path.join(rootDir, 'scripts/refresh-knowledge.mjs'),
    '--home', root, '--execute'], { encoding: 'utf8' });
  assert.equal(exhaustedWorker.status, 2, exhaustedWorker.stderr);
  const queueFile = path.join(root, 'state/knowledge-upgrade/refresh-queue.json');
  fs.writeFileSync(file, before);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, revision: 'older-revision' }));
  fs.writeFileSync(queueFile, JSON.stringify([{ workspace: 'demo', topic: 'demo/shell',
    revision: manifest.revision, status: 'failed', attempts: 3 }]));
  const queueBefore = fs.readFileSync(queueFile, 'utf8');
  const previewRetry = spawnSync(process.execPath, [path.join(rootDir, 'scripts/refresh-knowledge.mjs'),
    '--home', root, '--retry-failed'], { encoding: 'utf8' });
  assert.equal(previewRetry.status, 0, previewRetry.stderr);
  assert.equal(fs.readFileSync(queueFile, 'utf8'), queueBefore);
  const retryWorker = spawnSync(process.execPath, [path.join(rootDir, 'scripts/refresh-knowledge.mjs'),
    '--home', root, '--retry-failed', '--execute'], { encoding: 'utf8' });
  assert.equal(retryWorker.status, 0, retryWorker.stderr);
  assert.equal(JSON.parse(retryWorker.stdout).tasks[0].status, 'done');
  assert.equal(JSON.parse(retryWorker.stdout).tasks[0].attempts, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
