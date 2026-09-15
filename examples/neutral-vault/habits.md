---
type: preferences
scope: global
---
# Habits

Habits have exactly one data source: this note. Only confirmed, scope- and trigger-matching
preferences apply to a task. One-off requests stay session-only, and an inferred candidate never
becomes mandatory on its own.

## Manual habits

Rules written here by hand are preserved forever. Consolidation only ever replaces the marked
block below.

- [prefer-absolute-paths] Quote absolute paths in commands rather than relying on the current
  directory. scope: global. Evidence: the user asked for this directly.

## Confirmed through events

<!-- AUTO-MANAGED:START -->
```json
{
  "rules": [
    {
      "id": "prefer-absolute-paths",
      "status": "confirmed",
      "scope": "global",
      "text": "Quote absolute paths in commands rather than relying on the current directory.",
      "triggers": [],
      "user_quote": "Always use the full path, I do not want commands that depend on where I am."
    }
  ]
}
```
<!-- AUTO-MANAGED:END -->

## Not a habit

A preference observed in events is a *candidate* until it is explicitly confirmed with the
user's own quoted words (`habit-decide`). Frequency alone is not confirmation, and the strongest
status an automatic pass can assign is *probationary*, which is a hint and never a rule.
