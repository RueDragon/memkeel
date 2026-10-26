# Memkeel Local Rollout - 2026-10-13

## Installed Outcome

Runtime: C:/Users/<you>/Code/memkeel-app
Home: C:/Users/<you>/.memkeel

Local upgrade is installed, not published to GitHub/npm. Legacy bootstrap and
recall ordering is preserved. Indexed retrieval is explicitly available through
CLI and MCP; it returns candidates, not guaranteed answers. No automatic model
candidate promotion or automatic refresh scheduler is installed.

## Verification

- Full regression: 593 tests, 587 passed, 6 skipped, 0 failed.
- Syntax: 142 files passed.
- Package scan: 126 shipped files; text scan passed, 10 font files not inspected.
- Runtime/package comparison: all 126 files match, no extras.
- Real Obsidian-backed isolated acceptance passed from checkout and runtime:
  index build/reuse, Chinese retrieval, candidate authority, page readback and
  manual-content preservation. Qwen produced valid abstention; an earlier Chinese
  probe produced a candidate with exact citations. Generation quality is not yet
  established by a reviewer-labelled benchmark.
- Actual fresh runtime MCP knowledge_recall: 10 results, stale=0, degraded=null.
- Indexes built (workspace IDs anonymized): my-project 1555; sample-project-b 137;
  sample-project-c 827; sample-project-d 376; sample-project-e 397. Embedding dimension: 768. First index repeat
  build reused all 1555 with zero provider embeddings.

## Usage

```text
node "C:/Users/<you>/Code/memkeel-app/bin/memkeel.mjs" knowledge inspect --home "C:/Users/<you>/.memkeel" --workspace my-project
node "C:/Users/<you>/Code/memkeel-app/bin/memkeel.mjs" knowledge recall --home "C:/Users/<you>/.memkeel" --workspace my-project --query "QUESTION"
node "C:/Users/<you>/Code/memkeel-app/bin/memkeel.mjs" knowledge index --home "C:/Users/<you>/.memkeel" --workspace my-project --execute
node "C:/Users/<you>/Code/memkeel-app/scripts/refresh-knowledge.mjs" --home "C:/Users/<you>/.memkeel"
node "C:/Users/<you>/Code/memkeel-app/scripts/smoke-local-generator.mjs" --model qwen/qwen3.5-9b
```

MCP agent_memory_read actions: knowledge_recall (workspace + query),
knowledge_inspect (workspace). They cannot build indexes or publish pages.
Existing chat clients may need MCP reconnection/a new chat to rediscover actions.
A freshly started runtime server was verified directly.

Page commands preview by default. Add --execute to publish only after reviewing
its target. Model candidate proposals use observation with --topic and --model;
writing requires --execute. All outputs remain inference-not-instruction.

## Backup And Rollback

Verified memory archive:
C:/Users/<you>/memkeel-backups/pre-knowledge-local-20261013-retry1
24672 files, 4209985713 bytes. Backup verification found no missing, extra or
corrupted files. The first archive (without retry1) is incomplete, not a rollback.

Verified complete previous runtime:
C:/Users/<you>/memkeel-backups/runtime-pre-knowledge-20261013

Directory rename failed with EBUSY because MCP clients held it open. The old
runtime was copied and compared before an in-place package copy; the final tree
was compared against the artifact. Only exact matching runtime MCP processes
were stopped, no unrelated Node processes. To roll back, stop/reconnect those
clients and restore this previous runtime copy, then compare trees. Do not restore
an old memory archive over ongoing new work. New knowledge-upgrade indexes are
rebuildable; candidate journals are separate and should be preserved.

## Residual Conditions

Doctor verifies ledger, bindings and launcher, but does not currently exit green:
a pre-existing checkpoint is rejected by the secret guard and five previously
registered topic pages are unbuilt. No secret guard was bypassed, no checkpoint
was deleted, and no unrelated source was repaired. These are reported honestly
rather than treated as a failed deployment of the new modules.

Retrieval evaluation is agent-authored (13 cases), not a human-reviewed held-out
set. Equal-weight three-arm fusion slightly regressed nDCG relative to two arms;
no-answer cases still return neighbours. Therefore explicit candidate retrieval
is enabled, not automatic replacement of legacy recall. This limitation requires
future relevance labelling/tuning, not relaxation of source scope or authority.

Synthetic acceptance notes were retained in the vault under the distinct
knowledge-upgrade-acceptance directory, with independent temporary test homes.
They are not registered in the formal home and are not formal evidence/candidates.
