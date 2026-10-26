# Knowledge Upgrade Acceptance Plan

## Delivery Boundary

Local runtime rollout is user-authorized. Default recall ordering stays unchanged;
the new explicit CLI entry is `node bin/memkeel.mjs knowledge COMMAND`, and MCP
agent_memory_read exposes knowledge_recall and knowledge_inspect. These MCP actions
are read-only. Candidate writes/page refreshes require explicit CLI execution.
No GitHub/npm publication is part of this rollout.

## Commands

Optional config.json knowledgeSearchNotes is an explicit list of {topic, path}
registrations with vault-relative paths. No vault-wide discovery occurs.
Sections remain note-material-not-instruction and are not inference evidence.
Archived notes, wrong workspace metadata and history subtrees are excluded.

```text
node scripts/knowledge-upgrade.mjs index --home MEMORY_HOME --workspace WORKSPACE
node scripts/knowledge-upgrade.mjs index --home MEMORY_HOME --workspace WORKSPACE --execute
node scripts/knowledge-upgrade.mjs recall --home MEMORY_HOME --workspace WORKSPACE --query "QUESTION"
node scripts/knowledge-upgrade.mjs observation --home MEMORY_HOME --workspace WORKSPACE --topic WORKSPACE/TOPIC --proposal PROPOSAL.json
node scripts/knowledge-upgrade.mjs observation --home MEMORY_HOME --workspace WORKSPACE --topic WORKSPACE/TOPIC --proposal PROPOSAL.json --execute
node scripts/knowledge-upgrade.mjs inspect --home MEMORY_HOME --workspace WORKSPACE
node scripts/knowledge-upgrade.mjs page --home MEMORY_HOME --workspace WORKSPACE --topic WORKSPACE/TOPIC
node scripts/refresh-knowledge.mjs --home MEMORY_HOME
node scripts/refresh-knowledge.mjs --home MEMORY_HOME --retry-failed
node scripts/refresh-knowledge.mjs --home MEMORY_HOME --retry-failed --execute
node scripts/smoke-local-generator.mjs --model ALREADY_LOADED_CHAT_MODEL
```

Append `--execute` to a page or refresh command only after reviewing its target.
After fixing a failure, --retry-failed resets failed/deferred attempts only for
currently eligible topics. Without --execute this remains read-only. Pending,
conflicted or manually changed pages are not force-published. Each child has a
120-second timeout; failures/exhaustion return exit code 2. Unknown arguments
are rejected rather than silently ignored.
Derived pages live under `projectRoot/knowledge-upgrade`, not canonical topic
notes. Candidates and indexes live under the home's `state/knowledge-upgrade`.
Index files contain vectors and hashes, not copied fact text. Vectors are still
sensitive derived data, not anonymised data.

A proposal has `claim`, `kind`, `support:[{id,quote}]` and optional
`counterevidence:[{id,quote}]`. CLI source IDs are `event_id/fact_key`.
Model proposals can be requested with `--model LOCAL_CHAT_MODEL` instead of a
proposal file, but only topics with at most eight facts fit the current bounded
interface. No model is automatically chosen or downloaded. The CLI conservatively
counts all unverified origins as one; independence must be established before
that constraint is relaxed. Candidates never become facts or habits.
The generator smoke first checks the loopback model inventory and refuses unloaded
models without a completion request. It uses only synthetic evidence, validates
exact citations and returns persisted=false; it never writes a candidate.

## User Acceptance Cases

1. Ask a paraphrased Chinese question whose answer lacks the original words.
   Compare legacy output with keyword/semantic/fused results. Mark relevance.
2. Query a numeric environment identifier; verify no neighbouring identifier or
   other workspace appears, even when its meaning is very similar.
3. Rebuild an unchanged index: embedded count should be zero. Change a fact through
   the supported event path: old vector must not participate until rebuild.
4. Stop the embedding service: query must report degradation and return keyword
   candidates; it must not contact remote endpoints or write files.
5. Submit a proposal with an invented quote or wrong-project source: reject it.
   Valid proposals remain candidates with evidence and no instruction authority.
6. Correct/retire a supporting fact: inspect must mark its observation stale and
   unusable. Counterevidence must prevent normal use.
7. Publish a page in a disposable test home. Add manual text outside the managed
   block: refresh preserves it. Edit inside the block: refresh refuses replacement.
8. Interrupt publication after page write but before manifest write: retry restores
   the manifest without duplicating or overwriting the page.
9. Add pending events or conflicts: pages must be dirty/blocked, never silently
   treated as current. No page refresh may mark journal events consumed.

## Outstanding Release Gates

Index format v3 fingerprints the model ID, declared weight revision, local
endpoint, query/document prefixes and chunk settings. Use the same --model-revision,
--query-prefix and --document-prefix on index, recall and inspect commands.
Any profile change requires a rebuild; v1/v2 indexes are incompatible. The default
revision is explicitly unverified-model-id. The server does not attest weight
hashes: operators must change --model-revision when replacing same-ID weights.
Inspect reports profile compatibility, declared revision and stale unit counts;
a declared label is not independent verification of the model's weights.

- A reviewer-labelled Chinese relevance set with a held-out portion is not yet
  available. The 13 authored development questions are not a benchmark. Review labels
  before using Recall@5/10 or nDCG to approve automatic retrieval.
- Indexed retrieval includes active scoped experiences and registered note sections.
  Exact-fact/BM25/semantic equal-weight fusion requires reviewer-labelled tuning:
  authored-corpus nDCG@10 regressed from 0.969 to 0.956, Recall@5 remained 1.0.
- Query/document prefixes and declared same-ID weight revisions are versioned in
  v3 profiles. Model-specific prefix choice and abstention thresholds still need
  evaluation before release. Chunking is bounded by characters, not exact model
  tokens; verify model context behaviour on representative documents.
- Direct publications now use the existing canonical writer lock, and the refresh
  worker has a separate queue lock. Page/candidate process-kill tests and candidate
  concurrent-writer tests pass. Full CLI page/worker contention passed five
  consecutive runs, preserving manual content and one generated block.
- Observation revisions/retirement, durable independent-origin metadata and UI
  review are not integrated into the immutable journal yet. State candidates are
  experimental artifacts, not durable authorised knowledge. Candidate revisions
  and retirement are now recorded in a separate append-only hash-validated journal;
  the remaining gap is integration with reviewed origins and user-facing governance.
- The refresh worker is explicitly invoked; no scheduler or hook is installed.
  Failed tasks must be inspected, not assumed repaired automatically.
- Actual local chat model generation needs a real smoke test; current validation
  uses a mocked provider. Never claim real generation success from unit tests.
- Package inclusion, full regression, read-only checks and real Obsidian readback
  must pass before runtime deployment. Deployment remains subject to user approval.

## Current Verified Results

Local rollout gates: 593 tests, 587 pass, 6 skip, 0 fail; syntax 142 files OK;
package scan passed for 126 files. Real Obsidian-backed isolated acceptance passed
index build/reuse, Chinese retrieval, candidate persistence in a separate home,
page readback and preservation of manual text. Qwen smoke returned valid abstention.

Qwen3.5 template inspection found the default generation prefix opens <think>.
On the installed LM Studio runtime, reasoning_effort=none closes this prefix and
routes structured JSON to final content. enable_thinking=false and reasoning.enabled
did not change routing. The generator now uses the working request-level setting,
explicit task/category definitions and rejects length-truncated output.
Real Chinese evidence produced a failure-pattern candidate with two exact citations;
the fixed smoke also abstained. Both remain non-instruction outputs and no candidate
was persisted. Generation yield/category quality is not yet established by a benchmark.

User-authorized qwen/qwen3.5-9b real smoke: model inventory confirmed loaded.
The installed LM Studio rejected json_object response format, so generation now
requests json_schema. Real structured responses placed JSON in reasoning_content
with empty final content; smoke failed closed and saved no candidate. A text-mode
and thinking-disable probe also failed final JSON validation. Reasoning-only
output is explicitly rejected; 13 related tests passed. Model remains loaded.

Unresolved fact conflicts block inference proposals before model calls and are
rechecked under the publication lock. Existing candidates report conflicted-evidence
and usable=false; archived/superseded topics are also disabled. Page construction
rejects conflicted topics even when the target page is absent. An isolated real
event-chain test verifies that neither a new candidate nor a page is published.

Corrupt index JSON no longer blocks unrelated candidate/page commands. Inspect
reports invalid-index-file and recall degrades to keyword/exact candidates without
repairing the file. Current-format indexes validate profile fingerprints, unique
IDs, hashes, dimensions and bounded nonzero vectors before model requests.
Explicit rebuild discards malformed reusable cache rather than trusting it.

Current contention/diagnostic regression: 586 tests, 580 pass, 6 skip, 0 fail;
syntax: 135 files OK; package scan passed. A subsequent worker exit-code change
passed CLI and contention tests. Worker execution returns exit code 2 when any
queued task remains failed or exhausted, so callers cannot mistake it for success.

Unified inspect reports workspace-scoped refresh tasks, attempts and retry
exhaustion without exposing provider error details. Contention tests run one
page writer and two workers, then retry and verify one fresh page, no pending
intents and no remaining locks.

Candidate journal process tests serialize three concurrent writers (including
one identical retry) without record loss. Killing before and after atomic rename
leaves zero or one complete record; retry is idempotent. A killed writer retains
its fail-closed lock. Tests confirm the holder exited, then remove only the isolated
fixture lock; production locks are never automatically removed. Inspect now reports
both canonical writer and refresh-worker lock ownership/status read-only.

Local model inventory currently shows only embeddinggemma loaded. Chat models
The smoke command was run against qwen/qwen3.5-9b and correctly refused it as
not-loaded; no chat request was sent. A real generation result remains pending an
explicit model-loading decision.
are installed but not loaded; no automatic loading or chat inference was performed.

Latest full regression after index-integrity and retry changes: 587 tests, 581 pass,
Latest full regression after conflict guards and generator smoke: 590 tests, 584 pass,
6 skip, 0 fail; syntax check: 140 files OK. Package scan: 125 shipped files,
leak scan clean for inspected text (10 font files outside text coverage).

Knowledge-page crash tests kill a real child process at intent, page and manifest
checkpoints. The refresh worker also queues a page whose bytes match its pending
intent, so a manifest-only interruption is recoverable through the worker.
A retry preserves the complete page, recovers the manifest and leaves
no pending intent. The test uses the filesystem transport; an Obsidian-backed
process-kill run remains outside this development checkout.

The index plan on the real local home currently reports 137 eligible units for
the fund-strategy-lab workspace, including registered source kinds. This was a
read-only plan and did not write the index or vault.

After corpus expansion, package scan passed (121 shipped files; text leak scan
clean, 10 font files not inspected). Full regression first reported 572 pass,
1 fail and 6 skip; its failing case was not retained. An immediate full rerun
reported 573 pass, 0 fail and 6 skip across 579 tests. The unexplained first
failure remains a verification caveat; retain a complete report on final acceptance.

Long text indexes use overlapping Unicode chunks (default 2000 characters with
200 overlap), at most 16 inputs per provider request and 100000 UTF-16 units per
source. --chunk-chars and --overlap-chars are profile-versioned CLI options.
Rows keep vectors grouped by source, and semantic results use the best segment
score with one result per source. No chunk text is copied into index files.
A real local embedding test processed a >20000-character Chinese source into
12 segments of 768 dimensions and returned one source without degradation.

Candidate journal reads now validate stored evidence schema, nonempty support,
derived origin counts and contested state, contiguous sequence numbers and
filename/record identity. Observation inspection rechecks quoted text and the
entire topic source fingerprint; additional evidence requires renewed review.
These checks detect malformed records and interior deletion, not adversarial
rewrites of all records or deletion of the journal tail without an external anchor.

Page inspect and refresh planning now verify the actual page file and managed
block, not just the dependency manifest. A missing file is missing, manual edits
inside the block are blocked, and edits outside it preserve freshness. Interrupted
publication verifies readback and rechecks sources before manifest recovery;
recovering an older revision is reported dirty rather than fresh. These paths
are covered by isolated CLI, unit and real child-process kill tests.

Chinese evaluation uses 13 agent-authored, not human-reviewed questions from
examples/retrieval-zh.json. Local embedding execution showed fused Recall@5 1.0
and nDCG@10 0.969 on answerable questions, but the no-answer question returned
10 fused candidates. This is development evidence, not a release benchmark.

Persistent index smoke test on one real workspace: 111 active facts, 768 dimensions;
second build reused 111 vectors and embedded zero. Indexed query returned both
routes without degradation or stale rows. No canonical memory or runtime file
was modified. CLI page publication/candidate persistence was verified in a
self-cleaning disposable filesystem home. Real Obsidian page publication was not
executed.
