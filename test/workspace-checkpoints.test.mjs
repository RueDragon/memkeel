import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bootstrap, discoverWorkspace, loadRoutes, loadEvents, recallLearning } from '../lib/core.mjs';
import { processHook } from '../lib/hooks.mjs';
import { drainCheckpoints } from '../lib/checkpoints.mjs';
import { checkpointHealth } from '../lib/checkpoint-audit.mjs';
import { sha } from '../lib/transport.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-workspace-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics: [] };
  for (const dir of ['work/projects', 'work/events', 'work/inbox']) fs.mkdirSync(path.join(config.vaultRoot, dir), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n' + String.fromCharCode(96).repeat(3) + 'json\n{"rules":[]}\n' + String.fromCharCode(96).repeat(3));
  const transport = {
    create(p, c) { const file = path.join(config.vaultRoot, p); assert.equal(fs.existsSync(file), false); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, c); },
    append(p, c) { fs.appendFileSync(path.join(config.vaultRoot, p), '\n\n' + c); },
    verify(p) { return fs.readFileSync(path.join(config.vaultRoot, p), 'utf8'); },
    managed(p, h, b) { const file = path.join(config.vaultRoot, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, h + '\n<!-- AUTO-MANAGED:START -->\n' + b + '\n<!-- AUTO-MANAGED:END -->'); }
  };
  const project = (name) => { const cwd = path.join(root, 'projects', name); fs.mkdirSync(cwd, { recursive: true }); return cwd; };
  const call = (cwd, session, event, extra = {}) => ({ cwd, session_id: session, hook_event_name: event, ...extra });
  return { root, config, transport, project, call };
}
for (const host of ['claude', 'codex', 'zcode', 'dsh']) test(host + ': unknown project first write, replay and fresh read close the loop', (t) => {
  const { config, transport, project, call } = fixture(t); const cwd = project('new-' + host); const session = 'new-project-' + host;
  const before = fs.readFileSync(path.join(config.policyRoot, 'config.json'), 'utf8');
  assert.match(bootstrap(config, cwd, '').text, /new-/);
  assert.equal(loadRoutes(config).length, 0);
  assert.equal(fs.readFileSync(path.join(config.policyRoot, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(config.policyRoot, 'state')), false);
  processHook(config, host, call(cwd, session, 'UserPromptSubmit', { prompt: 'OneScreen adapter investigation' }));
  processHook(config, host, call(cwd, session, 'Stop', { last_assistant_message: 'AgentEntry mount contract is required; reported only.' }));
  assert.equal(checkpointHealth(config).pending.length, 1);
  assert.equal(drainCheckpoints(config, transport).processed, 1);
  assert.equal(loadRoutes(config).length, 1);
  const events = loadEvents(config); assert.equal(events.length, 1); assert.equal(events[0].facts, undefined);
  assert.equal(events[0].contexts[0].certainty, 'reported');
  const fresh = JSON.parse(fs.readFileSync(path.join(config.policyRoot, 'config.json'), 'utf8'));
  const summary = bootstrap(fresh, cwd, 'OneScreen').text;
  assert.match(summary, /AgentEntry mount contract/);
  assert.match(summary.split('## 活动项目')[1].split('## 近期变化')[0], /new-/);
  assert.match(summary.split('## 近期变化')[1].split('## 项目短期上下文')[0], /未复核/);
  assert.equal(recallLearning(fresh, { cwd, query: 'OneScreen', type: 'contexts' }).length, 1);
  processHook(fresh, host, call(cwd, session, 'Stop', { last_assistant_message: 'AgentEntry mount contract is required; reported only.' }));
  assert.equal(drainCheckpoints(fresh, transport).processed, 0);
  assert.equal(loadEvents(fresh).length, 1);
  assert.equal(checkpointHealth(fresh, loadEvents(fresh)).healthy, true);
});
test('same directory name stays isolated, repository subdirectories and worktrees share identity', (t) => {
  const { config, project } = fixture(t);
  const a = project('a/repo'); const b = project('b/repo'); const child = path.join(a, 'src'); fs.mkdirSync(child);
  const git = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); };
  git(a, ['init', '-q']); git(a, ['-c', 'user.name=Memory Test', '-c', 'user.email=memory@example.invalid', 'commit', '--allow-empty', '-m', 'fixture', '-q']);
  assert.notEqual(discoverWorkspace(config, a).id, discoverWorkspace(config, b).id);
  assert.equal(discoverWorkspace(config, a).id, discoverWorkspace(config, child).id);
  const worktree = path.join(path.dirname(a), 'linked'); git(a, ['worktree', 'add', '--detach', worktree]);
  assert.equal(discoverWorkspace(config, a).id, discoverWorkspace(config, worktree).id);
});
test('unknown project with no-record request creates neither route nor checkpoint', (t) => {
  const { config, project, call } = fixture(t); const cwd = project('private');
  processHook(config, 'claude', call(cwd, 'no-record', 'UserPromptSubmit', { prompt: 'do not record; inspect OneScreen' }));
  processHook(config, 'claude', call(cwd, 'no-record', 'Stop', { last_assistant_message: 'private reply' }));
  assert.equal(loadRoutes(config).length, 0); assert.equal(checkpointHealth(config).pending.length, 0);
  const state = JSON.parse(fs.readFileSync(path.join(config.policyRoot, 'state/hook-sessions', sha('claude\0no-record').slice(0, 24), 'session.json')));
  assert.equal(state.checkpoint.reason, 'no-record'); assert.equal(state.prompt, '');
});
test('workspace transport failure stays pending, is reported and can retry without duplication', (t) => {
  const { config, transport, project, call } = fixture(t); const cwd = project('retry');
  processHook(config, 'claude', call(cwd, 'retry', 'UserPromptSubmit', { prompt: 'OneScreen lookup' }));
  processHook(config, 'claude', call(cwd, 'retry', 'Stop', { last_assistant_message: 'Lookup reply' }));
  assert.equal(drainCheckpoints(config, { ...transport, create() { throw new Error('CLI offline'); } }).errors.length, 1);
  assert.match(checkpointHealth(config).pending[0].error, /CLI offline/); assert.equal(loadEvents(config).length, 0);
  assert.equal(drainCheckpoints(config, transport).processed, 1); assert.equal(drainCheckpoints(config, transport).processed, 0);
  assert.equal(checkpointHealth(config, loadEvents(config)).healthy, true);
});
test('finished but silently unqueued session fails health even when event pending is zero', (t) => {
  const { config, project } = fixture(t); const cwd = project('missed'); const dir = path.join(config.policyRoot, 'state/hook-sessions/old'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ host: 'claude', cwd, turn: 1, lastStop: true, prompt: 'OneScreen', tools: 47 }));
  const health = checkpointHealth(config, []); assert.equal(health.healthy, false); assert.equal(health.unqueued.length, 1); assert.equal(health.pending.length, 0);
});

test('SessionEnd without reply cannot replace the richer Stop checkpoint', (t) => {
  const { config, transport, project, call } = fixture(t); const cwd = project('end');
  processHook(config, 'claude', call(cwd, 'end', 'UserPromptSubmit', { prompt: 'OneScreen adapter' }));
  processHook(config, 'claude', call(cwd, 'end', 'PostToolUse', { tool_name: 'Read' }));
  processHook(config, 'claude', call(cwd, 'end', 'Stop', { last_assistant_message: 'Preserve mount contract answer.' }));
  assert.equal(drainCheckpoints(config, transport).processed, 1);
  processHook(config, 'claude', call(cwd, 'end', 'SessionEnd'));
  assert.equal(drainCheckpoints(config, transport).processed, 0);
  assert.equal(loadEvents(config).length, 1);
  assert.match(loadEvents(config)[0].contexts[0].text, /Preserve mount contract answer/);
  processHook(config, 'claude', call(cwd, 'end', 'UserPromptSubmit', { prompt: 'do not record private content' }));
  processHook(config, 'claude', call(cwd, 'end', 'Stop', { last_assistant_message: 'private reply' }));
  const sessionFile = path.join(config.policyRoot, 'state/hook-sessions', sha('claude\0end').slice(0, 24), 'session.json');
  assert.equal(JSON.parse(fs.readFileSync(sessionFile)).lastAssistant, '');
});

test('recovered checkpoint preserves original occurrence time rather than repair time', (t) => {
  const { config, transport, project, call } = fixture(t); const cwd = project('recovery'); const occurredAt = '2026-09-08T07:55:32.675Z';
  processHook(config, 'claude', call(cwd, 'recovery', 'UserPromptSubmit', { prompt: 'OneScreen lookup' }));
  processHook(config, 'claude', call(cwd, 'recovery', 'Stop', { last_assistant_message: 'Original reply' }), { occurredAt });
  assert.equal(drainCheckpoints(config, transport).processed, 1); assert.equal(loadEvents(config)[0].occurred_at, occurredAt);
});
