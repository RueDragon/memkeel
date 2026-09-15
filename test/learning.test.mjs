import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateLearning, learningProjection, selectLearning, retention, operationCheck } from '../lib/experience.mjs';
import { normalizeHook, hookOutput, redact, processHook } from '../lib/hooks.mjs';
import { capture, maintain } from '../lib/lifecycle.mjs';
import { loadEvents, recallLearning, bootstrap } from '../lib/core.mjs';

const entry = { event_id: 'learn-0001', workspace: 'scm', topic: 'scm/code', at: '', occurred_at: '2026-09-08T00:00:00Z', evidence: ['proof.md'],
  experiences: [{ id: 'jar', kind: 'path-finding', scope: 'scm', triggers: ['opb', 'jar'], location: 'C:/deps/opb.jar', text: 'OPB jar in dependency directory', verification: 'Observed file exists', operations: ['search'] }] };
const now = '2026-09-08T03:00:00Z';
test('experience selection is scoped and operation-aware; unrelated query is empty', () => {
  validateLearning(entry, {});
  assert.equal(selectLearning([entry], { workspace: 'scm', query: 'opb', now }).length, 1);
  assert.equal(selectLearning([entry], { workspace: 'od', query: 'opb', now }).length, 0);
  assert.equal(selectLearning([entry], { workspace: 'scm', query: 'weather', now }).length, 0);
  assert.equal(selectLearning([entry], { workspace: 'scm', operation: 'search', now })[0].needsReverify, true);
});
test('negative search must specify boundary and expiry', () => {
  const row = { ...entry.experiences[0], kind: 'negative-search' };
  assert.throws(() => validateLearning({ ...entry, experiences: [row] }, {}), /boundary/);
  validateLearning({ ...entry, experiences: [{ ...row, boundary: 'src only', expires: '2026-09-10' }] }, {});
});
test('supersedes is required for changed experience; invalidation does not resurrect old entry', () => {
  const revision = { ...entry, event_id: 'learn-0002', experiences: [{ ...entry.experiences[0], text: 'new' }] };
  assert.equal(learningProjection([entry, revision]).conflicts.length, 1);
  revision.experiences[0].supersedes = entry.event_id;
  revision.experiences[0].status = 'invalidated';
  assert.equal(selectLearning([entry, revision], { workspace: 'scm', query: 'opb', now }).length, 0);
});
test('hot/warm/dormant contexts retain evidence but reads do not refresh expiry', () => {
  const e = { ...entry, contexts: [{ id: 'task-1', task: 'UI branch x', text: 'continue layout', ttl_days: 30 }] };
  const r = learningProjection([e]).entries.find((r) => r.type === 'contexts');
  assert.equal(retention(r, now), 'hot');
  assert.equal(retention(r, '2026-09-20'), 'warm');
  assert.equal(retention(r, '2026-10-20'), 'dormant');
  assert.equal(selectLearning([e], { type: 'contexts', workspace: 'scm', now: '2026-10-20' }).length, 0);
  assert.equal(selectLearning([e], { type: 'contexts', workspace: 'scm', now: '2026-10-20', history: true }).length, 1);
  assert.equal(selectLearning([e], { type: 'contexts', now }).length, 0);
});
test('PowerShell definite errors denied, valid and quoted examples allowed', () => {
  assert.equal(operationCheck({ kind: 'shell', command: '$HOME = 3' }).allowed, false);
  assert.equal(operationCheck({ kind: 'shell', command: 'foreach ($Host in $rows) { $Host }' }).allowed, false);
  assert.equal(operationCheck({ kind: 'shell', command: 'foreach ($x in $rows) { $x } | Sort-Object' }).allowed, false);
  assert.equal(operationCheck({ kind: 'shell', shell: 'pwsh', command: "Write-Output '$HOME = 3'" }).allowed, true);
  assert.equal(operationCheck({ kind: 'shell', command: '$taskRoot = 3' }).allowed, true);
  const encoded = Buffer.from('$Host = 3', 'utf16le').toString('base64');
  assert.equal(operationCheck({ kind: 'shell', command: `pwsh -EncodedCommand ${encoded}` }).allowed, false);
});
test('hook output never grants allow permissions; redaction strips common secrets', () => {
  assert.deepEqual(hookOutput('PreToolUse'), {});
  assert.equal(hookOutput('PreToolUse', '', 'bad').hookSpecificOutput.permissionDecision, 'deny');
  assert.doesNotMatch(redact('password=secret123 Bearer abc123456 api_key="abc123"'), /secret123|abc123/);
  assert.equal(normalizeHook('codex', { tool_name: 'exec_command', tool_input: { cmd: 'rg jar' } }).operation.kind, 'search');
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, now, topics: [{ id: 'scm/code', workspace: 'scm', title: 'SCM code', aliases: ['OPB'], path: 'work/topics/code.md' }] };
  for (const dir of ['work/projects', 'work/inbox', 'work/events', 'work/topics']) fs.mkdirSync(path.join(config.vaultRoot, dir), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.vaultRoot, 'work/projects/workspace-scm.md'), `---\nworkspace: '${root.replaceAll('\\', '/')}'\nproject: SCM\n---\n# SCM`);
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n```json\n{"rules":[]}\n```');
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  const transport = {
    create(p, c) { fs.mkdirSync(path.dirname(path.join(config.vaultRoot, p)), { recursive: true }); fs.writeFileSync(path.join(config.vaultRoot, p), c); },
    append(p, c) { fs.appendFileSync(path.join(config.vaultRoot, p), '\n\n' + c); },
    verify(p) { return fs.readFileSync(path.join(config.vaultRoot, p), 'utf8'); },
    managed(p, h, b) { this.create(p, `${h}\n<!-- AUTO-MANAGED:START -->\n${b}\n<!-- AUTO-MANAGED:END -->`); }
  };
  return { config, root, transport, hook: (event, extra = {}) => ({ hook_event_name: event, cwd: root, session_id: 'probe-session', ...extra }) };
}
test('native startup once, operation denial, reported checkpoint, idempotent replay and recall', (t) => {
  const { root, config, transport, hook } = fixture(t);
  assert.match(JSON.stringify(processHook(config, 'codex', hook('SessionStart'))), /agent-memory-hook:bootstrap/);
  assert.deepEqual(processHook(config, 'codex', hook('SessionStart')), {});
  processHook(config, 'codex', hook('UserPromptSubmit', { prompt: 'OPB dependency investigation' }));
  assert.equal(processHook(config, 'codex', hook('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: '$Host = 1' } })).hookSpecificOutput.permissionDecision, 'deny');
  processHook(config, 'codex', hook('Stop', { last_assistant_message: 'Local lookup pending verification.', occurredAt: now }), { occurredAt: now });
  assert.equal(maintain(config, transport).checkpoints.processed, 1);
  assert.equal(maintain(config, transport).checkpoints.processed, 0);
  const rows = recallLearning(config, { cwd: root, type: 'contexts', query: 'OPB' });
  assert.equal(rows.length, 1); assert.equal(rows[0].certainty, 'reported');
  assert.match(bootstrap(config, root, 'OPB').text, /Local lookup pending/);
  assert.equal(loadEvents(config)[0].facts, undefined);
});
test('no-record requests never enter checkpoint queue', (t) => {
  const { config, hook } = fixture(t);
  processHook(config, 'claude', hook('UserPromptSubmit', { prompt: '只读验收，不写入记忆' }));
  processHook(config, 'claude', hook('Stop', { last_assistant_message: 'Answer' }));
  assert.equal(fs.existsSync(path.join(config.policyRoot, 'state/hook-queue')), false);
});
test('capturing an experience supports durable readback and context-free bootstrap', (t) => {
  const { config, transport, root } = fixture(t);
  const input = { ...entry, agent: 'codex', evidence: undefined, occurred_at: now };
  capture(config, transport, input, 'Observed dependency file on the test fixture.');
  assert.equal(recallLearning(config, { cwd: root, query: 'opb' }).length, 1);
  assert.doesNotMatch(bootstrap(config, root, 'unrelated').text, /OPB jar in dependency directory/);
});

for (const model of ['demo-model', 'deepseek', '']) {
  test(`Codex defers advisory for ${model || 'unknown'} with a legacy empty list`, (t) => {
    const { config, hook } = fixture(t);
    config.hook = { codexDeferredAdvisoryModels: [] };
    const output = processHook(config, 'codex', hook('PreToolUse', {
      model, tool_name: 'exec_command', tool_input: { cmd: 'rg project' },
    }));
    assert.equal(output.hookSpecificOutput?.additionalContext, undefined);
    const dirs = fs.readdirSync(path.join(config.policyRoot, 'state/hook-sessions'));
    const state = JSON.parse(fs.readFileSync(path.join(config.policyRoot, 'state/hook-sessions', dirs[0], 'session.json'), 'utf8'));
    assert.ok(state.deferredAdvisory.length > 0);
    const prompt = processHook(config, 'codex', hook('UserPromptSubmit', { prompt: 'continue' }));
    assert.match(JSON.stringify(prompt), /延后送达/);
  });
}