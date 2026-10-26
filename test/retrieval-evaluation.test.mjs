import test from 'node:test';
import assert from 'node:assert/strict';
import { rankingMetrics, summarizeEvaluation, validateCorpus } from '../lib/search/evaluation.mjs';
import fs from 'node:fs';

test('graded metrics deduplicate ranks and use all relevant documents for recall', () => {
  const result = rankingMetrics(['a', 'a', 'b'], { a: 3, b: 1, c: 2 }, 2);
  assert.equal(result.recall, 2 / 3);
  assert.equal(result.reciprocalRank, 1);
  assert.ok(result.ndcg > 0 && result.ndcg < 1);
  assert.equal(rankingMetrics(['a', 'c', 'b'], { a: 3, b: 1, c: 2 }, 3).ndcg, 1);
});

test('no-answer cases count false returns rather than inflate recall', () => {
  assert.deepEqual(rankingMetrics(['a', 'a', 'b'], {}, 1), {
    recall: null, ndcg: null, reciprocalRank: null, falseReturns: 1,
  });
  const row = (ids, relevance, elapsedMs) => ({ elapsedMs, routes: { fused: {
    at5: rankingMetrics(ids, relevance, 5), at10: rankingMetrics(ids, relevance, 10),
  } } });
  const summary = summarizeEvaluation([row(['a'], { a: 3 }, 10), row(['b'], {}, 20)]);
  assert.equal(summary.routes.fused.recall10, 1);
  assert.equal(summary.routes.fused.noAnswerCases, 1);
  assert.equal(summary.routes.fused.falseReturns, 1);
  assert.equal(summary.p95Ms, 20);
});

test('invalid grades and cutoffs reject; empty evaluation is explicit', () => {
  assert.throws(() => rankingMetrics([], { a: 4 }));
  assert.throws(() => rankingMetrics([], {}, 0));
  assert.equal(summarizeEvaluation([]).p50Ms, null);
});

test('packaged corpus validates and malformed labels fail before model calls', () => {
  const corpus = JSON.parse(fs.readFileSync(new URL('../examples/retrieval-zh.json', import.meta.url), 'utf8'));
  assert.equal(validateCorpus(corpus), corpus);
  const duplicate = structuredClone(corpus);
  duplicate.documents.push(duplicate.documents[0]);
  assert.throws(() => validateCorpus(duplicate), /duplicate/);
  const unknown = structuredClone(corpus);
  unknown.cases[0].relevance.missing = 3;
  assert.throws(() => validateCorpus(unknown), /label/);
});
