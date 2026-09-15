import { redactSecrets } from '../redaction.mjs';

// Small, dependency-free BM25 implementation. The current retrieval path scores
// every candidate by "how many query terms appear as substrings", which cannot
// tell a term that appears once from one that appears five times, and cannot
// discount a term that is common across the whole corpus. BM25 fixes both with
// term frequency saturation and inverse document frequency, while staying a pure
// function over plain text so it remains testable without any service.

const STOP = new Set([
  '的', '了', '和', '我', '你', '请', '一下', '哪些', '什么', '最近', '之前', '现在', '关于', '是否',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'are', 'for', 'with', 'this', 'that',
]);

export function tokenize(text) {
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase();
  const tokens = [];
  // Latin/digit runs stay whole; each CJK character is its own token, which keeps
  // the index small and avoids depending on a segmenter for every document.
  for (const match of normalized.matchAll(/[a-z0-9]+|[\u3400-\u9fff]/g)) {
    const token = match[0];
    if (STOP.has(token)) continue;
    tokens.push(token);
  }
  return tokens;
}

export function buildIndex(documents) {
  const rows = documents.map((doc) => ({
    id: String(doc.id),
    terms: tokenize(`${doc.title ?? ''} ${doc.text ?? ''} ${doc.extra ?? ''}`),
    doc,
  }));
  const documentFrequency = new Map();
  for (const row of rows) {
    for (const term of new Set(row.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageLength = rows.length ? rows.reduce((total, row) => total + row.terms.length, 0) / rows.length : 0;
  return { rows, documentFrequency, averageLength, size: rows.length };
}

// Standard BM25 with k1=1.2, b=0.75. Returns scored results sorted by score desc.
export function search(index, query, { limit = Infinity, k1 = 1.2, b = 0.75 } = {}) {
  const queryTerms = [...new Set(tokenize(redactSecrets(String(query ?? ''))))];
  if (!queryTerms.length || !index.size) return [];
  const results = [];
  for (const row of index.rows) {
    if (!row.terms.length) continue;
    const frequencies = new Map();
    for (const term of row.terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const frequency = frequencies.get(term);
      if (!frequency) continue;
      const df = index.documentFrequency.get(term) ?? 0;
      // BM25 IDF with a floor so a term present in every document still scores.
      const idf = Math.log(1 + (index.size - df + 0.5) / (df + 0.5));
      const denominator = frequency + k1 * (1 - b + b * (row.terms.length / (index.averageLength || 1)));
      score += idf * ((frequency * (k1 + 1)) / denominator);
    }
    if (score > 0) results.push({ id: row.id, score, doc: row.doc });
  }
  return results.sort((a, b2) => b2.score - a.score || a.id.localeCompare(b2.id)).slice(0, limit);
}
