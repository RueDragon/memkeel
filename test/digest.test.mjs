import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyDigestBody, digestTime } from '../lib/digest.mjs';

const base = { event_id: 'digest-event', workspace: 'scm', topic: 'scm/task-context', agent: 'zcode',
  occurred_at: '2026-09-08T06:25:49.560Z', recorded_at: '2026-09-08T06:25:49.606Z', evidence: ['work/evidence.md#digest-event'] };

test('digest clock converts UTC and explicit offsets to Shanghai without changing instants', () => {
  assert.equal(digestTime(base.occurred_at), '2026-09-08 14:25:49 +08:00');
  assert.equal(digestTime('2026-09-08T14:25:49+08:00'), digestTime(base.occurred_at));
  assert.equal(digestTime('2026-09-07T16:00:00Z'), '2026-09-08 00:00:00 +08:00');
  assert.equal(digestTime('2026-09-07T15:59:59Z'), '2026-09-07 23:59:59 +08:00');
  assert.match(digestTime('invalid'), /无效时间/);
});

test('context-only hooks show task, bounded reported reply, evidence and audit ID', () => {
  const event = { ...base, contexts: [{ id: 'ctx', task: '查找合入单号', certainty: 'reported', ttl_days: 30,
    text: '任务要求（用户报告）：查找合入单号\n最近回复（未复核，不是当前事实）：定位到目标提交。' + '需复核'.repeat(200) }] };
  const before = JSON.stringify(event);
  const text = dailyDigestBody([event]);
  assert.match(text, /## scm · 查找合入单号/);
  assert.match(text, /摘要（对话报告，未复核）：定位到目标提交/);
  assert.match(text, /摘要已截断，详见证据/);
  assert.match(text, /\[\[work\/evidence#digest-event\]\]/);
  assert.match(text, /事件编号：.*digest-event/);
  assert.doesNotMatch(text, /\n{3,}/);
  assert.doesNotMatch(text, /任务要求（用户报告）/);
  assert.equal(JSON.stringify(event), before);
});

test('experience-only events retain path, scope boundary and verification', () => {
  const text = dailyDigestBody([{ ...base, experiences: [{ id: 'exp', kind: 'path-finding', text: '找到本地依赖',
    location: 'C:/deps/opb.jar', boundary: 'C:/deps', expires: '2026-10-08', verification: '文件存在性已核验' }] }]);
  for (const value of ['执行经验', '找到本地依赖', 'C:/deps/opb.jar', '搜索边界', '2026-10-08', '文件存在性已核验']) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /\n{3,}/);
});

test('legacy fields remain visible with human titles and deduplicated evidence', () => {
  const text = dailyDigestBody([{ ...base, evidence: [base.evidence[0], base.evidence[0]],
    facts: [{ text: '事实甲' }], verification: ['验证乙'], actions: [{ id: 'todo', status: 'open', text: '待办丙' }],
    preferences: [{ id: 'pref', scope: 'scm', text: '偏好丁' }],
    habit_decisions: [{ preference_id: 'pref', status: 'confirmed', user_quote: '明确确认戊' }],
    mistakes: [{ symptom: '错误己', correction: '修正庚', prevention: '预防辛' }] }], [{ id: base.topic, title: 'SCM 当前任务' }]);
  for (const value of ['## SCM 当前任务', '事实甲', '验证乙', '待办丙', '偏好丁', '明确确认戊', '错误己', '修正庚', '预防辛']) assert.ok(text.includes(value));
  assert.equal(text.split('[[work/evidence#digest-event]]').length, 2);
});

test('recorded times sort by instant and keep the original input array intact', () => {
  const events = [{ ...base, event_id: 'later', recorded_at: '2026-09-08T07:00:00Z' },
    { ...base, event_id: 'earlier', recorded_at: '2026-09-08T14:00:00+08:00' }];
  const before = JSON.stringify(events);
  const text = dailyDigestBody(events);
  assert.ok(text.indexOf('earlier') < text.indexOf('later'));
  assert.equal(JSON.stringify(events), before);
  assert.match(text, /本事件未提供可展示的摘要/);
});

test('verified contexts stay distinct from reports and carry supersedes', () => {
  const text = dailyDigestBody([{ ...base, contexts: [{ id: 'ctx', task: '验证结果', certainty: 'verified',
    text: '已复核目标', status: 'closed', supersedes: 'prior-event' }] }]);
  assert.match(text, /摘要（已验证记录，复用前仍需核对）/);
  assert.match(text, /状态：closed/);
  assert.match(text, /更新自事件：.*prior-event/);
  assert.match(dailyDigestBody([]), /当日没有已记录事件/);
});


