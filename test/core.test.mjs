import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localDay, normalizeWorkspace, matchRoute, selectHabits, reduceEvents, validateEvent, record, consolidate, loadEvents, bootstrap, recall, refreshIndex } from '../lib/core.mjs';
import { inside, withLock } from '../lib/transport.mjs';
import { applyInjectionBudget } from '../vendor/obsidian-mind/session-start.ts';
import { capture, decideHabit, maintain } from '../lib/lifecycle.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groupLegacySources } from '../lib/catalog.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lu-memory-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, recentDays: 14, now: '2026-09-07T12:00:00+08:00', budgetBytes: 10000, workspaceAliases: {}, topics: [{ id: 'scm/channel', workspace: 'scm', title: 'SCM ChannelConfig', aliases: ['ChannelConfig'], path: 'work/topics/channel.md' }] };
  for (const folder of ['work/projects', 'work/inbox', 'work/events', 'work/topics']) fs.mkdirSync(path.join(config.vaultRoot, folder), { recursive: true });
  fs.mkdirSync(config.policyRoot, { recursive: true });
  fs.writeFileSync(path.join(config.vaultRoot, 'work/projects/workspace-scm.md'), "---\nworkspace: 'C:\\Code\\SCM'\nproject: SCM\nstatus: active\n---\n# SCM\n");
  fs.writeFileSync(path.join(config.vaultRoot, 'work/inbox/evidence.md'), '---\ntype: session-closeout\nworkspace: C:\\Code\\SCM\ndate: 2026-09-01\n---\n# ChannelConfig\n\n## 2026-09-01\n- changed one thing\n');
  fs.writeFileSync(path.join(config.vaultRoot, 'work/habits.md'), '# Habits\n```json\n{"rules":[{"id":"global","status":"confirmed","scope":"global","text":"Use Chinese"}]}\n```');
  const transport = {
    create(relative, content) { const full = inside(config.vaultRoot, relative); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, content); },
    append(relative, content) { fs.appendFileSync(inside(config.vaultRoot, relative), `\n\n${content}`); },
    verify(relative) { return fs.readFileSync(inside(config.vaultRoot, relative), 'utf8').trim(); },
    managed(relative, header, body) {
      const file = inside(config.vaultRoot, relative);
      const block = `<!-- AUTO-MANAGED:START -->\n${body}\n<!-- AUTO-MANAGED:END -->`;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, `${header}\n\n${block}`);
      else fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/<!-- AUTO-MANAGED:START -->[\s\S]*?<!-- AUTO-MANAGED:END -->/, block));
    }
  };
  const event = { event_id: 'test-event-001', workspace: 'scm', topic: 'scm/channel', agent: 'codex', occurred_at: '2026-08-01T12:00:00+08:00',
    recorded_at: '2026-09-07T12:00:00+08:00', evidence: ['work/inbox/evidence.md'], facts: [{ key: 'width', text: 'Flexible width' }], actions: [{ id: 'verify-ui', status: 'open', text: 'Verify UI' }] };
  return { root, config, transport, event };
}
test('Windows, WSL and child directory route to same workspace', () => {
  const routes = [{ id: 'scm', workspace: 'C:\\Code\\SCM', aliases: ['D:/worktrees/scm-fix'] }];
  assert.equal(normalizeWorkspace('/mnt/c/Code/SCM/'), 'c:/code/scm');
  assert.equal(matchRoute('C:/Code/SCM/src', routes).id, 'scm');
  assert.equal(matchRoute('D:/worktrees/scm-fix/src', routes).id, 'scm');
  assert.equal(matchRoute('C:/Code/SCM-other', routes), undefined);
});
test('Shanghai calendar handles UTC midnight boundary', () => { assert.equal(localDay('2026-09-06T16:01:00Z'), '2026-09-07'); });
test('temporary, candidate, expired and wrong-scope preferences do not activate', () => {
  const rules = [
    { id: 'global', status: 'confirmed', scope: 'global' }, { id: 'temporary', status: 'session-only', scope: 'global' },
    { id: 'candidate', status: 'candidate', scope: 'global' }, { id: 'other', status: 'confirmed', scope: 'od' },
    { id: 'task', status: 'confirmed', scope: 'task', triggers: ['powershell'] },
    { id: 'expired', status: 'confirmed', scope: 'global', expires: '2020-01-01' }
  ];
  assert.deepEqual(selectHabits(rules, 'scm', 'PowerShell').map((rule) => rule.id), ['global', 'task']);
});
test('explicit supersedes updates a fact, unrelated new claim becomes conflict', () => {
  const base = { event_id: 'a', topic: 't', occurred_at: '2026-01-01', evidence: [], facts: [{ key: 'width', text: '210px' }] };
  const second = { ...base, event_id: 'b', facts: [{ key: 'width', text: 'flex', supersedes: 'a' }] };
  const third = { ...base, event_id: 'c', facts: [{ key: 'width', text: '300px' }] };
  const result = reduceEvents([base, second, third]);
  assert.equal(result.facts[0].text, 'flex'); assert.equal(result.conflicts.length, 1);
});
test('duplicate event mutation is rejected', () => {
  assert.throws(() => reduceEvents([{ event_id: 'a', facts: [] }, { event_id: 'a', facts: [{ key: 'x', text: 'y' }] }]), /mutation/);
});
test('unknown workspace/topic, missing evidence and secret are rejected', (t) => {
  const { config, event } = fixture(t);
  assert.throws(() => validateEvent({ ...event, workspace: 'od' }, config), /Unknown/);
  assert.throws(() => validateEvent({ ...event, evidence: [] }, config), /evidence/);
  assert.throws(() => validateEvent({ ...event, apiKey: 'very-secret-value' }, config), /secret/);
});
test('journal dedup preserves original recorded_at on retry', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, event);
  const retry = { ...event }; delete retry.recorded_at;
  assert.equal(record(config, transport, retry).duplicate, true);
  assert.equal(loadEvents(config).length, 1);
});
test('missed runs are replayed, same day appends are not dropped', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, event);
  const first = consolidate(config, transport);
  assert.equal(first.pendingBefore, 1); assert.equal(first.pending, 0);
  record(config, transport, { ...event, event_id: 'test-event-002', facts: [{ key: 'status', text: 'active' }] });
  assert.equal(consolidate(config, transport).pendingBefore, 1);
  assert.equal(consolidate(config, transport).pending, 0);
});
test('crash before checkpoint can retry without duplicating projection or damaging manual text', (t) => {
  const { config, transport, event } = fixture(t); record(config, transport, event);
  assert.throws(() => consolidate(config, transport, { failBeforeCheckpoint: true }), /Injected/);
  const file = inside(config.vaultRoot, config.topics[0].path);
  fs.appendFileSync(file, '\n## Manual\nKeep this.');
  consolidate(config, transport);
  const result = fs.readFileSync(file, 'utf8');
  assert.equal((result.match(/Flexible width/g) ?? []).length, 1); assert.match(result, /Keep this/);
});
test('consumed event mutation is detected', (t) => {
  const { config, transport, event } = fixture(t); const journal = record(config, transport, event).path; consolidate(config, transport);
  const full = inside(config.vaultRoot, journal); fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('Flexible width', 'Mutated width'));
  assert.throws(() => consolidate(config, transport), /changed/);
});
test('one writer lock rejects concurrent consumption without stealing lock', (t) => {
  const { config } = fixture(t); const root = path.join(config.policyRoot, 'state');
  withLock(root, () => assert.throws(() => withLock(root, () => {}), /locked/));
  assert.equal(fs.existsSync(path.join(root, 'writer.lock')), false);
});
test('path traversal and absolute paths cannot enter the vault', (t) => {
  const { config } = fixture(t); assert.throws(() => inside(config.vaultRoot, '../escape'), /escapes/); assert.throws(() => inside(config.vaultRoot, 'C:/secret'), /relative/);
});
test('upstream mind budget keeps mandatory context and marks fallback sections', () => {
  const result = applyInjectionBudget([{ header: '# Habits', body: 'required', priority: 0 },
    { header: '# Active projects', body: 'x'.repeat(5000), priority: 1, fallback: 'three projects and link' }], 200);
  assert.match(result.text, /required/); assert.match(result.text, /three projects/); assert.deepEqual(result.collapsed, ['Active projects']);
});
test('bootstrap includes activity and recent changes, repeated startup reuses index', (t) => {
  const { config } = fixture(t);
  const first = bootstrap(config, 'C:/Code/SCM', 'ChannelConfig'); refreshIndex(config); const second = bootstrap(config, 'C:/Code/SCM', 'ChannelConfig');
  assert.match(first.text, /活动项目/); assert.match(first.text, /近期变化/); assert.match(first.text, /changed one thing/);
  assert.ok(first.io.changed > 0); assert.equal(second.io.changed, 0);
});
test('canonical topic wins over historical claims; historical sources remain accessible', (t) => {
  const { config, transport, event } = fixture(t); record(config, transport, event); consolidate(config, transport);
  const result = recall(config, 'ChannelConfig', 'scm');
  assert.equal(result.length, 1); assert.equal(result[0].canonical, true); assert.match(result[0].excerpt, /Flexible width/);
  assert.ok(recall(config, 'ChannelConfig', 'scm', true).length > 0);
});
test('startup does not promote import date or reintroduce superseded facts', (t) => {
  const { config, transport, event } = fixture(t);
  config.recentDays = 60;
  record(config, transport, event);
  record(config, transport, { ...event, event_id: 'test-event-002', facts: [{ key: 'width', text: 'Revised width', supersedes: event.event_id }], actions: [] });
  consolidate(config, transport);
  const result = bootstrap(config, 'C:/Code/SCM', 'ChannelConfig');
  assert.doesNotMatch(result.text, /Flexible width/);
  assert.match(result.text, /2026-08-01（2026-09-07 录入）/);
});
test('recent window excludes old imported events without hiding dated activity', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, event); consolidate(config, transport);
  const result = bootstrap(config, 'C:/Code/SCM');
  assert.match(result.text, /近期无新记录，不代表停工/);
  assert.match(result.text, /近 14 天没有已记录变化/);
  assert.doesNotMatch(result.text.split('## 近期变化')[1], /Flexible width/);
  assert.equal(result.recentWindow.from, '2026-08-25');
});
test('unconsumed events warn at startup and hide stale topic snapshots until retry', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, event); consolidate(config, transport);
  record(config, transport, { ...event, event_id: 'test-event-002', facts: [{ key: 'width', text: 'New width', supersedes: event.event_id }] });
  const result = bootstrap(config, 'C:/Code/SCM', 'ChannelConfig');
  assert.equal(result.consumption.pending, 1);
  assert.match(result.text, /尚未完成归档/);
  assert.doesNotMatch(result.text, /Flexible width/);
  assert.equal(recall(config, 'ChannelConfig', 'scm')[0].stale, true);
  consolidate(config, transport);
  assert.equal(bootstrap(config, 'C:/Code/SCM').consumption.pending, 0);
  assert.equal(recall(config, 'ChannelConfig', 'scm')[0].stale, false);
});
test('bootstrap and recall reject mutation of already consumed evidence events', (t) => {
  const { config, transport, event } = fixture(t);
  const journal = record(config, transport, event).path; consolidate(config, transport);
  const full = inside(config.vaultRoot, journal);
  fs.writeFileSync(full, fs.readFileSync(full, 'utf8').replace('Flexible width', 'Tampered width'));
  assert.throws(() => bootstrap(config, 'C:/Code/SCM'), /changed/);
  assert.throws(() => recall(config, 'ChannelConfig', 'scm'), /changed/);
});
test('journal replay compares instants rather than lexicographic timezone strings', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, { ...event, recorded_at: '2026-09-07T12:00:00+08:00' });
  record(config, transport, { ...event, event_id: 'test-event-002', recorded_at: '2026-09-07T05:00:00Z', facts: [{ key: 'width', text: 'Later revision', supersedes: event.event_id }] });
  assert.deepEqual(loadEvents(config).map((row) => row.event_id), [event.event_id, 'test-event-002']);
  consolidate(config, transport);
  assert.match(recall(config, 'ChannelConfig', 'scm')[0].excerpt, /Later revision/);
});
test('startup groups same-topic events and displays each current fact and action only once', (t) => {
  const { config, transport, event } = fixture(t);
  config.recentDays = 60;
  record(config, transport, event);
  record(config, transport, { ...event, event_id: 'test-event-002', facts: [{ key: 'error-ui', text: 'Scoped error dialogs' }], actions: [] });
  consolidate(config, transport);
  const result = bootstrap(config, 'C:/Code/SCM', 'ChannelConfig');
  assert.match(result.text, /2 条相关事件/);
  for (const text of ['Flexible width', 'Scoped error dialogs', 'Verify UI']) assert.equal(result.text.split(text).length - 1, 1);
  assert.doesNotMatch(result.text, /## 历史证据/);
  assert.match(bootstrap(config, 'C:/Code/SCM').text, /Flexible width/);
});
test('bootstrap and recall require no writes even without a cache', (t) => {
  const { config } = fixture(t);
  assert.deepEqual(fs.readdirSync(config.policyRoot), []);
  assert.match(bootstrap(config, 'C:/Code/SCM').text, /changed one thing/);
  assert.ok(recall(config, 'ChannelConfig', 'scm', true).length);
  assert.deepEqual(fs.readdirSync(config.policyRoot), []);
});
test('capture evidence, event and projection replay without duplicates', (t) => {
  const { config, transport, event } = fixture(t);
  const input = { ...event }; delete input.evidence;
  delete input.occurred_at;
  const first = capture(config, transport, input, 'Verified a read-only bootstrap. No business files changed.');
  const second = capture(config, transport, input, 'Verified a read-only bootstrap. No business files changed.');
  assert.equal(first.duplicate, false); assert.equal(second.duplicate, true);
  assert.equal(loadEvents(config).length, 1);
  const evidence = fs.readFileSync(inside(config.vaultRoot, first.evidence.split('#')[0]), 'utf8');
  assert.equal(evidence.split(`## ${event.event_id}`).length - 1, 1);
  assert.throws(() => capture(config, transport, input, 'Different evidence'), /different/);
});
test('explicit confirmed preference activates by scope, rejection removes it, and retries are idempotent', (t) => {
  const { config, transport, event } = fixture(t);
  fs.appendFileSync(inside(config.vaultRoot, event.evidence[0]), '\nUser: For this project, require a real host smoke test.\nUser: Retire this preference.');
  const candidate = { ...event, facts: [], actions: [], preferences: [{ id: 'host-probe', status: 'candidate', scope: 'scm', triggers: ['smoke'], text: 'Require a real host smoke test' }] };
  record(config, transport, candidate); consolidate(config, transport);
  assert.doesNotMatch(bootstrap(config, 'C:/Code/SCM', 'smoke').text, /\[host-probe\]/);
  const decision = { event_id: 'test-confirm-001', candidate_event: event.event_id, preference_id: 'host-probe', status: 'confirmed', evidence: event.evidence[0], user_quote: 'For this project, require a real host smoke test.' };
  decideHabit(config, transport, decision);
  assert.match(bootstrap(config, 'C:/Code/SCM', 'smoke').text, /\[host-probe\]/);
  assert.doesNotMatch(bootstrap(config, 'C:/Code/SCM', 'unrelated').text, /\[host-probe\]/);
  assert.equal(decideHabit(config, transport, decision).duplicate, true);
  decideHabit(config, transport, { ...decision, event_id: 'test-reject-002', status: 'rejected', user_quote: 'Retire this preference.' });
  assert.doesNotMatch(bootstrap(config, 'C:/Code/SCM', 'smoke').text, /\[host-probe\]/);
});
test('habit confirmation without real quoted evidence cannot append a decision', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, { ...event, preferences: [{ id: 'host-probe', status: 'candidate', scope: 'scm', text: 'Require host smoke' }] });
  assert.throws(() => decideHabit(config, transport, { event_id: 'test-confirm-001', candidate_event: event.event_id, preference_id: 'host-probe', status: 'confirmed', evidence: event.evidence[0], user_quote: 'Made-up user confirmation' }), /absent/);
  assert.equal(loadEvents(config).length, 1);
});
test('explicit rebuild repairs missing consumed projection without deleting evidence or manual sections', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, event); consolidate(config, transport);
  const file = inside(config.vaultRoot, config.topics[0].path); fs.unlinkSync(file);
  assert.equal(consolidate(config, transport).processed, 0);
  maintain(config, transport, { rebuild: true });
  fs.appendFileSync(file, '\nManual: preserve this.');
  maintain(config, transport, { rebuild: true });
  assert.match(fs.readFileSync(file, 'utf8'), /Flexible width/);
  assert.match(fs.readFileSync(file, 'utf8'), /Manual: preserve this/);
  assert.equal(loadEvents(config).length, 1);
});
test('MCP protocol separates reads and writes and read-only bootstrap does not need cache writes', (t) => {
  const { config } = fixture(t); fs.writeFileSync(path.join(config.policyRoot, 'config.json'), JSON.stringify(config));
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'agent_memory_read', arguments: { action: 'bootstrap', cwd: 'C:/Code/SCM' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_memory', arguments: { action: 'execute-shell', input: { command: 'not allowed' } } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_memory_read', arguments: { action: 'capture' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'agent_memory_read', arguments: { action: 'bootstrap', workspace: 'C:/Code/SCM' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'agent_memory_read', arguments: { action: 'bootstrap', workspace: 'SCM' } } }
  ];
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../mcp-server.mjs', import.meta.url))], { env: { ...process.env, MEMKEEL_HOME: config.policyRoot }, input: messages.map((value) => JSON.stringify(value)).join('\n') + '\n', encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0);
  const responses = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses[1].result.tools.length, 2);
  assert.equal(responses[1].result.tools[0].annotations.readOnlyHint, true);
  assert.match(responses[2].result.content[0].text, /活动项目/);
  assert.equal(responses[3].result.isError, true);
  assert.equal(responses[4].result.isError, true);
  assert.match(responses[5].result.content[0].text, /活动项目/);
  assert.equal(responses[6].result.isError, true);
  assert.deepEqual(fs.readdirSync(config.policyRoot), ['config.json']);
});
test('workspace display names and Chinese questions retrieve current state rather than false absence', (t) => {
  const { config, transport, event } = fixture(t);
  record(config, transport, { ...event, facts: [{ key: 'dsh-roundtrip', text: 'dsh 已完成启动及收尾验收' }] }); consolidate(config, transport);
  const result = recall(config, '之前那次dsh启动和收尾的验收结果是什么', 'SCM');
  assert.equal(result[0].canonical, true); assert.match(result[0].excerpt, /test-event-001/);
  assert.throws(() => recall(config, 'dsh', 'not-a-project'), /Unknown or ambiguous/);
});
test('a date mentioned only in body or a linked source cannot make legacy history recent', (t) => {
  const { config } = fixture(t);
  const file = inside(config.vaultRoot, 'work/inbox/evidence.md');
  fs.appendFileSync(file, '\nReference only: 2026-09-07 another project report.');
  const index = refreshIndex(config);
  assert.equal(index.entries['work/inbox/evidence.md'].date, '2026-09-01');
});
test('logical catalog is config-driven and explicitly flags conflicting workspace metadata', (t) => {
  const { config } = fixture(t);
  const scoped = {
    ...config,
    catalogTopics: [{ id: 'demo/service-profile', workspace: 'demo', title: 'Demo Service Profile', aliases: ['Service Profile'], pattern: 'service.?profile' }],
  };
  const index = { entries: { x: { path: 'work/inbox/Demo Service Profile.md', title: 'Demo Service Profile', date: '2026-09-01', workspace: 'other', meta: {} } } };
  const result = groupLegacySources(scoped, index);
  assert.equal(result[0].authority, 'evidence-only');
  assert.equal(result[0].sources[0].scopeWarning, true);
  assert.equal(result[0].sources[0].declaredWorkspace, 'other');
  // The core ships with no project data: an empty catalog matches nothing.
  assert.deepEqual(groupLegacySources(config, index), []);
});
test('maintenance completes a capture interrupted after evidence append and before event append', (t) => {
  const { config, transport, event } = fixture(t);
  const broken = { ...transport, append(relative, content) { transport.append(relative, content); if (relative.includes('/Evidence/')) throw new Error('simulated interruption after evidence'); } };
  const input = { ...event }; delete input.evidence;
  assert.throws(() => capture(config, broken, input, 'Actual tested observation.'), /simulated/);
  assert.equal(loadEvents(config).length, 0);
  assert.deepEqual(maintain(config, transport).recoveredCaptures, [event.event_id]);
  assert.equal(loadEvents(config).length, 1);
  assert.deepEqual(maintain(config, transport).recoveredCaptures, []);
});
test('conflicting title and workspace metadata stays in evidence but not routine context', (t) => {
  const { config } = fixture(t);
  const file = inside(config.vaultRoot, 'work/inbox/evidence.md');
  fs.writeFileSync(file, '---\nworkspace: C:\\Code\\SCM\ndate: 2026-09-07\n---\n# OD WrongScopeSentinel\n\nOriginal historical evidence.');
  const index = refreshIndex(config);
  assert.equal(index.entries['work/inbox/evidence.md'].scopeWarning, true);
  assert.doesNotMatch(bootstrap(config, 'C:/Code/SCM').text, /WrongScopeSentinel/);
  assert.equal(recall(config, 'WrongScopeSentinel', 'scm').length, 0);
  assert.equal(recall(config, 'WrongScopeSentinel', 'scm', true)[0].scopeWarning, true);
  assert.equal(fs.existsSync(file), true);
});

test('digest rebuild restores hook contexts in Shanghai day and preserves manual text and immutable events', (t) => {
  const { config, transport, event } = fixture(t);
  const input = { ...event, occurred_at: '2026-09-07T16:01:00Z', recorded_at: '2026-09-07T16:02:00Z',
    facts: [], actions: [], contexts: [{ id: 'ctx-digest', task: 'Find test commit', text: 'Located commit, pending independent verification.', certainty: 'reported', ttl_days: 30 }] };
  const journal = record(config, transport, input).path;
  const original = fs.readFileSync(inside(config.vaultRoot, journal), 'utf8');
  consolidate(config, transport);
  const daily = inside(config.vaultRoot, 'work/inbox/2026-09-08 - Agent 每日总结.md');
  const read = () => fs.readFileSync(daily, 'utf8');
  assert.match(read(), /2026-09-08 00:01:00 \+08:00/);
  assert.match(read(), /2026-09-08 00:02:00 \+08:00/);
  assert.match(read(), /Located commit/);
  assert.match(read(), /对话报告，未复核/);
  fs.writeFileSync(daily, read().replace(/<!-- AUTO-MANAGED:START -->[\s\S]*?<!-- AUTO-MANAGED:END -->/,
    '<!-- AUTO-MANAGED:START -->\nOld empty hook entry\n<!-- AUTO-MANAGED:END -->') + '\n## Manual\nKeep digest notes.');
  consolidate(config, transport, { rebuild: true });
  assert.match(read(), /Located commit/);
  assert.match(read(), /Keep digest notes\./);
  assert.doesNotMatch(read(), /Old empty hook entry|\n{3,}/);
  assert.equal(fs.readFileSync(inside(config.vaultRoot, journal), 'utf8'), original);
  assert.deepEqual(consolidate(config, transport).changed, []);
});
