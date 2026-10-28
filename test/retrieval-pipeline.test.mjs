import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieveTaskContext, createRetrievalCache } from '../lib/retrieval-pipeline.mjs';
import { buildSemanticIndex } from '../lib/search/semantic-index.mjs';

const units = [
  { id: 'fact-82', sourceType: 'fact', workspace: 'od', topic: 'od/env', text: '82 环境数据库为 oss_od_demo。', taskId: 'task-1' },
  { id: 'fact-182', sourceType: 'fact', workspace: 'od', topic: 'od/env', text: '182 环境数据库为 other_db。', taskId: 'task-2' },
  { id: 'hidden', sourceType: 'fact', workspace: 'od', topic: 'od/env', text: '82 环境旧结论。', status: 'archived', taskId: 'task-3' },
  { id: 'other-ws', sourceType: 'fact', workspace: 'home', topic: 'home/env', text: '82 环境 home 结论。', taskId: 'task-4' },
  { id: 'copy', sourceType: 'note-section', workspace: 'od', topic: 'od/env', text: '82 环境数据库为 oss_od_demo。', taskId: 'task-1' },
];

test('task retrieval enforces workspace and entity scope and reports filters', async () => {
  const result = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', budget: { maxUnits: 20 } });
  assert.ok(result.executed);
  assert.ok(result.hits.some((row) => row.id === 'fact-82'));
  assert.ok(result.hits.every((row) => row.workspace === 'od'));
  assert.ok(!result.hits.some((row) => row.id === 'fact-182' || row.id === 'hidden'));
  assert.ok(result.diagnostics.filtered.outOfScope >= 1);
  assert.ok(result.diagnostics.filtered.hidden >= 1);
  assert.ok(result.diagnostics.filtered.wrongEntity >= 1);
});

test('task retrieval deduplicates and applies per-task and byte budgets', async () => {
  const result = await retrieveTaskContext({ units: [
    ...units,
    { id: 'fact-82-duplicate', sourceType: 'fact', workspace: 'od', topic: 'od/env', text: '82 环境数据库为 oss_od_demo。', taskId: 'task-1' },
    { id: 'fact-82-second', sourceType: 'fact', workspace: 'od', topic: 'od/env', text: '82 环境端口为 443。', taskId: 'task-1' },
  ], query: '82 环境', workspace: 'od', budget: { maxPerTask: 1, maxBytes: 600, limit: 10 } });
  assert.ok(result.hits.length <= 1);
  assert.ok(result.diagnostics.reasons.includes('budget-or-dedup-filtered'));
  assert.ok(result.diagnostics.bytes <= 600);
});

test('embedding/index failures degrade to keyword results with diagnostics', async () => {
  const result = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', index: null, embed: async () => { throw new Error('offline'); } });
  assert.equal(result.diagnostics.mode, 'keyword-fallback');
  assert.ok(result.diagnostics.degraded);
  assert.ok(result.diagnostics.reasons.includes('keyword-fallback'));
});

test('custom model index uses its indexed model and reaches the semantic route', async () => {
  const model = 'fixture-custom-embedding';
  const embeddingOptions = { modelRevision: 'fixture-rev-1' };
  const embed = async (texts, options = {}) => {
    assert.equal(options.model, model);
    return texts.map(() => [1, 0, 0]);
  };
  const index = await buildSemanticIndex([units[0]], { model, embeddingOptions, embed });
  const result = await retrieveTaskContext({ units: [units[0]], query: '82 环境', workspace: 'od',
    index, model: index.model, embeddingOptions, embed });
  assert.equal(result.diagnostics.mode, 'indexed-shadow');
  assert.equal(result.diagnostics.degraded, null);
  assert.equal(result.diagnostics.routes.semantic, 1);
  assert.equal(result.hits[0].id, 'fact-82');
});

test('cross workspace cannot be enabled implicitly', async () => {
  await assert.rejects(() => retrieveTaskContext({ units, query: '82', workspace: 'od', crossWorkspace: true }), /explicit scoped adapter/);
});

test('cache is scoped by workspace and visibility version and returns cloned results', async () => {
  const cache = createRetrievalCache({ maxEntries: 2 });
  const first = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', cache, visibilityVersion: 'v1' });
  first.hits.length = 0;
  const hit = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', cache, visibilityVersion: 'v1' });
  assert.ok(hit.hits.length > 0);
  assert.equal(hit.diagnostics.cache, 'hit');
  const miss = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', cache, visibilityVersion: 'v2' });
  assert.equal(miss.diagnostics.cache, 'miss');
  const firstModel = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', cache, visibilityVersion: 'models', model: 'custom-model-a' });
  assert.equal(firstModel.diagnostics.cache, 'miss');
  const secondModel = await retrieveTaskContext({ units, query: '82 环境', workspace: 'od', cache, visibilityVersion: 'models', model: 'custom-model-b' });
  assert.equal(secondModel.diagnostics.cache, 'miss');
});

test('semantic threshold is validated', async () => {
  await assert.rejects(() => retrieveTaskContext({ units, query: '82', workspace: 'od', budget: { minSemanticScore: 2 } }), /minSemanticScore/);
});
