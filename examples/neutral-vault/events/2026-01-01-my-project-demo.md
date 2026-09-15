---
type: memory-events
scope: demo
workspace: 'C:/Users/<you>/code/my-project'
date: 2026-01-01
---
# Agent increment log

Each event is appended exactly once; the creation date is not refreshed by an append.
This file is a sample. A real journal is written only by `record` / `capture`.

<!-- EVENT:20260101-demo-example-01 -->
```json
{
  "event_id": "20260101-demo-example-01",
  "workspace": "my-project",
  "topic": "my-project/service-profile",
  "agent": "demo",
  "occurred_at": "2026-01-01T10:15:00+08:00",
  "recorded_at": "2026-01-01T10:15:04+08:00",
  "evidence": [
    "topics/my-project--service-profile.md"
  ],
  "facts": [
    {
      "key": "profile-source",
      "text": "The service profile is read from a single JSON file, not from per-environment files."
    }
  ],
  "verification": [
    "Read the loader and confirmed it opens exactly one path built from the profile root."
  ],
  "actions": [
    {
      "id": "document-profile-override",
      "status": "open",
      "text": "Document how to override the profile root for a local run."
    }
  ]
}
```
<!-- END-EVENT -->
