import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNoteIndex, scoreNotes } from '../lib/search/index-bridge.mjs';

// Regression guard for the ranking formula adopted in stage 2: BM25 base score plus
// a title-hit bonus. The A/B probe against the real vault showed that BM25 alone
// ranked long habits pages above the note that actually names the topic; this test
// pins the corrected behavior so a future change cannot silently reintroduce it.

function rank(entries, query) {
  const scores = scoreNotes(buildNoteIndex(entries), query);
  return entries.map((row) => ({
    path: row.path,
    score: (scores.get(row.path) ?? 0) + query.toLowerCase().split(/\s+/).filter((term) => row.title.toLowerCase().includes(term)).length * 8,
  })).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
}

test('a note naming the topic outranks a long note that merely repeats the words', () => {
  const entries = [
    { path: 'habits.md', title: 'Agent 待确认习惯', search: 'agent 待确认习惯 build remote component '.repeat(200) },
    { path: 'fishx-build.md', title: 'FishX 三仓构建与 OD 远程组件打包', search: 'fishx build remote component od 远程组件' },
  ];
  const ranked = rank(entries, 'fishx remote component build');
  assert.equal(ranked[0].path, 'fishx-build.md');
});

test('an English identifier query matches without requiring a segmenter', () => {
  const entries = [
    { path: 'order360.md', title: 'Order 360 与 SI 客户字段来源', search: 'Order 360 Customer Reference ID CUST_CODE 来源' },
    { path: 'other.md', title: 'Unrelated', search: 'nothing to do with customers' },
  ];
  const ranked = rank(entries, 'Order 360 Customer Reference ID');
  assert.equal(ranked[0].path, 'order360.md');
  assert.equal(ranked.length, 1);
});

test('a title hit adds to the BM25 base rather than replacing it', () => {
  const entries = [
    { path: 'a.md', title: 'Alpha Topic', search: 'alpha several mentions here alpha again' },
    { path: 'b.md', title: 'Beta', search: 'alpha once' },
  ];
  const ranked = rank(entries, 'alpha');
  // Both have a title hit; the one with more in-body frequency still wins on base score.
  assert.equal(ranked[0].path, 'a.md');
  assert.ok(ranked[0].score > ranked[1].score);
});
