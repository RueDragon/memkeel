import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { embeddingProfile, INDEX_VERSION } from '../lib/search/semantic-index.mjs';
import { loadConfig } from '../lib/config.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { capture } from '../lib/lifecycle.mjs';
import { loadEvents } from '../lib/core.mjs';
import { applyRetention } from '../lib/retention.mjs';
import { retrieveForTask, retrieveForTaskSync, buildCurrentGovernanceReport } from '../lib/task-retrieval.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'memory.mjs');
const mcp = path.join(root, 'mcp-server.mjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-task-recall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  const store = path.join(dir, 'store');
  const project = path.join(dir, 'project');
  const userHome = path.join(dir, 'user-home');
  for (const pathName of [home, store, project, userHome]) fs.mkdirSync(pathName);
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, MEMKEEL_HOME: path.join(dir, 'wrong-home') };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], {
    cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  const initialized = run('init', '--store', store);
  assert.equal(initialized.status, 0, initialized.stderr);
  const git = spawnSync('git', ['-C', project, 'init', '--quiet'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  const added = run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  return { home, project, workspace: JSON.parse(added.stdout).id, env, run };
}

test('CLI task-recall is read-only and reports keyword degradation without an index', (t) => {
  const f = fixture(t);
  const result = f.run('task-recall', '--workspace', f.workspace, '--query', 'service profile');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executed, true);
  assert.equal(report.workspace, f.workspace);
  assert.equal(report.diagnostics.mode, 'keyword-fallback');
  assert.equal(report.diagnostics.index, 'missing');
  assert.ok(report.diagnostics.reasons.includes('semantic-index-missing'));
  assert.equal(fs.existsSync(path.join(f.home, 'state', 'knowledge-upgrade', `${f.workspace}.index.json`)), false);
});

test('CLI bootstrap executes retrieval when a task query is present', (t) => {
  const f = fixture(t);
  const result = f.run('bootstrap', '--cwd', f.project, '--workspace', f.workspace, '--query', 'service profile', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.taskRetrieval.executed, true);
  assert.equal(report.taskRetrieval.diagnostics.mode, 'keyword-fallback');
  assert.match(report.text, /任务前相关记忆/);
});

test('MCP task_recall is available through the read-only tool', (t) => {
  const f = fixture(t);
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'agent_memory_read', arguments: { action: 'task_recall', workspace: f.workspace, query: 'service profile' },
    } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'agent_memory_read', arguments: { action: 'bootstrap', cwd: f.project, workspace: f.workspace, query: 'service profile' },
    } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'agent_memory_read', arguments: { action: 'governance_report' },
    } },
  ];
  const result = spawnSync(process.execPath, [mcp, '--home', f.home], {
    cwd: root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
    input: `${requests.map((row) => JSON.stringify(row)).join('\n')}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout.trim().split('\n').map((row) => JSON.parse(row));
  const tool = replies[0].result.tools.find((row) => row.name === 'agent_memory_read');
  assert.ok(tool.inputSchema.properties.action.enum.includes('task_recall'));
  assert.equal(replies[1].result.isError, undefined);
  const report = JSON.parse(replies[1].result.content[0].text);
  assert.equal(report.diagnostics.mode, 'keyword-fallback');
  assert.equal(report.diagnostics.index, 'missing');
  assert.match(replies[2].result.content[0].text, /任务前相关记忆/);
  const governance = JSON.parse(replies[3].result.content[0].text);
  assert.equal(governance.mode, 'report-only');
  assert.equal(governance.applied, false);
});

test('task-recall reads a compatible workspace index without rebuilding it', (t) => {
  const f = fixture(t);
  const indexDir = path.join(f.home, 'state', 'knowledge-upgrade');
  fs.mkdirSync(indexDir, { recursive: true });
  const model = 'test-local-embedding';
  const profile = embeddingProfile(model);
  const indexFile = path.join(indexDir, `${f.workspace}.index.json`);
  fs.writeFileSync(indexFile, JSON.stringify({ version: INDEX_VERSION, model, profile, dimension: null, rows: [] }));
  const before = fs.readFileSync(indexFile);
  const result = f.run('task-recall', '--workspace', f.workspace, '--query', 'service profile');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.diagnostics.index, 'available');
  assert.equal(report.diagnostics.mode, 'indexed-shadow');
  assert.deepEqual(fs.readFileSync(indexFile), before);
});

test('governance report is read-only and makes no lifecycle decisions', (t) => {
  const f = fixture(t);
  const report = f.run('governance-report');
  assert.equal(report.status, 0, report.stderr);
  const result = JSON.parse(report.stdout);
  assert.equal(result.mode, 'report-only');
  assert.equal(result.applied, false);
  assert.equal(result.stats.count, 0);
});

function snapshotFiles(dir) {
  return Object.fromEntries(fs.readdirSync(dir, { recursive: true }).filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .sort().map((name) => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]));
}

test('task retrieval preserves recorded facts and registered notes through both adapters without writes', async (t) => {
  const f = fixture(t);
  const config = loadConfig(f.home).config;
  const topic = `${f.workspace}/service-profile`;
  capture(config, createTransport(config), {
    event_id: 'populated-corpus-0001', workspace: f.workspace, topic, agent: 'codex',
    facts: [{ key: 'service-contract', text: 'Service profile uses the stable adapter boundary.' }],
    experiences: [{ id: 'service-search', kind: 'workflow', scope: f.workspace, status: 'active',
      triggers: ['service profile'], text: 'Service profile search must inspect the adapter before repeating broad searches.',
      verification: 'Verified with an isolated synthetic service fixture.' }],
  }, 'Verified the service profile contract in the isolated fixture.');
  const note = 'service-reference.md';
  fs.writeFileSync(path.join(config.vaultRoot, note), `---\nworkspace: ${f.workspace}\n---\n# Service profile reference\nService profile note material documents the adapter configuration.\n`);
  config.knowledgeSearchNotes = [{ topic, path: note }];
  const beforeHome = snapshotFiles(f.home);
  const beforeVault = snapshotFiles(config.vaultRoot);
  const options = { workspace: f.workspace, query: 'service profile' };
  for (const result of [retrieveForTaskSync(config, options), await retrieveForTask(config, options)]) {
    assert.ok(result.hits.some((hit) => hit.sourceType === 'fact' && hit.text.includes('stable adapter boundary')));
    assert.ok(result.hits.some((hit) => hit.sourceType === 'experience' && hit.text.includes('before repeating broad searches')));
    assert.ok(result.hits.some((hit) => hit.sourceType === 'note-section' && hit.text.includes('adapter configuration')));
    assert.ok(result.hits.every((hit) => hit.workspace === f.workspace));
  }
  assert.deepEqual(snapshotFiles(f.home), beforeHome);
  assert.deepEqual(snapshotFiles(config.vaultRoot), beforeVault);
});

test('governance hides dropped and superseded learning even when its own status is active', (t) => {
  const f = fixture(t);
  const config = loadConfig(f.home).config;
  const transport = createTransport(config);
  const base = { workspace: f.workspace, topic: `${f.workspace}/task-context`, agent: 'codex' };
  const context = { id: 'service-task', task: 'Service profile task', status: 'active', text: 'Important service profile checkpoint.' };
  const experience = { id: 'service-workflow', kind: 'workflow', scope: f.workspace, status: 'active',
    triggers: ['service profile'], text: 'Important service profile workflow.', verification: 'Verified in the isolated fixture.' };
  capture(config, transport, { ...base, event_id: 'governance-base-0001', contexts: [context], experiences: [experience] }, 'Synthetic source evidence.');
  capture(config, transport, { ...base, event_id: 'governance-revised-0002',
    contexts: [{ ...context, text: 'Revised important service profile checkpoint.', supersedes: 'governance-base-0001' }],
    experiences: [{ ...experience, text: 'Revised important service profile workflow.', supersedes: 'governance-base-0001' }],
  }, 'Synthetic verified revision evidence.');
  capture(config, transport, { ...base, event_id: 'governance-dropped-0003',
    contexts: [{ ...context, id: 'dropped-task', text: 'Synthetic reported task checkpoint.' }],
  }, 'Synthetic checkpoint evidence.', { explicit: true });
  applyRetention(config, [{ event_id: 'governance-dropped-0003', decision: 'drop', reason: 'Synthetic approved display exclusion.' }], loadEvents(config));
  const before = snapshotFiles(f.home);
  const current = buildCurrentGovernanceReport(config);
  assert.equal(current.stats.count, 2);
  assert.ok(current.candidates.every((row) => row.event_id === 'governance-revised-0002'));
  const history = buildCurrentGovernanceReport(config, { history: true });
  assert.equal(history.stats.count, 5);
  assert.equal(history.candidates.filter((row) => row.visibility.status === 'superseded').length, 2);
  assert.equal(history.candidates.filter((row) => row.visibility.status === 'drop').length, 1);
  assert.deepEqual(snapshotFiles(f.home), before);
});

function callMcp(f, requests) {
  const result = spawnSync(process.execPath, [mcp, '--home', f.home], {
    cwd: root, env: f.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
    input: `${requests.map((row, index) => JSON.stringify({ jsonrpc: '2.0', id: index + 1, ...row })).join('\n')}\n`,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split('\n').map((row) => JSON.parse(row).result);
}

test('MCP ordinary short capture skips without a worker while explicit short capture records', (t) => {
  const f = fixture(t);
  const input = { event_id: 'mcp-short-capture-0001', workspace: f.workspace, topic: `${f.workspace}/short-context`, agent: 'codex',
    contexts: [{ id: 'short', task: 'x', text: 'ok' }] };
  const request = (extra = {}) => ({ method: 'tools/call', params: { name: 'agent_memory',
    arguments: { action: 'capture', input, evidence_text: 'Synthetic evidence.', ...extra } } });
  const before = snapshotFiles(f.home);
  const [listed, ordinary] = callMcp(f, [{ method: 'tools/list' }, request()]);
  assert.equal(listed.tools.find((tool) => tool.name === 'agent_memory').inputSchema.properties.explicit.type, 'boolean');
  assert.equal(listed.tools.find((tool) => tool.name === 'agent_memory_read').inputSchema.properties.explicit, undefined);
  assert.equal(ordinary.isError, undefined);
  assert.deepEqual(JSON.parse(ordinary.content[0].text), { status: 'skipped', recorded: false, reason: 'low-importance' });
  assert.deepEqual(snapshotFiles(f.home), before, 'a skipped async capture must not create a queue, reservation or worker artifact');
  const [explicit] = callMcp(f, [request({ explicit: true, wait: true })]);
  assert.equal(explicit.isError, undefined);
  assert.equal(JSON.parse(explicit.content[0].text).status, 'ready');
  assert.equal(loadEvents(loadConfig(f.home).config).length, 1);
});

test('MCP collection-disabled still skips explicit async and synchronous captures without writes', (t) => {
  const f = fixture(t);
  const configFile = path.join(f.home, 'config.json');
  const document = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...document, collection: { enabled: false } }));
  const before = snapshotFiles(f.home);
  const results = callMcp(f, [false, true].map((wait) => ({ method: 'tools/call', params: { name: 'agent_memory', arguments: {
    action: 'capture', explicit: true, wait, evidence_text: 'Synthetic denied evidence.',
    input: { event_id: 'mcp-disabled-0001', workspace: f.workspace, topic: `${f.workspace}/private-context`, agent: 'codex',
      contexts: [{ id: 'private', task: 'x', text: 'ok' }] },
  } } })));
  for (const result of results) {
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { status: 'skipped', recorded: false, reason: 'collection-disabled' });
  }
  assert.deepEqual(snapshotFiles(f.home), before);
  assert.equal(loadEvents(loadConfig(f.home).config).length, 0);
});
