# Local Semantic Retrieval: Shadow Pilot

Status: experimental, not deployed to automatic recall or hooks.

The sections below describe the original in-memory fact-only pilot. The newer
scripts/knowledge-upgrade.mjs indexed path implements v3 rebuildable chunked
indexes, active experiences, explicitly registered note sections and exact-fact
fusion. See knowledge-upgrade-acceptance.md for current commands and limits.
The in-memory shadow command remains fact-only; it is not the indexed path.

## Scope

The pilot reads current event-backed facts from one explicit workspace. It skips
archived/superseded topics and topics with pending events. Query identifiers are
mandatory across both keyword and semantic routes. Conflict labels are preserved.
No inference, preference promotion or knowledge-page writes are performed.

The development checkout is the implementation target. Runtime copies must not
be assumed to update when the checkout changes.

## Commands

From the checkout:

```text
node scripts/eval-shadow.mjs
node scripts/shadow-recall.mjs --home YOUR_MEMORY_HOME --workspace WORKSPACE_ID --query "YOUR_QUERY"
```

The default endpoint is `http://127.0.0.1:1234/v1/embeddings`, with model
`text-embedding-embeddinggemma-300m`. Optional `--endpoint` and `--model` overrides
are accepted; the endpoint must remain an HTTP loopback IP at `/v1/embeddings`.
Redirects are prohibited. Recognizable secrets are redacted before inference.
This is not a guarantee that all sensitive information is detected.

The shadow command outputs the legacy baseline, BM25 candidates, semantic
candidates, RRF ranks and source ranks. It does not change baseline ordering.
It computes vectors in memory each time; it writes no persistent index or vault
content. The default corpus cap is 200 facts, and `--max-units` can explicitly
raise it up to 1000. A larger corpus fails rather than silently sampling it.

Exit codes: 0 = completed; 1 = invalid configuration/input or ledger failure;
2 = embeddings unavailable/invalid, with keyword fallback in the output.
Provider error bodies are not copied into diagnostics.

## Validation Performed

- Eight unit tests cover loopback restrictions, redaction, response validation,
  workspace/pending/identifier filtering, conflict labels, fusion duplicates,
  explicit fallback, and corpus limits.
- Synthetic Chinese smoke corpus: seven documents and six paraphrased queries.
  On the tested local model, keyword Top-1 was 3/6, semantic and fused Top-1 5/6.
  This tiny authored corpus is not an independent benchmark or release gate.
- A real identifier-scoped query returned 18 eligible facts, 768-dimensional
  vectors and no fallback. No factual correctness claim follows from that smoke
  test; final ranks need human relevance labels.

## Remaining Work

1. Add reviewed Chinese relevance labels and a held-out evaluation set; report
   Recall@5/10, nDCG, false positives and latency on representative workspaces.
2. Add exact-fact candidate diagnostics and unify source identity across facts,
   experiences and note sections. The pilot only fuses BM25 and semantic routes.
3. Design persistent, rebuildable indexes with content/model/template versions,
   bounded batching and atomic publication. Reads must remain side-effect free.
4. Test query/document formatting for the selected embedding model instead of
   assuming raw-text input is the best retrieval configuration.
5. Decide semantic minimum-relevance/abstention rules using evaluation data.
   Currently nearest neighbours are diagnostic candidates, not trusted answers.
6. Only then consider runtime deployment and opt-in automatic recall. Independent
   inference and dependency-aware knowledge pages remain separate later phases.
