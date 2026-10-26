import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticIndex, indexedRecall, embeddingProfile } from '../lib/search/semantic-index.mjs';

const units = [{ id: 'a', text: 'order record' }];
test('same model ID with a different weight revision rebuilds and rejects old reads', async () => {
  let calls = 0;
  const embed = async (texts) => { calls += 1; return texts.map(() => [1, 0]); };
  const first = await buildSemanticIndex(units, { embed, embeddingOptions: { modelRevision: 'weights-a' } });
  const same = await buildSemanticIndex(units, { embed, previous: first, embeddingOptions: { modelRevision: 'weights-a' } });
  assert.equal(same.stats.reused, 1);
  assert.equal(calls, 1);
  const next = await buildSemanticIndex(units, { embed, previous: first, embeddingOptions: { modelRevision: 'weights-b' } });
  assert.equal(next.stats.embedded, 1);
  const before = calls;
  const read = await indexedRecall(units, 'order', first, { embed, embeddingOptions: { modelRevision: 'weights-b' } });
  assert.ok(read.degraded);
  assert.equal(calls, before);
  assert.equal(read.routes.keyword.length, 1);
});

test('query and document prefixes are distinct and invalidate the cached profile', async () => {
  const inputs = [];
  const embed = async (texts) => { inputs.push(...texts); return texts.map(() => [1, 0]); };
  const embeddingOptions = { queryPrefix: 'query: ', documentPrefix: 'document: ' };
  const index = await buildSemanticIndex(units, { embed, embeddingOptions });
  await indexedRecall(units, 'order', index, { embed, embeddingOptions });
  assert.deepEqual(inputs, ['document: order record', 'query: order']);
  const result = await indexedRecall(units, 'order', index, { embed });
  assert.ok(result.degraded);
  assert.equal(inputs.length, 2);
});

test('profile rejects remote endpoints and malformed revision labels', () => {
  assert.throws(() => embeddingProfile('model', { endpoint: 'http://example.com/v1/embeddings' }));
  assert.throws(() => embeddingProfile('model', { modelRevision: '' }));
  assert.throws(() => embeddingProfile('model', { queryPrefix: 1 }));
});
