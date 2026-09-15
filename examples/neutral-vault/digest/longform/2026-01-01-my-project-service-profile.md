# Long-form note example

This folder sits under `inboxRoot` (`digest/`) and **outside** `eventsRoot`, so it is never
scanned or parsed as an event journal.

For a genuinely long body — a long summary, an analysis, an investigation record — the
recommended shape is prose in a note like this one plus a small **pointer event** whose
`evidence` entry names the path and heading:

```json
{
  "event_id": "20260101-demo-example-04",
  "evidence": ["digest/longform/2026-01-01-my-project-service-profile.md#20260101-demo-example-04"],
  "facts": [{ "key": "longform-note-pointer", "text": "Long prose lives in the note body; the event only carries a pointer." }]
}
```

Use the same `event_id` for the heading below and for its pointer event, so the two can always be
matched. Keeping the event a pointer keeps each event atomic and keeps injection lean.

There is no event size ceiling, so a large event is not an error — but it is truncated where it
is injected. Keep conclusions in `facts` so that the part which survives into context is the part
that matters.

Sample content for inspection only.

## 20260101-demo-example-04

A long-form body would go here: the full analysis, the alternatives that were considered, the
commands that were run and what they returned. The event that points at this section carries only
the conclusion and this path, not the prose.
