#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildSemanticIndex, indexedRecall } from '../lib/search/semantic-index.mjs';
import { rankingMetrics, summarizeEvaluation, validateCorpus } from '../lib/search/evaluation.mjs';

const source = process.argv[2] ? path.resolve(process.argv[2]) : new URL('../examples/retrieval-zh.json', import.meta.url);
const corpus = validateCorpus(JSON.parse(fs.readFileSync(source, 'utf8')));
const documents = corpus.documents.map(({ id, text }) => [id, text]);
const cases = corpus.cases;
const topics = [{ id: 'demo/retrieval', workspace: 'demo' }];
const projection = { conflicts: [], facts: documents.map(([key, text]) => ({
  key, text, topic: topics[0].id, event_id: `synthetic-${key}`,
})) };
const report = [];
const units = projection.facts.map((fact) => ({ id: fact.key, text: fact.text, sourceType: 'fact' }));
const index = await buildSemanticIndex(units);
for (const item of cases) {
  const { query, relevance } = item;
  const started = performance.now();
  const result = await indexedRecall(units, query, index);
  const routes = Object.fromEntries(['exact', 'keyword', 'semantic', 'fused'].map((name) => {
    const ids = (name === 'fused' ? result.fused : result.routes[name]).map((r) => r.id);
    return [name, { ids, at5: rankingMetrics(ids, relevance, 5), at10: rankingMetrics(ids, relevance, 10) }];
  }));
  report.push({ ...item, routes,
    elapsedMs: Math.round(performance.now() - started), degraded: result.degraded });
}
console.log(JSON.stringify({ corpus: corpus.id, labelStatus: corpus.labelStatus, cases: report,
  summary: summarizeEvaluation(report),
  splits: Object.fromEntries([...new Set(report.map((r) => r.split))].map((split) =>
    [split, summarizeEvaluation(report.filter((r) => r.split === split))])),
}, null, 2));
if (report.some((r) => r.degraded)) process.exitCode = 2;
