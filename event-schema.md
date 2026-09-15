# Agent Event Contract v1.0.0

## Experience And Task Context

Read-only actions: `experience_recall` and `context_recall` accept cwd/workspace, query and optional task/history; `check_operation` accepts operation {kind, command, shell, cwd, boundary}. No read increments usage or writes a cache. CLI equivalents: experience-recall, context-recall, check-operation --file INPUT.json.

Optional `experiences` entries: id, kind (prevention/path-finding/search-route/negative-search/workflow/verification/costly-exploration), scope (global or event workspace), triggers (nonempty string array), text, verification. Optional operations: shell/search/edit/build/vault-write/other. path-finding requires location; negative-search requires boundary and expires (YYYY-MM-DD). All paths and dated observations require revalidation before use. Evidence must establish the actual discovery, not a proposed example. An experience is advisory, not a user preference or execution permission.

Optional `contexts` entries: id, task, text, certainty (reported/verified), ttl_days (1-90; default 30), optional expires and status (active/closed/invalidated). Use task identity including branch/environment when needed. Reported summaries never become facts implicitly. Seven days hot, then warm until expiry, then dormant and history-only. Capture at meaningful checkpoints, not every tool call. Explicit open actions belong in actions and do not disappear with context expiry.

For both arrays, revise the same id with supersedes set to its previous event_id. Unlinked replacements remain conflicts; timestamps alone do not overwrite. No automatic promotion from read count. A later verified reusable finding can be a new experience linked to the short-term evidence. Existing events without these fields are unchanged.

## Confined Host Capture

Prefer the `agent_memory` MCP tool when available. Call `action: capture`, with `input` containing event_id, workspace, topic, agent and small facts/actions/verification arrays, plus a separate `evidence_text` string describing actual observations (plain Markdown, no raw logs, fences or HTML comments). Capture writes the evidence note bytes straight to the vault file and confirms them with an Obsidian read, attaches its source, records the event, consolidates and verifies. For a just-completed action, capture may omit occurred_at and evidence; the service assigns its current timestamp and source. Historical imports must supply their original occurred_at. Reuse the exact event_id, input and evidence_text on retries. Do not record success when the observation failed.

Use `agent_memory_read` for bootstrap/recall/status/help. `action: bootstrap` requires actual cwd and optional query; it is read-only. `recall` uses query/workspace/history. Do not also run CLI bootstrap after successful MCP bootstrap. Keep host write approvals; this contract does not grant permission by itself.


## Copy-Safe MCP Write Recipe

Use the write-capable agent_memory tool only after a verified decision, discovery, correction or reusable experience. The normal call is:

~~~json
{
  "action": "capture",
  "input": {
    "event_id": "20260909-zcode-service-profile-01",
    "workspace": "my-project",
    "topic": "my-project/service-profile",
    "agent": "zcode",
    "facts": [{"key": "verified-point", "text": "A short verified conclusion."}],
    "verification": ["State what was actually checked."]
  },
  "evidence_text": "A short description of the evidence checked."
}
~~~

Only if the topic does not exist, register it first with input.id, not input.topic or input.key:

~~~json
{
  "action": "register",
  "input": {
    "id": "my-project/service-profile",
    "workspace": "my-project",
    "title": "Service Profile",
    "alias": "service profile"
  }
}
~~~

If capture fails, report that it was not saved. Do not claim an Obsidian write unless the tool returns success.

## Long Content: Note Body Plus A Pointer Event (Plan A)

There is no event size ceiling: the former 2600-byte event limit (`lib/core.mjs`, `lib/lifecycle.mjs`) and the 1800-byte `evidence_text` limit were both removed on 2026-09-14, because they kept rejecting ordinary end-of-task summaries. Injection stays bounded on the read side instead (bootstrap `budgetBytes`, fact-recall caps, hook context), so a large event is truncated where it is rendered, never dropped at write time.

For genuinely long bodies (long summaries, analyses, investigation records) the recommended shape is still prose in a note plus a small pointer event, because that keeps each event atomic and keeps injection lean:

1. Put the prose in a long-form note at `digest/longform/<YYYY-MM-DD>-<workspace>-<topic-key>.md`, one `## <event_id>` block per record. That folder sits under inboxRoot and outside eventsRoot, so it is never scanned or parsed as a journal.
2. Never send content through the Obsidian CLI arguments: the CLI decodes the two-character sequences backslash-n and backslash-t and offers no way to escape a literal backslash before them (measured 2026-09-10 and re-confirmed 2026-09-14: a Windows path such as C:\temp\new\file.md lands as C:<TAB>emp<LF>ew\file.md). Write the bytes to the vault path directly, then confirm with `read` through the CLI and compare byte for byte, rolling back on any mismatch. CLI reads are byte-faithful, so they stay the verification channel.
3. Keep the event a pointer when the body is long: `evidence: ["<long-form path>#<event_id>"]` with the conclusion in `facts`. Do not duplicate a long body into the event merely because it now fits.
4. Use the same `event_id` for the note block and its pointer event.

Pointer-event example:

~~~json
{
  "action": "capture",
  "input": {
    "event_id": "20260914-dsh-example-longform-01",
    "workspace": "my-project",
    "topic": "my-project/service-profile",
    "agent": "dsh",
    "evidence": ["digest/longform/2026-09-14-my-project-agent-memory.md#20260914-dsh-example-longform-01"],
    "facts": [{"key": "longform-note-pointer", "text": "Long prose lives in the note body; the event only carries a pointer."}]
  },
  "evidence_text": "Short note: long-form body written and read back."
}
~~~

A large event is no longer a write error, but it is truncated when injected: put the conclusions in `facts` so the part that survives into context is the part that matters.

## Preference Decisions And Repair

Candidates in preferences require id, status=candidate, scope, text, optional triggers and expiry. Task scope requires triggers. To confirm or reject one, use `habit_decide` (or CLI `habit-decide --file INPUT.json`) with event_id, candidate_event, preference_id, status=confirmed|rejected, evidence and user_quote. The exact explicit user quote must exist in the evidence note. No automatic confirmation from frequency. Baseline/manual habit IDs cannot be silently overwritten by a candidate.

Use `maintenance` for consumption plus cache refresh. CLI `maintenance --rebuild` deliberately regenerates marked projections from intact events when a page is missing; it still rejects modified consumed events and preserves manual sections. Ordinary startup and recall never require cache writes.

Use the memory CLI, not direct journal writes. Events are immutable, evidence-backed and require a registered topic/workspace; there is no size ceiling since 2026-09-14. Generate an event_id once and retain it for retries. JSON is input data, not shell code.

```json
{
  "event_id": "20260907-codex-example-01",
  "workspace": "other-project",
  "topic": "other-project/channel-config",
  "agent": "codex",
  "occurred_at": "2026-09-07T16:00:00+08:00",
  "evidence": ["digest/existing-source.md"],
  "facts": [{"key": "specific-contract", "text": "A verified conclusion, not an inferred habit."}],
  "verification": ["Exactly what was verified and what was not."],
  "actions": [{"id": "verify-specific-case", "status": "open", "text": "One next action."}]
}
```

`recorded_at` defaults to the actual record time; retry reuses the stored value. Evidence is a vault-relative existing note with an optional heading. If evidence exists only in this session, first create/append an evidence note (bytes written directly to the vault path, confirmed by a CLI read); point the event to it. Never create circular evidence by pointing to the event itself.

To replace a fact, reuse its key and set `supersedes` to the event_id shown on the current topic page. Without this, a differing claim becomes a conflict and the current claim is preserved. To close an action, reuse its id with status `done`. Preserve occurrence date even for late imports.

Optional `preferences` accepts candidates only. Confirmed habits live in the validated JSON block of the habit note named by config.json and need explicit user evidence, scope, triggers, and optional expiry. Do not infer permission from prior actions.

Optional `mistakes` requires date, workspace, task, symptom, cause, correction, prevention, evidence. Only confirmed, corrected mistakes are eligible. They project to the Agent error increment page and daily digest; legacy error history remains unchanged.

For a new topic run `register --topic <stable-id> --workspace <existing-id> --title "<title>" --alias "<query alias>"` before recording. Registration cannot overwrite an existing topic. The source library is not automatically condensed or deleted.
