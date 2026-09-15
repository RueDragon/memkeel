import { buildIndex, search } from './bm25.mjs';

// Bridges the note index (title + full search text) onto BM25. Index entries already
// carry a lowercased `search` field containing title and body, so ranking does not
// need to re-read any Markdown. Kept separate from bm25.mjs so the scorer stays a
// pure function with no knowledge of the vault index shape.

export function buildNoteIndex(entries) {
  return buildIndex(entries.map((row) => ({
    id: row.path,
    title: row.title ?? '',
    text: row.search ?? '',
    doc: row,
  })));
}

// Returns a Map(path -> score) for the given query, so callers can keep their own
// eligibility rules (workspace scope, archived status, mandatory identifiers) and
// use BM25 only to rank the survivors.
export function scoreNotes(index, query, { limit = Infinity } = {}) {
  const scores = new Map();
  for (const hit of search(index, query, { limit })) scores.set(hit.id, hit.score);
  return scores;
}
