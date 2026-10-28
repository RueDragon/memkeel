# Upgrade Review: 1.1.0

Review date: 2026-10-27. Scope: the uncommitted upgrade on top of `bf99c46`, followed
by integration corrections requested by the maintainer. Local runtime and private
store details are intentionally excluded from this public report.

## Review Steps

| Step | Status | Scope |
| --- | --- | --- |
| Java / SQL / XML | Skipped | No changes in these languages |
| Browser frontend | Skipped | No browser UI changes |
| Configuration | Executed | Topic validation, migration, write boundaries |
| JavaScript service / security | Executed | Node ESM entry points, queues, privacy, scope |
| Performance / lifecycle | Executed | Budgets, cache invalidation, current-state visibility |
| Report and independent re-review | Executed | Focused protocol, nonempty retrieval, privacy and full regression gates; final evidence recorded separately |

## Risk Summary

The initial implementation was not deployable as the complete upgrade: the new
modules were disconnected from normal CLI, MCP and hook execution. Review also
identified item-level visibility and async-admission integration defects. These
were release blockers; focused tests and final local gates now pass.

| ID | Severity | Finding | Required Correction |
| --- | --- | --- | --- |
| U01 | High | State, retrieval and governance modules were standalone | Connect default entry points and exercise real CLI/MCP subprocesses |
| U02 | High | Async capture could persist bodies before collection/admission checks | Run the shared gate before any reservation, receipt or payload write; recheck at drain |
| U03 | High | Superseding one item could hide its entire mixed event | Filter by item identity; preserve unrelated facts, actions and contexts |
| U04 | High | Fact retrieval did not consistently respect soft-hidden event state | Filter each source consistently in sync/async adapters; retain explicit history access |
| U05 | Medium | Broad parent workspace routes captured independent Git projects | Prefer verified Git root/common-directory identity; keep legacy ID access explicit |
| U06 | Medium | A configured non-default embedding model was not propagated to indexed recall | Propagate the profile/model through the adapter, pipeline and cache key |
| U07 | Medium | Captures invoked through MCP were assumed to be explicit user memory requests | Protect actual state changes and explicit requests, not the mere tool invocation |
| U08 | Medium | Runtime sync pruned old rollback directories as a side effect | Add and exercise an explicit option preserving every previous rollback |

The correction pattern for U02 is `admitCapture(...)` before storage, not an
additional cleanup after storage. U03/U04 require row-level effective-state
projection, not deletion or rewriting of immutable events. U05 requires exact
repository identity, not a project-name substring or a parent-directory match.

Re-review on 2026-10-28 corrected additional integration defects before release:
capture retry's stale variable reference; workspace metadata missing from the base
retrieval corpus; collection source exclusions; explicit-request delivery through
MCP without promoting ordinary tool calls; governance blocker precedence; and
skipped-result propagation into workers, recovery and health diagnostics. Each
has focused regression coverage. Existing low-value hook fixtures were changed
to substantive or explicitly requested captures, without weakening assertions.

## Contributors

| Source | Scope |
| --- | --- |
| Maintainer worktree | Initial config validation, pure state/retrieval/governance modules and tests |
| Integration review | Runtime adapters, privacy gates, item-level visibility, recovery and release preparation |

No attempt is made to infer an individual author for uncommitted files.

## Trend

There is no comparable prior review dataset. The initial module-only test result
is not evidence of deployed host integration or real embedding quality.

## Change Record

Base: `bf99c46` (release 1.0.1). The final release commit and annotated tag are
the authoritative code identity; local configuration and private recovery audit
files are not part of that commit.

## Interface Authorization

No browser-facing application or database menu authorization was changed. New
read-only MCP/CLI actions must not accept write execution flags; capture and
checkpoint recovery remain explicit write paths with privacy and secret gates.

## Priorities

U01-U08 have focused coverage and passed final local gates. The default runtime
was replaced atomically with rollback preservation and all 135 packaged files
matched. Full release-check passed with 659 passing tests and no failures;
independent CLI/MCP/admission tests passed 18/18. Production doctor and setup
checks remain nonzero for the isolated sensitive checkpoint, empty registered
topics and receipt ownership drift described in the acceptance report. These
are not a claim of a fully healthy home or an interactive host-session pass.
Do not publish private recovery payloads or force old receipts over host edits.

## Closure

Final closure, exact current test counts, deployment smoke results and honest
unverified boundaries are recorded in `upgrade-acceptance-20261027.md`.
