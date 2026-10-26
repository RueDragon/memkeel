export function validateCorpus(corpus) {
  const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
  if (!corpus || !nonempty(corpus.id) || !nonempty(corpus.labelStatus)
    || !Array.isArray(corpus.documents) || !corpus.documents.length
    || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error('Invalid evaluation corpus');
  const ids = new Set();
  for (const document of corpus.documents) {
    if (!document || !nonempty(document.id) || !nonempty(document.text) || ids.has(document.id))
      throw new Error('Invalid or duplicate document');
    ids.add(document.id);
  }
  const questions = new Set();
  for (const item of corpus.cases) {
    if (!item || !nonempty(item.id) || questions.has(item.id) || !nonempty(item.query)
      || !nonempty(item.split) || !item.relevance || typeof item.relevance !== 'object'
      || Array.isArray(item.relevance)) throw new Error('Invalid evaluation case');
    questions.add(item.id);
    for (const [id, grade] of Object.entries(item.relevance)) {
      if (!ids.has(id) || !Number.isInteger(grade) || grade < 0 || grade > 3)
        throw new Error('Invalid relevance label');
    }
  }
  return corpus;
}

export function rankingMetrics(ids, relevance, k = 10) {
  if (!Number.isInteger(k) || k < 1) throw new Error('Invalid metric cutoff');
  const grades = Object.entries(relevance);
  if (grades.some(([, grade]) => !Number.isInteger(grade) || grade < 0 || grade > 3)) throw new Error('Invalid relevance grade');
  const relevant = grades.filter(([, grade]) => grade > 0);
  const ranked = [...new Set(ids)];
  const top = ranked.slice(0, k);
  if (!relevant.length) return { recall: null, ndcg: null, reciprocalRank: null, falseReturns: top.length };
  const gain = (grade, index) => (2 ** grade - 1) / Math.log2(index + 2);
  const dcg = top.reduce((sum, id, i) => sum + gain(relevance[id] ?? 0, i), 0);
  const ideal = relevant.map(([, grade]) => grade).sort((a, b) => b - a).slice(0, k)
    .reduce((sum, grade, i) => sum + gain(grade, i), 0);
  const first = ranked.findIndex((id) => (relevance[id] ?? 0) > 0);
  return { recall: top.filter((id) => (relevance[id] ?? 0) > 0).length / relevant.length,
    ndcg: dcg / ideal, reciprocalRank: first < 0 ? 0 : 1 / (first + 1), falseReturns: null };
}

export function summarizeEvaluation(rows) {
  const mean = (values) => values.length ? values.reduce((sum, n) => sum + n, 0) / values.length : null;
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.routes)))];
  const routes = Object.fromEntries(names.map((name) => {
    const metrics = rows.map((r) => r.routes[name]).filter(Boolean);
    const answered = metrics.filter((m) => m.at10.recall !== null);
    const unanswered = metrics.filter((m) => m.at10.recall === null);
    return [name, { recall5: mean(answered.map((m) => m.at5.recall)),
      recall10: mean(answered.map((m) => m.at10.recall)), ndcg10: mean(answered.map((m) => m.at10.ndcg)),
      mrr: mean(answered.map((m) => m.at10.reciprocalRank)),
      noAnswerCases: unanswered.length, falseReturns: unanswered.reduce((sum, m) => sum + m.at10.falseReturns, 0) }];
  }));
  const times = rows.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const percentile = (p) => times.length ? times[Math.max(0, Math.ceil(p * times.length) - 1)] : null;
  return { cases: rows.length, routes, p50Ms: percentile(0.5), p95Ms: percentile(0.95),
    degradedCases: rows.filter((r) => r.degraded).length };
}
