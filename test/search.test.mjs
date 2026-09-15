import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, buildIndex, search } from '../lib/search/bm25.mjs';
import { l0, outline, full, render } from '../lib/search/tiered-read.mjs';

test('tokenize keeps latin/digit runs and splits CJK per character', () => {
  const tokens = tokenize('Demo-Proj ChannelConfig 通道配置 82 环境');
  assert.ok(tokens.includes('demo'));
  assert.ok(tokens.includes('proj'));
  assert.ok(tokens.includes('channelconfig'));
  assert.ok(tokens.includes('通'));
  assert.ok(tokens.includes('配'));
  assert.ok(tokens.includes('82'));
  // Generic stopword is dropped.
  assert.ok(!tokens.includes('的'));
});

test('BM25 ranks a repeated-term document above a single-mention document', () => {
  const index = buildIndex([
    { id: 'a', title: 'ChannelConfig', text: 'ChannelConfig ChannelConfig matching logic' },
    { id: 'b', title: 'Other', text: 'ChannelConfig appears once here' },
    { id: 'c', title: 'Unrelated', text: 'completely different topic about deployment' },
  ]);
  const results = search(index, 'ChannelConfig');
  assert.equal(results[0].id, 'a');
  assert.ok(results.every((row) => row.id !== 'c'));
});

test('BM25 IDF discounts a term present in every document', () => {
  const index = buildIndex([
    { id: 'a', text: 'alpha common' },
    { id: 'b', text: 'beta common' },
  ]);
  const results = search(index, 'common');
  // Both match, but neither can dominate purely by being universal.
  assert.equal(results.length, 2);
  assert.ok(results[0].score < 1);
});

test('BM25 returns nothing for a query with no overlapping terms', () => {
  const index = buildIndex([{ id: 'a', text: 'ChannelConfig matching' }]);
  assert.deepEqual(search(index, 'quantum'), []);
});

test('L0 lists hits without full bodies and keeps paths', () => {
  const hits = [{ id: 'note-1', label: 'Note', score: 1.23456, path: 'topics/note.md', text: '# Heading\n\nFirst real line of the note.' }];
  const rows = l0(hits);
  assert.equal(rows[0].id, 'note-1');
  assert.equal(rows[0].score, 1.2346);
  assert.match(rows[0].excerpt, /First real line/);
  assert.equal(rows[0].path, 'topics/note.md');
});

test('outline returns heading structure only', () => {
  const headings = outline('# Title\n\ntext\n## Section A\n### Sub\n## Section B');
  assert.deepEqual(headings, [
    { level: 1, title: 'Title' },
    { level: 2, title: 'Section A' },
    { level: 3, title: 'Sub' },
    { level: 2, title: 'Section B' },
  ]);
});

test('full bounds output by UTF-8 bytes and marks truncation', () => {
  const text = '中'.repeat(10000);
  const result = full(text, { maxBytes: 300 });
  assert.ok(Buffer.byteLength(result) <= 300 + 120);
  assert.match(result, /截断/);
});

test('render switches tiers and reports an empty corpus clearly', () => {
  const hits = [{ id: 'a', label: 'A', score: 2, path: 'p.md', text: '# H\nbody text' }];
  assert.match(render(hits, 'l0'), /1\. \[a\] A/);
  assert.match(render(hits, 'outline'), /- H/);
  assert.match(render(hits, 'full'), /body text/);
  assert.equal(render([], 'l0'), '没有匹配的记忆。');
});
