import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticIndex, indexedRecall } from '../lib/search/semantic-index.mjs';

test('exact arm ranks facts only and fusion preserves one source identity', async () => {
  const units = [{ id: 'fact', text: '环境 82 当前事实', sourceType: 'fact' },
    { id: 'note', text: '环境 82 参考材料', sourceType: 'note-section' }];
  const embed = async (texts) => texts.map(() => [1, 0]);
  const index = await buildSemanticIndex(units, { embed });
  const result = await indexedRecall(units, '82', index, { embed });
  assert.deepEqual(result.routes.exact.map((r) => r.id), ['fact']);
  assert.equal(result.fused[0].id, 'fact');
  assert.equal(result.fused[0].sources.length, 3);
  assert.equal(result.fused.filter((r) => r.id === 'fact').length, 1);
});
