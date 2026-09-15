import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../dashboard.mjs';
import { applyLayout } from '../lib/layout.mjs';
import { createTransport } from '../lib/storage/index.mjs';
import { ensureWorkspace, record } from '../lib/core.mjs';
import { settingsSnapshot } from '../lib/dashboard-data.mjs';

// Builds a small isolated vault + policy root and returns a config loader plus the
// project directory, so dashboard tests never touch the real vault.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault');
  const policyRoot = path.join(root, 'policy');
  for (const dir of ['events', 'topics', 'projects', 'digest']) fs.mkdirSync(path.join(vaultRoot, dir), { recursive: true });
  fs.mkdirSync(policyRoot, { recursive: true });
  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });

  const config = applyLayout({ memoryRoot: vaultRoot, vaultRoot, policyRoot, storage: 'filesystem', layout: 'neutral', vaultName: '', obsidianCli: '', topics: [], workspaceAliases: {} });
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(config, null, 2));
  const transport = createTransport(config);
  transport.create('habits.md', '# Habits\n\n```json\n{"rules":[{"id":"global-cn","status":"confirmed","scope":"global","text":"Reply in Chinese"}]}\n```\n');
  transport.create('digest/evidence.md', '---\ntype: session-closeout\ndate: 2026-09-01\n---\n# Evidence\n\nDashboard fixture evidence.\n');

  const route = ensureWorkspace(config, transport, projectDir);
  const topic = { id: `${route.id}/rules`, workspace: route.id, title: 'Rules', aliases: [], path: `topics/${route.id}--rules.md` };
  const persisted = JSON.parse(fs.readFileSync(path.join(policyRoot, 'config.json'), 'utf8'));
  persisted.topics.push(topic);
  fs.writeFileSync(path.join(policyRoot, 'config.json'), JSON.stringify(persisted, null, 2));
  config.topics = persisted.topics;

  record(config, transport, {
    event_id: 'dashboard-fixture-0001',
    workspace: route.id, topic: topic.id, agent: 'fixture',
    occurred_at: '2026-09-01T00:00:00+08:00',
    evidence: ['digest/evidence.md'],
    facts: [{ key: 'fixture-fact', text: 'The dashboard reads through the core, never Markdown directly.' }],
    contexts: [{ id: 'fixture-ctx', task: 'Build dashboard', text: 'In progress.', certainty: 'reported', ttl_days: 30 }],
    actions: [{ id: 'fixture-todo', status: 'open', text: 'Add mutation previews' }],
  });

  return { root, config, loader: () => applyLayout({ ...JSON.parse(fs.readFileSync(path.join(policyRoot, 'config.json'), 'utf8')), policyRoot }) };
}

async function withServer(loader, fn) {
  const server = createServer(loader);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('health endpoint responds without touching the vault', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

test('status reports event counts and pending state', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const body = await (await fetch(`${base}/api/status`)).json();
    assert.equal(body.events, 1);
    assert.equal(body.facts, 1);
    assert.equal(body.contexts, 1);
    assert.equal(typeof body.conflicts, 'number');
  });
});

test('overview exposes every memory surface in one payload', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const body = await (await fetch(`${base}/api/overview`)).json();
    for (const key of ['status', 'facts', 'contexts', 'experiences', 'habits', 'actions', 'conflicts', 'events', 'routes', 'access', 'topics']) {
      assert.ok(key in body, `missing ${key}`);
    }
    assert.equal(body.facts[0].key, 'fixture-fact');
    assert.equal(body.actions[0].id, 'fixture-todo');
  });
});

test('habits endpoint separates confirmed rules from probationary and candidates', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const body = await (await fetch(`${base}/api/habits`)).json();
    assert.equal(body.habits.length, 1);
    assert.equal(body.habits[0].id, 'global-cn');
    assert.deepEqual(body.probationary, []);
    assert.deepEqual(body.candidates, []);
  });
});

test('unknown API route returns 404 with an error body', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  });
});

test('the dashboard source never writes Markdown directly', () => {
  // Structural guard: the UI layer must route every change through core, so it must
  // not import filesystem write APIs for note content.
  const source = fs.readFileSync(new URL('../dashboard.mjs', import.meta.url), 'utf8');
  assert.ok(!/writeFileSync\(/.test(source), 'dashboard must not call writeFileSync');
  assert.ok(!/transport\.(create|append|replace)\(/.test(source), 'dashboard must not call transport write verbs');
});

test('a detail lookup does not rebuild the whole model on every call', async (t) => {
  const { loader } = fixture(t);
  await withServer(loader, async (base) => {
    // First call builds and caches; subsequent calls must be served from cache.
    await fetch(`${base}/api/overview`);
    const first = await fetch(`${base}/api/detail?type=event&id=dashboard-fixture-0001`);
    assert.equal(first.status, 200);
    const t0 = Date.now();
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${base}/api/detail?type=fact&id=${encodeURIComponent('proj/rules/fixture-fact')}`);
      assert.ok(res.status === 200 || res.status === 404);
    }
    // Five warm detail calls should complete far faster than five cold rebuilds.
    assert.ok(Date.now() - t0 < 1500, 'warm detail calls should be served from cache');
  });
});

// --- Settings read model -------------------------------------------------------------

const EDITABLE_ROLES = ['eventsRoot', 'topicsRoot', 'projectRoot', 'habitsNote', 'actionsNote', 'mistakesNote', 'candidatesNote', 'experienceNote', 'inboxRoot'];

function writeNumbers(config, numbers = { activeLimit: 6, recentLimit: 6, recentDays: 14, budgetBytes: 14000 }) {
  const file = path.join(config.policyRoot, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, ...numbers }, null, 2));
  return file;
}

test('settings endpoint reports the config path, the editable groups and the read-only host scan', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const file = writeNumbers(config);
  await withServer(loader, async (base) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.configPath, file);
    assert.equal(body.groups.memoryRoot, config.memoryRoot);
    assert.equal(body.groups.vaultRoot, config.vaultRoot);
    assert.equal(body.groups.activeLimit, 6);
    assert.equal(body.groups.roles.eventsRoot, 'events');
    assert.equal(body.validation.ok, true, JSON.stringify(body.validation.issues));
    assert.deepEqual(body.roleFields.map((row) => row.key), EDITABLE_ROLES);
    assert.equal(body.numberFields.length, 4);
    assert.deepEqual(body.hostBindings.map((row) => row.id), ['codex', 'claude', 'zcode', 'dsh']);
    assert.equal(body.obsidian.optional, true);
    assert.equal(body.obsidian.downloadUrl, 'https://obsidian.md/download');
    assert.equal(body.restart.required, true);
    assert.match(body.restart.command, /setup --check/);
    assert.equal(body.restart.processes.length, 4);
    // 宿主绑定必须在界面之外完成：页面只拿到命令。
    assert.match(body.setup.apply, /setup/);
    assert.match(body.setup.note, /命令行/);
  });
});

test('settings reports a store path that does not validate instead of failing', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const file = path.join(config.policyRoot, 'config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const notADirectory = path.join(config.policyRoot, 'not-a-directory');
  fs.writeFileSync(notADirectory, 'this is a file, not a store\n');
  fs.writeFileSync(file, JSON.stringify({ ...raw, memoryRoot: notADirectory, vaultRoot: notADirectory }, null, 2));
  await withServer(loader, async (base) => {
    const res = await fetch(`${base}/api/settings`);
    assert.equal(res.status, 200, 'the settings page must load so a broken store can be repaired');
    const body = await res.json();
    assert.equal(body.validation.ok, false);
    assert.ok(body.validation.issues.some((row) => row.field === 'memoryRoot' && /不是目录/.test(row.message)));
    // The model build still fails on a broken store, which is exactly why the settings
    // route is served before it.
    const overview = await fetch(`${base}/api/overview`);
    assert.equal(overview.status, 500);
  });
});

test('settings accepts a store root that does not exist yet and says so', async (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const raw = { ...JSON.parse(fs.readFileSync(writeNumbers(config), 'utf8')) };
  const missing = path.join(config.policyRoot, 'later-store');
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify({ ...raw, memoryRoot: missing, vaultRoot: missing }, null, 2));
  await withServer(loader, async (base) => {
    const body = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(body.validation.ok, true, JSON.stringify(body.validation.issues));
    assert.ok(body.validation.notes.some((note) => /保存时会自动创建/.test(note)));
    assert.equal(fs.existsSync(missing), false, 'reading the settings page must not create anything');
  });
});

test('host binding and Obsidian detection are read-only scans with no side effects', (t) => {
  const { loader } = fixture(t);
  const config = loader();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-hosts-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '[mcp_servers.agent_memory]\ncommand = "node"\n');
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'),
    JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ args: ['hook-runner.mjs', 'codex'] }] }] } }));

  const snapshot = settingsSnapshot(config, { home, env: {} });
  const byId = (id) => snapshot.hostBindings.find((row) => row.id === id);
  assert.equal(byId('codex').installed, true);
  assert.equal(byId('codex').mcp.present, true);
  assert.equal(byId('codex').hooks.present, true);
  assert.equal(byId('zcode').installed, false);
  assert.deepEqual(byId('zcode').mcp.files, []);
  assert.equal(byId('claude').mcp.present, false);
  assert.equal(snapshot.obsidian.cli.exists, false);
  assert.equal(snapshot.obsidian.detected.every((row) => typeof row.exists === 'boolean'), true);

  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'obsidian'), '#!/bin/sh\n');
  const detected = settingsSnapshot(config, { home, env: {} });
  assert.equal(detected.obsidian.installed, true);
  assert.ok(detected.obsidian.detected.some((row) => row.path.endsWith(path.join('.local', 'bin', 'obsidian')) && row.exists));
});