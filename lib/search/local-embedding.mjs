import { redactSecrets } from '../redaction.mjs';

export const DEFAULT_MODEL = 'text-embedding-embeddinggemma-300m';

export function localEndpoint(value = 'http://127.0.0.1:1234/v1/embeddings') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/embeddings') {
    throw new Error('Embedding endpoint must be an HTTP loopback IP at /v1/embeddings');
  }
  return url.href;
}

export function validateVectors(vectors, count, dimension = null) {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error('Embedding count mismatch');
  let expected = dimension;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length || vector.some((n) => !Number.isFinite(n))) {
      throw new Error('Invalid embedding vector');
    }
    expected ??= vector.length;
    if (vector.length !== expected || expected > 16384) throw new Error('Embedding dimension mismatch');
    if (!vector.some((n) => n !== 0)) throw new Error('Zero embedding vector');
  }
  return expected;
}

export function cosine(a, b) {
  validateVectors([a, b], 2);
  let dot = 0; let left = 0; let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]; left += a[i] ** 2; right += b[i] ** 2;
  }
  const value = dot / Math.sqrt(left * right);
  if (!Number.isFinite(value)) throw new Error('Invalid cosine similarity');
  return Math.max(-1, Math.min(1, value));
}

export async function embedLocal(texts, {
  endpoint, model = DEFAULT_MODEL, timeoutMs = 30000, fetchImpl = fetch,
} = {}) {
  const url = localEndpoint(endpoint);
  if (!Array.isArray(texts) || !texts.length || texts.length > 32
    || texts.some((text) => typeof text !== 'string' || !text.trim() || text.length > 16000)) {
    throw new Error('Embedding input must contain 1-32 non-empty bounded texts');
  }
  if (typeof model !== 'string' || !model.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Invalid embedding options');
  }
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: texts.map(redactSecrets) }),
  });
  // Do not include the response body in errors: providers can echo input text.
  if (!response.ok) throw new Error(`Local embedding HTTP ${response.status}`);
  const data = await response.json();
  if (data.model !== model) throw new Error('Embedding model mismatch');
  if (!Array.isArray(data.data) || data.data.length !== texts.length) throw new Error('Embedding count mismatch');
  const rows = [...data.data].sort((a, b) => a.index - b.index);
  if (rows.some((row, index) => row.index !== index)) throw new Error('Embedding index mismatch');
  const vectors = rows.map((row) => row.embedding);
  validateVectors(vectors, texts.length);
  return vectors;
}
