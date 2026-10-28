# P2 governance increment

This increment adds pure governance primitives and integrates their admission and visibility contracts into the ordinary CLI, MCP, hooks and projections. The governance report remains read-only: it does not apply candidates, rewrite immutable events or expose a bulk-apply endpoint.

## API contract

- `lib/visibility.mjs`
  - `visibilityOf(item, { history, includeCandidates, now })` combines `visibilityStatus`, `visibility`, `status`, `lifecycle`, `visible:false`, `hidden:true`, and expiry aliases (`expires`, `expiresAt`, `dateExpires`, `date_expires`). The strictest blocker wins. Date-only expiry follows `experience.retention`: valid through that UTC date. `history:true` returns hidden rows as `historical:true` while preserving `status` and `reason`; it does not make them current.
  - `filterVisible`, `projectVisibility`, and `partitionVisibility` are pure filters/projections and never mutate input.
- `lib/governance.mjs`
  - `admissionDecision(input)` gates collection/no-record before reading or hashing text. Collection denial wins over explicit request and state change; denied results contain only decision metadata, never body/summary/digest or a recorded-success claim. Allowed scoring reuses `lib/ingest/pipeline.mjs` `importanceScore`/`isImportant`; explicit requests and substantive state changes are protected overrides.
  - `deduplicate(items, { key })` only treats normalized exact text as duplicate inside the same exact `workspace/topic/task/branch`; missing workspace or text is not auto-deduplicated. Hidden rows pass through by default. It returns authoritative `duplicates.length` and does not mutate rows.
  - `buildGovernanceCandidates` and `lifecycleOf` produce candidates only. Dormant/unknown/old facts are `review`, never automatic hide/delete; evidence references and recovery instructions are included.
- `lib/governance-report.mjs`
  - `governanceReport(items, { now, history, dedupe })` is report-only (`applied:false`) and read-only. It reports visibility, authoritative duplicate count, and deduped-source stats by type/project/date/bytes. Candidates include reasons, evidence references, affected views, status, and recovery instructions.
  - `formatGovernanceReport` renders those statistics and audit/recovery metadata. There is no apply-success API.

Callers integrating core/hooks/lifecycle should pass the already-resolved collection decision (or `config` plus context) to `admissionDecision` before constructing evidence, summaries, logs, or queue entries. They remain responsible for persistence and any explicitly approved reversible state change.

## Integrated boundaries

- `capture` and `submitCapture` evaluate admission before reservations, queue bodies or evidence writes. Normal denials return `status: skipped, recorded: false`; no worker is started for a skipped async request. `explicit: true` is reserved for a real user memory request and never overrides no-record or collection exclusions.
- Queue drain and checkpoint retry revalidate privacy and credentials. Rejected existing transport payloads remain available for authorized private review rather than being silently erased or called recorded.
- Default task retrieval includes scoped facts, registered note sections, experiences and current contexts. Both sync and async adapters preserve workspace identity; synchronous hooks explicitly report keyword-only degradation.
- Item-level supersession preserves unrelated facts/actions in mixed events. Governance reports give drop/superseded blockers precedence over an item's own active status; explicit history retains the historical reason.
- Checkpoint health counts intentional skipped rows separately from invalid/pending rows. A skipped result is neither an archive nor corruption.
