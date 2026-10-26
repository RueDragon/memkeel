import test from 'node:test';
import assert from 'node:assert/strict';
import { splitEmbeddingText, buildSemanticIndex, indexedRecall } from '../lib/search/semantic-index.mjs';

test('chunks preserve unicode and cover boundaries with bounded overlap', () => {
  const text = '😀'.repeat(500);
  const chunks = splitEmbeddingText(text, 256, 20);
  assert.equal(chunks.length, 3);
  assert.ok(chunks.every((s) => Array.from(s).length <= 256));
  assert.equal(chunks[0].slice(-40), chunks[1].slice(0, 40));
  assert.throws(() => splitEmbeddingText('x', 256, 128));
});

test('long sources retrieve tail evidence once, reuse chunks and rebuild on chunk configuration changes', async () => {
  const inputs = [];
  const embed = async (texts) => {
    inputs.push(...texts);
    assert.ok(texts.length <= 16);
    assert.ok(texts.every((s) => s.length <= 6000));
    return texts.map((s) => s.includes('target') ? [1, 0] : [0, 1]);
  };
  const units = [{ id: 'long', text: 'filler '.repeat(3000) + 'target' }, { id: 'other', text: 'other' }];
  const index = await buildSemanticIndex(units, { embed });
  assert.ok(index.rows[0].vectors.length > 1);
  assert.ok(!JSON.stringify(index).includes('filler'));
  const recall = await indexedRecall(units, 'target', index, { embed });
  assert.equal(recall.routes.semantic[0].id, 'long');
  assert.equal(recall.fused.filter((r) => r.id === 'long').length, 1);
  const before = inputs.length;
  const reused = await buildSemanticIndex(units, { embed, previous: index });
  assert.equal(reused.stats.reused, 2);
  assert.equal(inputs.length, before);
  const rebuilt = await buildSemanticIndex(units, { embed, previous: index, embeddingOptions: { chunkChars: 1000 } });
  assert.equal(rebuilt.stats.embedded, 2);
});

test('oversized corpus fails before the first provider request', async () => {
  let calls = 0;
  await assert.rejects(buildSemanticIndex([{ id: 'a', text: 'small' }, { id: 'b', text: 'x'.repeat(100001) }], {
    embed: async () => { calls += 1; return [[1]]; },
  }), /bounded/);
  assert.equal(calls, 0);
});
