import test from 'node:test';
import assert from 'node:assert/strict';
import { generatorSmoke } from '../lib/knowledge/generator-smoke.mjs';

test('smoke refuses unloaded models without a generation request', async () => {
  let calls = 0;
  await assert.rejects(generatorSmoke({ model: 'test', fetchImpl: async (url, request) => {
    calls += 1;
    assert.equal(request.redirect, 'error');
    assert.ok(url.endsWith('/api/v0/models'));
    return { ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'not-loaded' }] }) };
  } }), /not verified loaded/);
  assert.equal(calls, 1);
});

test('loaded-model smoke uses synthetic evidence, validates citations and does not persist', async () => {
  let calls = 0;
  const result = await generatorSmoke({ model: 'test', fetchImpl: async (url, request) => {
    calls += 1;
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded' }] }) };
    const body = JSON.parse(request.body);
    const { evidence, task } = JSON.parse(body.messages[1].content);
    assert.ok(task.includes('preference-tendency'));
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 2048);
    assert.equal(body.response_format.type, 'json_schema');
    assert.ok(evidence.every((s) => s.id.startsWith('synthetic-')));
    return { ok: true, json: async () => ({ model: 'test', choices: [{ message: { content: JSON.stringify({
      claim: 'Script files may reduce quoting risk', kind: 'explanation', support: evidence.map((s) => ({ id: s.id, quote: s.text })),
    }) } }] }) };
  } });
  assert.equal(calls, 2);
  assert.equal(result.status, 'candidate');
  assert.equal(result.persisted, false);
  assert.equal(result.authority, 'inference-not-instruction');
});

test('reasoning-only structured output is rejected, not promoted to final output', async () => {

  await assert.rejects(generatorSmoke({ model: 'test', fetchImpl: async (url) => {
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded' }] }) };
    return { ok: true, json: async () => ({ model: 'test', choices: [{ message: { content: '', reasoning_content: '{"abstain":true}' } }] }) };
  } }), /reasoning only/);
});

test('truncated final JSON is rejected even if it parses', async () => {
  await assert.rejects(generatorSmoke({ model: 'test', fetchImpl: async (url) => {
    if (url.endsWith('/api/v0/models')) return { ok: true, json: async () => ({ data: [{ id: 'test', type: 'llm', state: 'loaded' }] }) };
    return { ok: true, json: async () => ({ model: 'test', choices: [{ finish_reason: 'length', message: { content: '{"abstain":true}' } }] }) };
  } }), /truncated/);
});
