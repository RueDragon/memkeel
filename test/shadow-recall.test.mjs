import test from 'node:test';
import assert from 'node:assert/strict';
import { localEndpoint, embedLocal } from '../lib/search/local-embedding.mjs';
import { eligibleFacts, fuseRoutes, shadowRecall } from '../lib/search/shadow.mjs';

const topics = [{ id: 'od/env', workspace: 'od' }, { id: 'other/env', workspace: 'other' }];
const projection = { conflicts: [], facts: [
  { topic: 'od/env', key: 'db', event_id: 'a', text: '82 环境订单提交失败，检查接口日志。' },
  { topic: 'od/env', key: 'wrong', event_id: 'b', text: '182 环境数据库。' },
  { topic: 'other/env', key: 'db', event_id: 'c', text: '82 环境订单日志。' },
] };

test('endpoint rejects remote hosts, DNS aliases, credentials and alternate paths', () => {
  for (const url of ['https://127.0.0.1/v1/embeddings', 'http://localhost:1234/v1/embeddings',
    'http://example.com/v1/embeddings', 'http://user@127.0.0.1/v1/embeddings',
    'http://127.0.0.1/v1/embeddings?x=1', 'http://127.0.0.1/other']) assert.throws(() => localEndpoint(url));
  assert.equal(localEndpoint(), 'http://127.0.0.1:1234/v1/embeddings');
});

test('adapter redacts inputs, disallows redirects and orders indexed responses', async () => {
  const vectors = await embedLocal(['password=synthetic-secret', '中文'], { model: 'test', fetchImpl: async (url, request) => {
    assert.equal(request.redirect, 'error');
    assert.ok(!request.body.includes('synthetic-secret'));
    return { ok: true, json: async () => ({ model: 'test', data: [
      { index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] },
    ] }) };
  } });
  assert.deepEqual(vectors, [[1, 0], [0, 1]]);
});

test('adapter rejects wrong model, duplicate indices and malformed dimensions', async () => {
  for (const data of [
    { model: 'wrong', data: [{ index: 0, embedding: [1] }] },
    { model: 'test', data: [{ index: 1, embedding: [1] }] },
    { model: 'test', data: [{ index: 0, embedding: [0] }] },
  ]) await assert.rejects(embedLocal(['hello'], { model: 'test', fetchImpl: async () => ({ ok: true, json: async () => data }) }));
});

test('eligibility excludes other workspaces, identifier collisions and pending topics', () => {
  assert.deepEqual(eligibleFacts(topics, projection, '82环境', 'od').map((x) => x.event_id), ['a']);
  assert.equal(eligibleFacts(topics, projection, '82环境', 'od', ['od/env']).length, 0);
  assert.throws(() => eligibleFacts(topics, projection, '82环境', ''));
});

test('fusion counts a repeated id only once per route', () => {
  const result = fuseRoutes({ keyword: [{ id: 'a' }, { id: 'a' }], semantic: [{ id: 'b' }, { id: 'a' }] });
  assert.equal(result[0].id, 'a');
  assert.equal(result[0].sources.length, 2);
});

test('shadow keeps conflict labels and retrieves via shared eligible corpus', async () => {
  const result = await shadowRecall({ topics, projection: { ...projection, conflicts: [{ topic: 'od/env', key: 'db' }] },
    query: '82环境', workspace: 'od', embed: async (texts) => texts.map(() => [1, 0]) });
  assert.equal(result.corpusSize, 1);
  assert.equal(result.dimension, 2);
  assert.equal(result.fused[0].conflict, true);
  assert.equal(result.fused[0].sources.length, 2);
});

test('unavailable embeddings degrade explicitly and never echo provider errors', async () => {
  const result = await shadowRecall({ topics, projection, query: '82环境', workspace: 'od',
    embed: async () => { throw new Error('secret provider response'); } });
  assert.equal(result.degraded, 'local-embedding-unavailable-or-invalid');
  assert.equal(result.routes.semantic.length, 0);
  assert.ok(result.fused.length);
  assert.ok(!JSON.stringify(result).includes('secret provider response'));
});

test('invalid dimensions degrade and corpus caps fail before inference', async () => {
  let calls = 0;
  const embed = async (texts) => { calls += 1; return texts.map(() => calls === 1 ? [1, 0] : [1]); };
  const result = await shadowRecall({ topics, projection, query: '82环境', workspace: 'od', embed });
  assert.ok(result.degraded);
  calls = 0;
  await assert.rejects(shadowRecall({ topics, projection, query: '环境', workspace: 'od', maxUnits: 1, embed }));
  assert.equal(calls, 0);
});
