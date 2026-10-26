import { localEndpoint } from '../search/local-embedding.mjs';
import { sha } from '../transport.mjs';
import { proposeObservation } from './local-generator.mjs';

// Inventory is read-only. Refuse to invoke a model that could be auto-loaded.
export async function generatorSmoke({ model, endpoint = 'http://127.0.0.1:1234/v1/chat/completions', fetchImpl = fetch } = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('Explicit --model required');
  const url = new URL(endpoint);
  if (url.pathname !== '/v1/chat/completions') throw new Error('Invalid local chat endpoint');
  localEndpoint(endpoint.replace('/v1/chat/completions', '/v1/embeddings'));
  const inventory = await fetchImpl(new URL('/api/v0/models', url).href, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!inventory.ok) throw new Error('Cannot verify loaded local models');
  const data = await inventory.json();
  const matches = Array.isArray(data.data) ? data.data.filter((row) => row.id === model) : [];
  if (matches.length !== 1 || matches[0].state !== 'loaded' || !['llm', 'vlm'].includes(matches[0].type)) {
    throw new Error('Requested chat model is not verified loaded; no generation attempted');
  }
  const scope = { workspace: 'synthetic', topic: 'synthetic/transport' };
  const sources = [
    '\u6d4b\u8bd5\u7532\uff1a\u591a\u5c42\u5d4c\u5957\u5f15\u53f7\u5bfc\u81f4\u53c2\u6570\u53d8\u5316\uff0c\u6539\u7528\u811a\u672c\u6587\u4ef6\u540e\u53c2\u6570\u6b63\u786e\u3002',
    '\u6d4b\u8bd5\u4e59\uff1a\u53e6\u4e00\u4e2a\u72ec\u7acb\u6d4b\u8bd5\u540c\u6837\u89c2\u5bdf\u5230\u5d4c\u5957\u5f15\u53f7\u7834\u574f\u53c2\u6570\uff0c\u811a\u672c\u6587\u4ef6\u4f20\u8f93\u4fdd\u6301\u53c2\u6570\u4e0d\u53d8\u3002',
  ].map((text, i) => ({ ...scope, id: `synthetic-${i}`, root: `synthetic-origin-${i}`, text, hash: sha(text) }));
  const started = performance.now();
  const observation = await proposeObservation(sources, scope, { model, endpoint, fetchImpl });
  return { mode: 'read-only-synthetic-smoke', model, elapsedMs: Math.round(performance.now() - started),
    status: observation.status, authority: observation.authority, observation,
    interpretation: 'Schema and exact citations verified; inference correctness still requires human review.', persisted: false };
}
