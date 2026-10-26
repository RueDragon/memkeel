import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, consolidate } from '../lib/core.mjs';
import { FilesystemTransport } from '../lib/storage/filesystem.mjs';

const script = fileURLToPath(new URL('../scripts/knowledge-upgrade.mjs', import.meta.url));
test('new fact conflicts disable old candidates and prevent further inference proposals', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-observation-conflict-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vaultRoot = path.join(root, 'vault'); fs.mkdirSync(vaultRoot);
  const config = { policyRoot: root, memoryRoot: vaultRoot, vaultRoot, storage: 'filesystem',
    eventsRoot: 'events', projectRoot: 'projects', workRoot: 'work', inboxRoot: 'digest',
    habitsNote: 'habits.md', actionsNote: 'actions.md', mistakesNote: 'mistakes.md', preferenceCandidatesNote: 'candidates.md',
    topics: [{ id: 'demo/a', workspace: 'demo', path: 'topics/a.md', title: 'Demo' }] };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(vaultRoot, 'proof.md'), 'Source evidence');
  fs.writeFileSync(path.join(vaultRoot, 'habits.md'), '# Habits\n```json\n{"rules":[]}\n```');
  const transport = new FilesystemTransport(config);
  const event = { workspace: 'demo', topic: 'demo/a', agent: 'codex', occurred_at: '2026-10-13T00:00:00Z',
    recorded_at: '2026-10-13T00:00:00Z', evidence: ['proof.md'] };
  record(config, transport, { ...event, event_id: 'first-source', facts: [{ key: 'fact', text: 'Use files for transport' }] });
  consolidate(config, transport);
  const proposal = path.join(root, 'proposal.json');
  fs.writeFileSync(proposal, JSON.stringify({ claim: 'File transport may reduce quoting problems', kind: 'explanation',
    support: [{ id: 'first-source/fact', quote: 'Use files for transport' }] }));
  const run = (command, args = []) => spawnSync(process.execPath, [script, command, '--home', root, '--workspace', 'demo', ...args], { encoding: 'utf8', windowsHide: true });
  const propose = ['--topic', 'demo/a', '--proposal', proposal];
  assert.equal(run('observation', [...propose, '--execute']).status, 0);
  assert.equal(JSON.parse(run('inspect').stdout).observations[0].usable, true);
  record(config, transport, { ...event, event_id: 'conflicting-source', facts: [{ key: 'fact', text: 'Use nested quoted commands' }] });
  consolidate(config, transport);
  const state = JSON.parse(run('inspect').stdout).observations[0];
  assert.equal(state.usable, false);
  assert.equal(state.blockedReason, 'conflicted-evidence');
  const rejected = run('observation', propose);
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Conflicted evidence/);
  const page = run('page', ['--topic', 'demo/a', '--execute']);
  assert.equal(page.status, 1);
  assert.match(page.stderr, /conflict/i);
  assert.ok(!fs.existsSync(path.join(vaultRoot, 'projects/knowledge-upgrade/demo--a.md')));
  assert.equal(fs.readdirSync(path.join(root, 'state/knowledge-upgrade/observation-journal')).length, 1);
});
