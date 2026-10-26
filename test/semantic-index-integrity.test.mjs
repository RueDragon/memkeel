import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSemanticIndex, indexedRecall, validateSemanticIndex } from '../lib/search/semantic-index.mjs';

const units = [{ id: 'a', text: '订单记录' }];
test('malformed cached vectors degrade before inference and rebuild explicitly', async () => {
  const embed = async (texts) => texts.map(() => [1, 0]);
  const index = await buildSemanticIndex(units, { embed });
  for (const mutate of [
    (value) => { value.rows.push(structuredClone(value.rows[0])); },
    (value) => { value.dimension = 3; },
    (value) => { value.profile.queryPrefix = 'forged'; },
    (value) => { value.rows[0].vectors = [[0, 0]]; },
  ]) {
    const bad = structuredClone(index); mutate(bad);
    assert.throws(() => validateSemanticIndex(bad));
    const before = JSON.stringify(bad); let calls = 0;
    const result = await indexedRecall(units, '订单', bad, { embed: async () => { calls += 1; return [[1, 0]]; } });
    assert.ok(result.degraded);
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(bad), before);
    const rebuilt = await buildSemanticIndex(units, { previous: bad, embed });
    assert.equal(rebuilt.stats.embedded, 1);
    assert.equal(validateSemanticIndex(rebuilt), rebuilt);
  }
});
