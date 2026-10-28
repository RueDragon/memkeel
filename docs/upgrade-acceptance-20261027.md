# Memkeel 1.1.0 Upgrade Acceptance

Final verification: 2026-10-28, Windows, Node 22.22.3. Base commit: `bf99c46`
(1.0.1). This replaces the implementation-stage template. The annotated
`v1.1.0` tag identifies the final public code. Private runtime, store, host
configuration and recovery evidence are deliberately not committed.

## Decision

The program release and default runtime deployment passed the gates below.
The production store is **not fully healthy**: one sensitive checkpoint remains
isolated for human inspection, seven empty topic registrations have no generated
note, and installed host files have drifted from the old setup receipt. These
are not represented as repaired or as successful host-session tests.
No npm publication is part of this release.

## Current Evidence

| Verification | Actual result |
| --- | --- |
| `node scripts/release-check.mjs` | Exit 0; 659 tests passed, 0 failed; syntax, source leak scan, packaged leak scan, contents, version/changelog, runtime imports and real tarball installation passed |
| Final raw `npm test` | Exit 0; 665 total, 659 passed, 0 failed, 6 skipped |
| Independent focused process tests | 18 passed, 0 failed, 0 skipped: integration-upgrade, task-retrieval-integration and admission-checkpoint |
| Default runtime `sync-app --keep-rollbacks` | Atomic directory replacement completed; previous runtime retained; no older rollback pruned |
| Default runtime `sync-app --check` | Exit 0; all 135 packaged files identical to the checkout artifact; independently repeated |
| Formal-home CLI `config validate` | Exit 0, valid migrated configuration |
| Formal-home CLI `doctor` | Exit 1 with explicit pending/attention state; valid ledger, no unconsumed events or captures; details below |
| Fresh default-runtime MCP | initialize returned 1.1.0; tools/list, read-only status and task-aware bootstrap succeeded |
| Read-only snapshots | Configuration and existing journal bytes unchanged; no new events; queue unchanged; one live host session metadata file changed concurrently |
| Original event identity | All 4,250 pre-repair canonical event hashes unchanged; first smoke snapshot 4,256 events; independently repeated; concurrent new events retained |
| Retrieval fallback | Task retrieval executed; missing semantic index explicitly reported as keyword fallback |
| `setup --check` | Exit 1; host files refused because bytes differ from the old receipt; no forced rebind |
| `git diff --check` | Passed before release |

The release checker installs the real artifact under node_modules, not merely
an unpacked checkout. Its generic warning that it does not upgrade a live home
does not describe the separate authorized deployment and production smoke above.

An additional raw test run initially failed one fixture's literal path-prefix
assertion because TEMP used forward slashes. Normalizing TEMP/TMP to native
Windows paths, without changing product or test logic, produced the final
665/659/0/6 result above. Two trailing blank lines in new files were then
removed; the focused retrieval tests, final fast gates and runtime comparison
were repeated for those whitespace-only bytes.

## Implemented Integration

- Default CLI, MCP and task-bearing bootstrap/hook paths use shared retrieval
  and current-state adapters. Execution/skip, sources, budget and keyword
  degradation remain visible; empty answers are allowed.
- Topic validation isolates invalid presentation metadata without discarding
  valid historical identities. Workspace routes use verified Git identity, not
  basename or broad parent-directory substring matching.
- Shared capture admission precedes reservations, receipts and payload writes;
  draining rechecks admission. Merely invoking MCP does not manufacture an
  explicit user request. Skipped outcomes propagate through workers and health.
- Item-level visibility preserves unrelated items in mixed events. State,
  learning and retrieval honor lifecycle decisions; explicit history remains
  available. Reads do not renew retention.
- Governance emits candidates only. No historical bulk decisions, preference
  promotion, ledger deletion or sensitive-body rewrite was performed.

## Authorized Production Recovery

A complete home/store backup and file manifest were retained outside the
repository before recovery. Private audit snapshots retain original event hashes
and exact targeted results.

Three stuck captures were recovered. Of five selected checkpoints, two were
recorded, two classified as skipped, and one sensitive item remains isolated.
A formerly false-consumed low-importance item was reconciled idempotently:
repeating reconciliation changed no bytes. The sensitive body and original
immutable events were preserved. No global maintenance run changed weights or
promoted habits during closeout.

Formal topic-alias migration and fallback bootstrap paths were corrected before
deployment. Program rollback, configuration backup and store backup are distinct;
switching the program back must not overwrite newer events.

## Remaining Health And Host Boundaries

| State | Finding and disposition |
| --- | --- |
| Checkpoint attention | One sensitive checkpoint remains isolated. Its body was not edited or requeued to bypass the secret gate; requires a human decision |
| Seven unbuilt notes | Each registered topic has exactly zero ledger events. These are empty registrations, not seven unconsumed projections. No dummy event or placeholder note was invented |
| Setup receipt drift | Codex, Claude, ZCode and dsh files differ from the old receipt. Inspected MCP/hook/plugin entries still point at the default runtime and selected home. Whole-file ownership guards refuse overwriting unrelated edits; Codex has a PowerShell invocation correction absent from the receipt |
| Fresh host sessions | Fresh CLI/MCP processes passed; new interactive sessions in every installed host were not exercised. Static bindings do not prove callback delivery |

Old MCP/dashboard processes were identified by exact runtime script paths before
termination to release the Windows directory lock. Owning applications and
unrelated Node/Electron processes were not terminated. The host subsequently
spawned a new MCP from the default runtime; a fresh protocol smoke confirmed
1.1.0. The dashboard was restored using the owning application's existing
Memkeel adapter without changing host files or guessing security environment
variables. Loopback health and product-status identity both verified 1.1.0.

## Unverified And Deferred

- Real embedding relevance, the proposed human 20-30-question set and production
  semantic quality were not measured. Synthetic-index tests are not evidence
  of real embedding quality.
- Cross-platform/Node 24 CI and real UI interaction are not claimed by the local
  Windows/Node 22 result. Dashboard assets were not changed.
- Historical governance remains report-only. No bulk application was authorized.
  Receipt rebasing must preserve unrelated host edits.
- Source/package scanners inspect text and report binary exclusions; they are
  not a guarantee that every binary contains no private information.

## Reproduction And Rollback

Run `node scripts/release-check.mjs` from the tag, then
`node scripts/sync-app.mjs --into <runtime-dir> --check`.
Repeat doctor, config validate and setup --check against the explicit home.
Inspect nonzero results; do not run automatic cleanup just to turn health green.

For program rollback, stop only verified Memkeel processes and restore the
retained runtime directory. Restore configuration separately after reviewing
newer edits. Restore the store into a new location, not over the live journal;
preserve all newer events.
