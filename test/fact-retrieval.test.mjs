import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectFacts, formatFacts } from '../lib/fact-retrieval.mjs';
import { redactSecrets } from '../lib/redaction.mjs';
import { processHook, redact } from '../lib/hooks.mjs';
import { record, consolidate, recall, recallFacts, reduceEvents, bootstrap, recallLearning } from '../lib/core.mjs';
import { capture } from '../lib/lifecycle.mjs';

const topics = [
  { id: 'od/environments', workspace: 'od', title: 'OD 环境与数据库连接', path: 'work/topics/env.md', aliases: ['Telkom POC'] },
  { id: 'home/diagnosis', workspace: 'home', title: 'DSH diagnosis', path: 'work/topics/home.md' }
];
const base = { event_id: 'env-test-0001', workspace: 'od', topic: 'od/environments', agent: 'codex',
  occurred_at: '2026-09-09T07:00:00Z', recorded_at: '2026-09-09T07:00:00Z', evidence: ['work/proof.md'], facts: [
    { key: 'portal', text: '82 环境 Portal 为 https://example.test/oss/，项目为 Telkom POC。' },
    { key: 'db', text: '82 环境 OD 库：MySQL，默认库 oss_od_demo。' },
    { key: 'other', text: '182 环境属于另一个测试项目。' }
  ] };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-facts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { policyRoot: path.join(root, 'policy'), vaultRoot: path.join(root, 'vault'), workRoot: 'work', projectRoot: 'work/projects', inboxRoot: 'work/inbox',
    eventsRoot: 'work/events', habitsNote: 'work/habits.md', actionsNote: 'work/actions.md', mistakesNote: 'work/mistakes.md', preferenceCandidatesNote: 'work/candidates.md',
    activeLimit: 6, recentLimit: 6, budgetBytes: 14000, topics, now: '2026-09-09T08:00:00Z' };
  const put = (p, c) => { const file = path.join(config.vaultRoot, p); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, c); };
  fs.mkdirSync(config.policyRoot, { recursive: true });
  put('work/projects/workspace-home.md', '---\nworkspace: ' + root.replaceAll('\\', '/') + '\nproject: Home\n---\n# Home');
  put('work/projects/workspace-od.md', '---\nworkspace: ' + root.replaceAll('\\', '/') + '/od\nproject: OD\n---\n# OD');
  put('work/habits.md', '# Habits\n\x60\x60\x60json\n{"rules":[]}\n\x60\x60\x60');
  put('work/proof.md', 'Synthetic evidence only.');
  const transport = { create: put, append(p, c) { fs.appendFileSync(path.join(config.vaultRoot, p), '\n\n' + c); },
    verify(p) { return fs.readFileSync(path.join(config.vaultRoot, p), 'utf8'); },
    managed(p, h, b) { put(p, h + '\n<!-- AUTO-MANAGED:START -->\n' + b + '\n<!-- AUTO-MANAGED:END -->'); } };
  record(config, transport, base); consolidate(config, transport);
  const hook = (prompt) => ({ hook_event_name: 'UserPromptSubmit', session_id: 'facts-test-session', cwd: root, prompt });
  return { config, root, transport, put, hook };
}
for (const query of ['82环境', '82 环境', '你知道82环境吗', '你还记得我的82环境吗', '８２环境']) {
  test('cross-project entity recall: ' + query, () => {
    const rows = selectFacts(topics, reduceEvents([base]), query, { workspace: 'home', crossWorkspace: true });
    assert.deepEqual(new Set(rows.map((r) => r.key)), new Set(['portal', 'db']));
    assert.ok(rows.every((r) => r.crossWorkspace && r.workspace === 'od'));
  });
}
test('explicit workspace stays strict and generic questions do not retrieve unrelated topics', () => {
  for (const query of ['环境', '知道吗', '项目', '你是否知道环境']) assert.equal(selectFacts(topics, reduceEvents([base]), query, { workspace: 'home', crossWorkspace: true }).length, 0);
  assert.equal(selectFacts(topics, reduceEvents([base]), '82环境', { workspace: 'home' }).length, 0);
  assert.deepEqual(selectFacts(topics, reduceEvents([base]), '182环境').map((r) => r.key), ['other']);
});
test('distinctive project name recalls across scopes without numeric identifiers', () => {
  assert.ok(selectFacts(topics, reduceEvents([base]), 'telkom poc', { workspace: 'home', crossWorkspace: true }).some((r) => r.key === 'portal'));
});
test('canonical definition outranks local diagnostic mentions', () => {
  const diagnostic = { ...base, event_id: 'diag-test-0001', topic: 'home/diagnosis', workspace: 'home', facts: [{ key: 'diagnosis', text: '2026-09-09 investigated 82 environment recall.' }] };
  assert.equal(selectFacts(topics, reduceEvents([base, diagnostic]), '82环境', { workspace: 'home', crossWorkspace: true })[0].workspace, 'od');
});
test('superseded facts never resurrect and unresolved conflicts remain visible', () => {
  const second = { ...base, event_id: 'env-test-0002', facts: [{ key: 'db', text: '82 环境 OD 库：new_db', supersedes: base.event_id }] };
  const conflict = { ...base, event_id: 'env-test-0003', facts: [{ key: 'db', text: '82 环境 OD 库：unconfirmed_db' }] };
  const rows = selectFacts(topics, reduceEvents([base, second, conflict]), '82环境');
  assert.equal(rows.find((r) => r.key === 'db').text, second.facts[0].text);
  assert.equal(rows.find((r) => r.key === 'db').conflict, true);
  assert.match(formatFacts(rows), /未解决冲突/);
});
test('fact context has a bounded byte budget', () => {
  const rows = selectFacts(topics, reduceEvents([base]), '82环境');
  for (const max of [100, 500, 800, 4800]) {
    const text = formatFacts(rows, max);
    assert.ok(Buffer.byteLength(text) <= max);
    if (max === 4800) assert.match(text, /oss_od_demo/);
  }
});
test('Chinese and English credential redaction is idempotent and preserves nonsecret environment metadata', () => {
  for (const input of ['密码是Fake@123，这只是测试', '口令：Fake@123', '密钥为"fake value"', 'password="fake value"', 'api_key=fake-value', 'https://user:fake@example.test/']) {
    const safe = redactSecrets(input);
    assert.doesNotMatch(safe, /Fake@123|fake value|fake-value|user:fake/);
    assert.equal(redactSecrets(safe), safe);
    assert.equal(redact(input), safe);
  }
  const metadata = '82 环境密码按 no-secret 规则不保存；默认库 oss_od_demo。';
  assert.equal(redactSecrets(metadata), metadata);
});
test('later and repeated DSH prompts automatically retrieve long-term facts after startup', (t) => {
  const { config, hook } = fixture(t);
  processHook(config, 'dsh', hook('你好'));
  for (const query of ['你知道82环境吗', '你知道82环境吗', '82 环境']) {
    const out = processHook(config, 'dsh', hook(query)).hookSpecificOutput.additionalContext;
    assert.match(out, /长期事实 od \/ 跨项目命中/);
    assert.match(out, /oss_od_demo/);
    assert.match(out, /example.test/);
    assert.doesNotMatch(out, /agent-memory-hook:bootstrap/);
  }
});
test('manual recall respects scope, rejects numeric near-matches and returns fact provenance', (t) => {
  const { config } = fixture(t);
  assert.equal(recall(config, '82环境', 'home').length, 0);
  assert.equal(recall(config, '999环境', 'od').length, 0);
  const rows = recall(config, '82环境', 'od');
  assert.ok(rows.every((r) => r.event_id === base.event_id && r.sourceType === 'fact-state'));
});
test('pending facts are withheld and consumed-event mutation is rejected', (t) => {
  const { config, transport } = fixture(t);
  record(config, transport, { ...base, event_id: 'env-test-0002', facts: [{ key: 'db', text: '82 环境新库：pending_db', supersedes: base.event_id }] });
  const rows = recallFacts(config, '82环境', 'home', true);
  assert.ok(rows.every((r) => r.stale));
  assert.doesNotMatch(JSON.stringify(rows), /pending_db/);
  const journal = path.join(config.vaultRoot, 'work/events/2026-09-09-od-codex.md');
  fs.writeFileSync(journal, fs.readFileSync(journal, 'utf8').replace('oss_od_demo', 'mutated_db'));
  assert.throws(() => recallFacts(config, '82环境', 'home', true), /Consumed event missing or changed/);
});
test('new captures reject Chinese credentials before any durable plan or evidence write', (t) => {
  const { config, transport } = fixture(t);
  assert.throws(() => capture(config, transport, { ...base, event_id: 'secret-test-001' }, '密码是Fake@123'), /Possible secret/);
  assert.equal(fs.existsSync(path.join(config.policyRoot, 'state/captures.json')), false);
  assert.throws(() => record(config, transport, { ...base, event_id: 'secret-test-002', facts: [{ key: 'bad', text: '密码是Fake@123' }] }), /Possible secret/);
});
test('historical source output is redacted without rewriting immutable evidence', (t) => {
  const { config, put } = fixture(t);
  const body = '---\nworkspace_id: home\ndate: 2026-09-09\n---\n# 999旧环境\n密码是Fake@123，999旧环境可用。';
  put('work/inbox/legacy.md', body);
  assert.doesNotMatch(JSON.stringify(recall(config, '999旧环境', 'home', true)), /Fake@123/);
  assert.doesNotMatch(bootstrap(config, 'unused', '999旧环境', 'home').text, /Fake@123/);
  assert.equal(fs.readFileSync(path.join(config.vaultRoot, 'work/inbox/legacy.md'), 'utf8'), body);
});

test('hook context stays within the UTF-8 byte limit and stores only fact identifiers in diagnostics', (t) => {
  const { config, hook } = fixture(t);
  const output = processHook(config, 'dsh', hook('82环境')).hookSpecificOutput.additionalContext;
  assert.ok(Buffer.byteLength(output) <= 18000);
  const dir = path.join(config.policyRoot, 'state/hook-sessions');
  const state = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0], 'session.json'), 'utf8'));
  assert.ok(state.factRecall.matched.some((r) => r.topic === 'od/environments'));
  assert.ok(state.factRecall.matched.every((r) => !('text' in r)));
});
test('Stop checkpoint redacts credentials before queue persistence', (t) => {
  const { config, hook, root } = fixture(t);
  processHook(config, 'dsh', hook('密码是Fake@123，请记住82环境'));
  processHook(config, 'dsh', { hook_event_name: 'Stop', cwd: root, session_id: 'facts-test-session', last_assistant_message: '密码是Fake@123，已记录。' });
  for (const name of fs.readdirSync(path.join(config.policyRoot, 'state/hook-queue'))) {
    const text = fs.readFileSync(path.join(config.policyRoot, 'state/hook-queue', name), 'utf8');
    assert.doesNotMatch(text, /Fake@123/);
    assert.match(text, /REDACTED/);
  }
});
