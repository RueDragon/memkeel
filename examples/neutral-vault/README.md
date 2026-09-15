# Example store

**This is a sample. It is not a real memory store, and nothing here is loaded by the CLI.**

It exists so you can inspect the default **neutral layout** without creating a store first:
the role names, the folder shape, the event-journal format and the managed projection blocks.

- **The real store is created by `memkeel init`.** Do not copy these files into a working memory
  home and expect it to work; the journal here holds a single illustrative event, not a history.
- **No personal data belongs in this repository.** Every name here is deliberately generic
  (`my-project`, `demo`). Contributions to the example must stay that way — a real path, name,
  project identifier or token will fail `npm run leak-scan` and the build.
- Paths in these files are relative to the store root (`vaultRoot`), which is what the code
  resolves roles against. The store root itself is something like `C:/Users/<you>/agent-memory`.

## Layout

| Path | Role (`config.json` key) | What it is |
| --- | --- | --- |
| `events/` | `eventsRoot` | The immutable event journal. One file per day, workspace and agent. Never hand-edited. |
| `events/Evidence/` | — | Short evidence notes written by `capture`, one per day and workspace. |
| `topics/` | `topicsRoot` | Generated topic pages holding the current state for one topic. |
| `habits.md` | `habitsNote` | Confirmed habits, plus a managed block of event-confirmed rules. |
| `actions.md` | `actionsNote` | Generated open-action ledger. |
| `mistakes.md` | `mistakesNote` | Generated confirmed-mistake increment. |
| `candidates.md` | `candidatesNote` | Generated pending preference candidates. |
| `experience.md` | `experienceNote` | Generated experience and short-term-context catalog. |
| `digest/` | `inboxRoot` | Daily digests, and long-form notes under `digest/longform/`. |

`projects/` (`projectRoot`, holding `workspace-<id>.md` registry notes) is created by
`memkeel init` as well; it is omitted here because a registry note is machine-generated.

## What to look at

1. `events/2026-01-01-my-project-demo.md` — the exact journal block format, including the
   `<!-- EVENT:... -->` markers that `loadEvents` parses.
2. `topics/my-project--service-profile.md` — a generated topic page: the managed block holds the
   current well-supported conclusions, the open items and the evidence links, while anything you
   write outside the markers is preserved forever.
3. `habits.md` — the manual habits section and the managed block of event-confirmed rules.
4. `digest/2026-01-01 - Agent daily digest.md` and `digest/longform/` — the daily projection and
   the long-form pointer pattern from `event-schema.md`.

For the full event contract, read [`../../event-schema.md`](../../event-schema.md). For how the
roles resolve to paths, read [`../../config.example.json`](../../config.example.json) and the
"roles and layout model" section of [`../../README.md`](../../README.md).
