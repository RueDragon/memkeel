import test from 'node:test';
import assert from 'node:assert/strict';
import { filterVisible, visibilityOf, partitionVisibility } from '../lib/visibility.mjs';
import { admissionDecision, contentDigest, deduplicate, lifecycleOf, buildGovernanceCandidates } from '../lib/governance.mjs';
import { governanceReport, formatGovernanceReport } from '../lib/governance-report.mjs';
import { importanceScore, isImportant } from '../lib/ingest/pipeline.mjs';
import { retention } from '../lib/experience.mjs';

test('visibility combines status fields by strictest blocker and history preserves status', () => {
  const rows = [
    { id: 'a', status: 'active' },
    { id: 'b', status: 'active', lifecycle: 'archived' },
    { id: 'c', visibilityStatus: 'active', status: 'cancelled' },
    { id: 'd', visible: false, status: 'active' },
    { id: 'e', hidden: true, status: 'active' },
  ];
  assert.deepEqual(filterVisible(rows).map((r) => r.id), ['a']);
  assert.equal(visibilityOf(rows[1], { history: true }).historical, true);
  assert.equal(visibilityOf(rows[1], { history: true }).status, 'archived');
  assert.equal(partitionVisibility(rows, { history: true }).historical.length, 4);
});

test('expiry aliases and experience date semantics are deterministic', () => {
  const now = '2026-10-27T12:00:00Z';
  assert.equal(visibilityOf({ status: 'active', expires: '2026-10-26' }, { now }).visible, false);
  assert.equal(visibilityOf({ status: 'active', date_expires: '2026-10-27' }, { now }).visible, true);
  assert.equal(visibilityOf({ status: 'active', expiresAt: '2026-10-27T12:00:00Z' }, { now }).visible, false);
  assert.equal(visibilityOf({ status: 'candidate' }, { includeCandidates: false }).visible, false);
  assert.equal(retention({ type: 'experiences', expires: '2026-10-27', at: now }, now), 'retained');
});

test('admission reuses ingest importance and protects explicit/state changes', () => {
  assert.equal(admissionDecision({ text: '好的', source: 'hook' }).admitted, false);
  assert.equal(admissionDecision({ text: '记住', explicit: true, source: 'mcp' }).reason, 'explicit-request');
  assert.equal(admissionDecision({ text: '状态变了', stateChange: true }).admitted, true);
  const sample = '我们决定以后所有记忆都以 Markdown 作为唯一真源，不再引入数据库。';
  assert.equal(admissionDecision({ text: sample }).score, importanceScore(sample));
  assert.equal(admissionDecision({ text: sample }).admitted, isImportant(sample));
  const denied = admissionDecision({ text: '请记住这个秘密', explicit: true, collection: false });
  assert.deepEqual(denied, { score: 0, admitted: false, reason: 'collection-disabled', source: 'unknown' });
  assert.equal('digest' in denied, false);
  assert.equal('text' in denied, false);
});

test('collection policy denial wins over explicit requests without content metadata', () => {
  const denied = admissionDecision({ text: '重要状态', explicit: true, config: { collection: { enabled: false } } });
  assert.equal(denied.admitted, false);
  assert.equal(denied.decidedBy, 'global');
  assert.equal('denialReason' in denied, false);
});

test('dedup uses normalized content and exact workspace/topic/task/branch scope', () => {
  const rows = [
    { id: '1', text: '  Same   content ', workspace: 'p1', topic: 't', task: 'a', branch: 'main' },
    { id: '2', text: 'Same content', workspace: 'p1', topic: 't', task: 'a', branch: 'main' },
    { id: '3', text: 'Same content', workspace: 'p2', topic: 't', task: 'a', branch: 'main' },
    { id: '4', text: 'Other', workspace: 'p1', topic: 't', task: 'a', branch: 'main' },
  ];
  const result = deduplicate(rows);
  assert.deepEqual(result.kept.map((r) => r.id), ['1', '3', '4']);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].duplicateOf.id, '1');
  assert.equal(contentDigest('Same content'), contentDigest('  Same   content '));
  assert.equal(deduplicate([{ text: 'Same' }, { text: 'Same' }]).duplicates.length, 0);
});

test('lifecycle and candidates keep dormant facts in review only', () => {
  assert.equal(lifecycleOf({ occurred_at: '2026-10-25T00:00:00Z' }, { now: '2026-10-27T00:00:00Z' }), 'hot');
  const [row] = buildGovernanceCandidates([{ id: 'old', status: 'active', occurred_at: '2026-01-01T00:00:00Z', evidence: ['proof.md'] }], { now: '2026-10-27T00:00:00Z' });
  assert.equal(row.lifecycle, 'dormant');
  assert.equal(row.action, 'review');
  assert.match(row.recovery, /history=true/);
});

test('report is read-only, scoped, statistical, and formats reasons/evidence/recovery', () => {
  const input = [
    { id: 'old', type: 'fact', workspace: 'p1', topic: 't', task: 'task', branch: 'main', text: 'old', bytes: 3, occurred_at: '2026-01-01T00:00:00Z', evidence: ['proof.md'] },
    { id: 'dup', type: 'fact', workspace: 'p1', topic: 't', task: 'task', branch: 'main', text: 'old', bytes: 3, occurred_at: '2026-01-02T00:00:00Z', evidence: ['proof2.md'] },
    { id: 'new', type: 'context', workspace: 'p2', text: 'new', bytes: 3, occurred_at: '2026-10-27T00:00:00Z' },
    { id: 'hidden', type: 'fact', workspace: 'p1', text: 'hidden', status: 'archived', bytes: 10, occurred_at: '2026-01-01T00:00:00Z' },
  ];
  const before = JSON.stringify(input);
  const report = governanceReport(input, { now: '2026-10-27T00:00:00Z' });
  assert.equal(report.applied, false);
  assert.equal(report.mode, 'report-only');
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.stats.byProject.p1, 1);
  assert.equal(report.stats.bytes, 6);
  assert.match(formatGovernanceReport(report), /old/);
  assert.match(formatGovernanceReport(report), /review/);
  assert.match(formatGovernanceReport(report), /proof\.md/);
  assert.match(formatGovernanceReport(report), /recovery=/);
  assert.equal(JSON.stringify(input), before);
});

test('history report includes hidden rows with status but never applies them', () => {
  const report = governanceReport([{ id: 'x', status: 'archived', workspace: 'p', text: 'x', occurred_at: '2026-01-01T00:00:00Z' }], { history: true, now: '2026-10-27T00:00:00Z' });
  assert.equal(report.visibility.historical, 1);
  assert.equal(report.candidates[0].visibility.status, 'archived');
  assert.equal(report.applied, false);
});
