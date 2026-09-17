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
import { privacyView } from '../lib/privacy.mjs';
import { makeTranslator, renderMessages } from '../lib/messages.mjs';

// Payloads carry message references for the prose that originates in lib/, so a test that reads that
// prose renders it the way the settings page does. The locale is pinned for determinism.
const en = makeTranslator('en');

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

test('the settings payload reports the effective collection policy instead of offering a switch', (t) => {
  const { config, loader } = fixture(t);
  const file = path.join(config.policyRoot, 'config.json');

  // Default: no collection section at all still reads as collecting, so an existing store is
  // unaffected by the feature having been added.
  const before = settingsSnapshot(loader());
  assert.equal(before.collection.decision.collecting, true);
  assert.equal(before.collection.decision.decidedBy, 'global');
  assert.equal(before.collection.scopes.global, 'on');
  assert.equal(before.groups.collection, undefined, 'the page must not present a collection editor group');

  // A workspace opt-out plus an exclusion rule, written the way a user would write it.
  const workspace = config.topics[0].workspace;
  const excluded = path.join(config.policyRoot, 'excluded');
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
  persisted.collection = { enabled: true, workspaces: { [workspace]: false }, exclude: { paths: [excluded], sessionTypes: ['scratch'] } };
  fs.writeFileSync(file, JSON.stringify(persisted, null, 2));

  const snapshot = settingsSnapshot(loader());
  // A context-free answer must say so, and must not pretend a workspace-level opt-out applies when no
  // workspace was named — that is the difference between reporting the policy and inventing a verdict.
  assert.equal(snapshot.collection.context.scoped, false);
  assert.equal(snapshot.collection.decision.collecting, true);
  assert.equal(snapshot.collection.decision.decidedBy, 'global');
  // The scope lists are where the opt-out shows up, which is what the page renders.
  assert.equal(snapshot.collection.scopes.workspaces.find((row) => row.workspace === workspace).state, 'off');
  assert.deepEqual(snapshot.collection.scopes.exclusions.map((row) => row.kind), ['paths', 'sessionTypes']);
  // Named context: the same view, now decided by the workspace.
  const scopedView = privacyView(loader(), { workspace });
  assert.equal(scopedView.decision.collecting, false);
  assert.equal(scopedView.decision.decidedBy, 'workspace');
  assert.equal(scopedView.context.scoped, true);
  // `collection` is preserved but not editable from this page, and the page says so.
  assert.ok(snapshot.preservedKeys.includes('collection'));
  // The three states travel with the payload, including the one that is not offered.
  assert.deepEqual(snapshot.collection.vocabulary.map((row) => row.state), ['not-collected', 'retained-not-retrieved', 'physically-deleted']);
  assert.equal(snapshot.collection.vocabulary.find((row) => row.state === 'physically-deleted').supported, false);
  assert.match(renderMessages(snapshot.collection, en).permanentDeletion, /Physical deletion is not implemented/);
});

test('the settings payload says which fields the file sets and which are the program fallback', (t) => {
  const { config, loader } = fixture(t);
  const file = path.join(config.policyRoot, 'config.json');
  const write = (mutate) => {
    const document = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(document);
    fs.writeFileSync(file, JSON.stringify(document, null, 2));
    return settingsSnapshot(loader());
  };

  // A field the file does not carry is in force because the program fell back, not because the user
  // chose it — that is the distinction the page needs before offering to change it.
  const removed = write((document) => { delete document.activeLimit; });
  assert.equal(removed.provenance.activeLimit, 'fallback');

  // A field the file does carry is the user's setting.
  const set = write((document) => { document.activeLimit = 7; });
  assert.equal(set.provenance.activeLimit, 'config-file');
  assert.equal(set.groups.activeLimit, 7, 'the effective value and its origin must agree');

  // A legacy flat role key also feeds the role map, so it counts as the file setting the field.
  const legacy = write((document) => { delete document.roles.eventsRoot; document.eventsRoot = 'legacy-events'; });
  assert.equal(legacy.provenance['roles.eventsRoot'], 'config-file');
  const unset = write((document) => { delete document.roles.eventsRoot; delete document.eventsRoot; });
  assert.equal(unset.provenance['roles.eventsRoot'], 'fallback');

  // Every reported origin is one of the two states, and the reported set covers the editable fields:
  // a field with no origin would leave the page unable to explain a value it is showing.
  const snapshot = settingsSnapshot(loader());
  const origins = Object.values(snapshot.provenance);
  assert.ok(origins.length > 0);
  assert.deepEqual([...new Set(origins)].sort(), ['config-file', 'fallback']);
  for (const field of snapshot.numberFields) assert.ok(field.key in snapshot.provenance, `${field.key} needs an origin`);
  for (const field of snapshot.roleFields) assert.ok(`roles.${field.key}` in snapshot.provenance, `roles.${field.key} needs an origin`);
  for (const key of ['storage', 'memoryRoot', 'vaultRoot', 'layout']) assert.ok(key in snapshot.provenance, `${key} needs an origin`);
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