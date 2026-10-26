import test from 'node:test';
import assert from 'node:assert/strict';
import { sha } from '../lib/transport.mjs';
import { buildSemanticIndex, indexedRecall } from '../lib/search/semantic-index.mjs';
import { validateObservation, observationState } from '../lib/knowledge/observations.mjs';
import { buildStatusPage, pageState, replacePageBlock, inspectPage } from '../lib/knowledge/pages.mjs';
import { publishPage, mergeRefreshQueue, runRefreshQueue } from '../lib/knowledge/refresh.mjs';
import { proposeObservation } from '../lib/knowledge/local-generator.mjs';

const units = [{ id: 'a', text: '订单日志' }, { id: 'b', text: '散步' }];
const embed = async (texts) => texts.map((text) => text.includes('订单') ? [1, 0] : [0, 1]);

test('index reuses unchanged content, drops removed units and rejects a changing source', async () => {
  const first = await buildSemanticIndex(units, { embed });
  assert.equal(first.stats.embedded, 2);
  const second = await buildSemanticIndex(units.slice(0, 1), { embed, previous: first });
  assert.deepEqual(second.stats, { reused: 1, embedded: 0 });
  assert.equal(second.rows.length, 1);
  await assert.rejects(buildSemanticIndex(units, { embed, sourceCheck: () => false }));
});

test('model switch rebuilds vectors and read rejects stale rows without mutations', async () => {
  const index = await buildSemanticIndex(units, { embed });
  const rebuilt = await buildSemanticIndex(units, { embed, previous: index, model: 'different' });
  assert.equal(rebuilt.stats.embedded, 2);
  const before = JSON.stringify(index);
  const result = await indexedRecall([{ id: 'a', text: '订单更新日志' }], '订单', index, { embed });
  assert.equal(result.stale, 1);
  assert.equal(result.routes.semantic.length, 0);
  assert.equal(JSON.stringify(index), before);
  const broken = await indexedRecall(units, '订单', null, { embed });
  assert.ok(broken.degraded);
});

const sources = [
  { id: 'event-a/fact', text: '传参使用文件。', hash: sha('传参使用文件。'), root: 'origin-a', workspace: 'demo', topic: 'demo/shell' },
  { id: 'event-b/fact', text: '传参使用文件。', hash: sha('传参使用文件。'), root: 'origin-a', workspace: 'demo', topic: 'demo/shell' },
];
const proposal = { claim: '文件传输可减少传参风险。', kind: 'failure-pattern', support: sources.map((s) => ({ id: s.id, quote: s.text })) };
const scope = { workspace: 'demo', topic: 'demo/shell' };

test('duplicate origins do not reinforce observations and proposals cannot set authority', () => {
  const observation = validateObservation({ ...proposal, status: 'confirmed' }, sources, scope);
  assert.equal(observation.independentSources, 1);
  assert.equal(observation.status, 'candidate');
  assert.equal(observation.authority, 'inference-not-instruction');
});

test('observation rejects invented quotes and cross-project evidence', () => {
  assert.throws(() => validateObservation({ ...proposal, support: [{ id: sources[0].id, quote: '不存在的引文' }] }, sources, scope));
  assert.throws(() => validateObservation(proposal, sources.map((s) => ({ ...s, workspace: 'other' })), scope));
});

test('source change invalidates observations and counterevidence blocks usage', () => {
  const observation = validateObservation(proposal, sources, scope);
  assert.equal(observationState(observation, sources).usable, true);
  assert.equal(observationState(observation, [...sources, { ...sources[0], id: 'new-source' }]).stale, true);
  const forged = { ...observation, support: [{ ...observation.support[0], quote: 'Invented citation' }] };
  assert.equal(observationState(forged, sources).usable, false);
  assert.equal(observationState(observation, [{ ...sources[0], hash: 'changed' }, sources[1]]).stale, true);
  const contested = validateObservation({ ...proposal, counterevidence: [{ id: sources[1].id, quote: sources[1].text }] }, sources, scope);
  assert.equal(contested.evidenceState, 'contested');
  assert.equal(observationState(contested, sources).usable, false);
});

const projection = { facts: [{ topic: 'demo/shell', key: 'a', text: '记录结论', event_id: 'event-a', at: '2026-10-13' }],
  actions: [], conflicts: [] };

test('page dependency state handles new facts, pending sources and conflict', () => {
  const page = buildStatusPage(projection, 'demo/shell');
  assert.equal(pageState(page.manifest, projection, 'demo/shell'), 'fresh');
  assert.equal(pageState(page.manifest, { ...projection, actions: [{ topic: 'demo/shell', id: 'task', status: 'open' }] }, 'demo/shell'), 'dirty');
  assert.equal(pageState(page.manifest, projection, 'demo/shell', ['demo/shell']), 'dirty');
  assert.equal(pageState(page.manifest, { ...projection, conflicts: [{ topic: 'demo/shell' }] }, 'demo/shell'), 'blocked');
  assert.throws(() => buildStatusPage(projection, 'demo/shell', { pendingTopics: ['demo/shell'] }));
  assert.throws(() => buildStatusPage({ ...projection, conflicts: [{ topic: 'demo/shell' }] }, 'demo/shell'), /Conflicted/);
});

test('page replacement preserves manual bytes and rejects manual generated-block edits', () => {
  const page = buildStatusPage(projection, 'demo/shell');
  const text = replacePageBlock('manual\n', page.body);
  assert.equal(inspectPage(page.manifest, projection, 'demo/shell', [], null).state, 'missing');
  assert.equal(inspectPage(page.manifest, projection, 'demo/shell', [], text + 'manual tail').state, 'fresh');
  assert.equal(inspectPage(page.manifest, projection, 'demo/shell', [], text.replace('记录结论', 'edited')).state, 'blocked');
  assert.equal(inspectPage(page.manifest, projection, 'demo/shell', [], 'manual only').state, 'blocked');
  const first = buildStatusPage(projection, 'demo/shell');
  const initial = replacePageBlock('manual notes\r\n', first.body);
  const second = buildStatusPage({ ...projection, actions: [{ topic: 'demo/shell', id: 'task', status: 'open', text: '未完成', event_id: 'event-b' }] }, 'demo/shell');
  const updated = replacePageBlock(initial, second.body, first.manifest);
  assert.ok(updated.startsWith('manual notes\r\n'));
  assert.throws(() => replacePageBlock(initial.replace('记录结论', '手工改动'), second.body, first.manifest));
  assert.throws(() => replacePageBlock(initial + initial, second.body, first.manifest));
});

test('interrupted publication recovers the manifest without overwriting published bytes', () => {
  const page = buildStatusPage(projection, 'demo/shell');
  let text = ''; let intent = null; let manifest = null;
  const transport = { create: (relative, next) => { text = next; }, verify: () => text };
  const options = { relative: 'page.md', existing: '', page, transport, sourceCheck: () => true,
    writeIntent: (value) => { intent = value; }, writeManifest: () => { throw new Error('crash'); },
    clearIntent: () => { intent = null; } };
  assert.throws(() => publishPage(options));
  const before = text;
  assert.throws(() => publishPage({ ...options, existing: text, pendingIntent: intent, sourceCheck: () => false }), /sources changed/);
  assert.ok(intent);
  const recovered = publishPage({ ...options, existing: text, pendingIntent: intent,
    writeManifest: (value) => { manifest = value; } });
  assert.equal(recovered.recovered, true);
  assert.equal(text, before);
  assert.equal(manifest.revision, page.manifest.revision);
  assert.equal(intent, null);
});

test('refresh queue coalesces revisions and bounds failed retries', async () => {
  const tasks = mergeRefreshQueue([], [{ topic: 'demo/shell', revision: 'a' }]);
  assert.equal(mergeRefreshQueue(tasks, [{ topic: 'demo/shell', revision: 'a' }]).length, 1);
  const failed = await runRefreshQueue(tasks, async () => { throw new Error('private error'); });
  assert.equal(failed[0].status, 'failed');
  const exhausted = [{ ...failed[0], attempts: 3 }];
  assert.equal(mergeRefreshQueue(exhausted, [{ topic: 'demo/shell', revision: 'a' }])[0].attempts, 3);
  const retried = mergeRefreshQueue(exhausted, [{ topic: 'demo/shell', revision: 'a' }], { retryFailed: true });
  assert.equal(retried[0].attempts, 0);
  assert.equal(retried[0].status, 'queued');
  assert.equal(mergeRefreshQueue(exhausted, [], { retryFailed: true })[0].attempts, 3);
  let calls = 0;
  await runRefreshQueue([{ ...failed[0], attempts: 3 }], async () => { calls += 1; });
  assert.equal(calls, 0);
});

test('local generator validates exact citations and can abstain', async () => {
  const fetchImpl = async (url, request) => {
    assert.equal(request.redirect, 'error');
    return { ok: true, json: async () => ({ model: 'test', choices: [{ message: { content: JSON.stringify(proposal) } }] }) };
  };
  const result = await proposeObservation(sources, scope, { model: 'test', fetchImpl });
  let calls = 0;
  await assert.rejects(proposeObservation(sources.map((s) => ({ ...s, workspace: 'other' })), scope,
    { model: 'test', fetchImpl: async () => { calls += 1; } }), /scope/);
  assert.equal(calls, 0);
  assert.equal(result.status, 'candidate');
  await assert.rejects(proposeObservation(sources, scope, { model: 'test', endpoint: 'http://example.com/v1/chat/completions', fetchImpl }));
});
