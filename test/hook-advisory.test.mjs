// Coverage for the hook advisory path (QA-01).
//
// Codex turns an injected additionalContext into a developer message. PreToolUse fires
// between a tool call and its output, and PostToolUse can fire while the other calls of the
// same assistant message are still outstanding, so an advisory injected mid-sequence splits
// tool_calls from its tool results and strict Responses providers reject that ordering. An
// advisory is therefore carried to the next prompt for Codex, while a deny decision is
// returned immediately and unconditionally.
//
// These tests pin all four branches: deferral on for Codex, several tool results inside one
// assistant message, the explicit opt-out, and the non-Codex hosts that inject inline. The
// last test pins the ordering guarantee that deny beats deferral.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { processHook } from '../lib/hooks.mjs';
import { sha } from '../lib/transport.mjs';

const FAILURE_ADVISORY = /本次工具失败不是已确认错误/;
const SEARCH_ADVISORY = /已进行多步搜索/;
const DEFERRED_MARKER = /延后送达/;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-hook-advisory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics: [] };
  for (const dir of ['work/projects', 'work/events', 'work/inbox']) fs.mkdirSync(path.join(config.vaultRoot, dir), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  const fence = String.fromCharCode(96).repeat(3);
  fs.writeFileSync(path.join(config.vaultRoot, config.habitsNote), '# Habits\n' + fence + 'json\n{"rules":[]}\n' + fence);
  let counter = 0;
  const project = () => { const cwd = path.join(root, 'projects', `p${counter++}`); fs.mkdirSync(cwd, { recursive: true }); return cwd; };
  const call = (cwd, session, event, extra = {}) => ({ cwd, session_id: session, hook_event_name: event, ...extra });
  return { root, config, project, call };
}

/** The persisted per-session hook state, which is where a deferred advisory lives. */
function stateOf(config, host, session) {
  const file = path.join(config.policyRoot, 'state/hook-sessions', sha(`${host}\0${session}`).slice(0, 24), 'session.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const contextOf = (output) => output?.hookSpecificOutput?.additionalContext ?? '';

test('a Codex advisory is not injected mid-sequence but carried to the next prompt', (t) => {
  const { config, project, call } = fixture(t);
  const cwd = project();
  processHook(config, 'codex', call(cwd, 'defer', 'UserPromptSubmit', { prompt: 'investigate the adapter' }));

  // Mid-sequence: no developer message, or the tool_calls / tool results ordering breaks.
  const mid = processHook(config, 'codex', call(cwd, 'defer', 'PostToolUseFailure', { tool_name: 'Read', tool_response: { isError: true } }));
  assert.deepEqual(mid, {});
  assert.equal(stateOf(config, 'codex', 'defer').deferredAdvisory.length, 1);

  // Delivered with the next prompt instead...
  const next = processHook(config, 'codex', call(cwd, 'defer', 'UserPromptSubmit', { prompt: 'carry on' }));
  assert.match(contextOf(next), DEFERRED_MARKER);
  assert.match(contextOf(next), FAILURE_ADVISORY);

  // ...exactly once, so it cannot accumulate across later turns.
  const later = processHook(config, 'codex', call(cwd, 'defer', 'UserPromptSubmit', { prompt: 'and again' }));
  assert.doesNotMatch(contextOf(later), DEFERRED_MARKER);
  assert.deepEqual(stateOf(config, 'codex', 'defer').deferredAdvisory, []);
});

test('several tool results inside one assistant message are all deferred, bounded to the last three', (t) => {
  const { config, project, call } = fixture(t);
  const cwd = project();
  processHook(config, 'codex', call(cwd, 'multi', 'UserPromptSubmit', { prompt: 'run the checks' }));

  for (let index = 0; index < 4; index++) {
    const output = processHook(config, 'codex', call(cwd, 'multi', 'PostToolUseFailure', { tool_name: 'Bash', tool_response: { isError: true } }));
    assert.deepEqual(output, {}, 'no part of the sequence may receive a developer message');
  }
  // Bounded, so a long turn cannot grow the state file without limit.
  assert.equal(stateOf(config, 'codex', 'multi').deferredAdvisory.length, 3);

  const next = processHook(config, 'codex', call(cwd, 'multi', 'UserPromptSubmit', { prompt: 'next' }));
  const delivered = contextOf(next).split('延后送达').length - 1;
  assert.equal(delivered, 3, 'all three retained advisories arrive together');
});

test('the multi-step search advisory fires on the fifth tool result and is deferred for Codex', (t) => {
  const { config, project, call } = fixture(t);
  const cwd = project();
  processHook(config, 'codex', call(cwd, 'search', 'UserPromptSubmit', { prompt: 'find the definition' }));

  for (let index = 1; index <= 4; index++) {
    processHook(config, 'codex', call(cwd, 'search', 'PostToolUse', { tool_name: 'Grep', tool_input: { command: 'rg adapter src' } }));
  }
  assert.deepEqual(stateOf(config, 'codex', 'search').deferredAdvisory ?? [], [], 'nothing is queued before the fifth result');

  processHook(config, 'codex', call(cwd, 'search', 'PostToolUse', { tool_name: 'Grep', tool_input: { command: 'rg adapter src' } }));
  const queued = stateOf(config, 'codex', 'search').deferredAdvisory;
  assert.equal(queued.length, 1);
  assert.match(queued[0].text, SEARCH_ADVISORY);
});

for (const host of ['claude', 'zcode', 'dsh']) {
  test(`${host} receives the advisory inline instead of deferred`, (t) => {
    const { config, project, call } = fixture(t);
    const cwd = project();
    processHook(config, host, call(cwd, 'inline', 'UserPromptSubmit', { prompt: 'investigate' }));
    const output = processHook(config, host, call(cwd, 'inline', 'PostToolUseFailure', { tool_name: 'Read', tool_response: { isError: true } }));
    assert.match(contextOf(output), FAILURE_ADVISORY);
    assert.deepEqual(stateOf(config, host, 'inline').deferredAdvisory ?? [], []);
  });
}

test('hook.codexDeferAdvisory: false restores inline injection for Codex', (t) => {
  const { config, project, call } = fixture(t);
  const cwd = project();
  const opted = { ...config, hook: { codexDeferAdvisory: false } };
  processHook(opted, 'codex', call(cwd, 'opted', 'UserPromptSubmit', { prompt: 'investigate' }));
  const output = processHook(opted, 'codex', call(cwd, 'opted', 'PostToolUseFailure', { tool_name: 'Read', tool_response: { isError: true } }));
  assert.match(contextOf(output), FAILURE_ADVISORY);
  assert.deepEqual(stateOf(opted, 'codex', 'opted').deferredAdvisory ?? [], []);
});

test('a deny decision is returned immediately even while deferral is active', (t) => {
  const { config, project, call } = fixture(t);
  const cwd = project();
  processHook(config, 'codex', call(cwd, 'deny', 'UserPromptSubmit', { prompt: 'run a command' }));

  // A PowerShell automatic variable assigned as a business variable is a matched hazard, and
  // a search-kind tool without a declared boundary also produces a warning - so this call has
  // an advisory to defer and a deny to return at the same time.
  const output = processHook(config, 'codex', call(cwd, 'deny', 'PreToolUse', { tool_name: 'Grep', tool_input: { command: '$HOME = 1' } }));
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /自动变量/);
  assert.equal(output.hookSpecificOutput.additionalContext, undefined, 'a deny must not also carry a developer message');

  // The advisory it would otherwise have injected is still queued for the next prompt.
  assert.equal(stateOf(config, 'codex', 'deny').deferredAdvisory.length, 1);
});
