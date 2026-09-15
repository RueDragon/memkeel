---
type: prevention-events
scope: global
---
# Confirmed mistakes

Generated from the event journal. Only **confirmed, corrected** mistakes are eligible — a failed
tool is an observation, not a mistake. Each entry must carry date, workspace, task, symptom,
cause, correction, prevention and evidence.

Sample content for inspection only.

<!-- AUTO-MANAGED:START -->
## 20260101-demo-example-02
- date: 2026-01-01
- workspace: my-project
- task: Add a new config key
- symptom: The key was ignored at runtime although the file looked correct.
- cause: The key was added to a copy of the config that nothing reads.
- correction: Moved the key to the file the loader actually opens.
- prevention: Confirm the load path before editing a config file.
- evidence: topics/my-project--service-profile.md
<!-- AUTO-MANAGED:END -->
