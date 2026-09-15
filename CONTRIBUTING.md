# Contributing to Memkeel

Thanks for helping. This document covers the local development loop, the gates your change has
to pass, and the two rules that matter most in this repository.

## The two rules

1. **No personal data in commits.** This repository is public. Never commit a real person's
   name, a real absolute path (`C:/Users/<you>` is fine, a real profile name is not), a private
   store name, a private project identifier, an email address, a token or a key. Use
   placeholders: `C:/Users/<you>/agent-memory`, `my-project`, `demo`. The leak gate enforces
   this; see below.
2. **Generated projections are never hand-edited.** Topic pages, daily digests, `actions.md`,
   `mistakes.md`, `candidates.md`, the experience catalog and the managed block inside
   `habits.md` are all *derived* from the immutable event journal. Editing them by hand is
   pointless — the next consolidation overwrites the managed block — and editing a journal
   event is an error, because events are immutable. **The event journal is the write path.**
   Record an event (or fix the projection code) instead.

## Development setup

Requirements: **Node.js >= 22.18** (Node 24 also works). There is nothing to install for the
core system — it has **zero runtime npm dependencies**.

```bash
git clone https://github.com/RueDragon/memkeel.git
cd memkeel
node memory.mjs help
npm test
```

The only installed dependencies in the repository are the web console's frontend packages,
which you need solely if you are changing the console.

```bash
npm --prefix dashboard/app install
```

## Running the gates

Run all three before you push. CI runs the same commands.

```bash
npm test            # node --test test/*.test.mjs
npm run check        # node scripts/check-syntax.mjs  (node --check on every first-party file)
npm run leak-scan    # node scripts/leak-scan.mjs     (mandatory in CI)
```

### `npm test`

The suite is plain `node:test` over the layout model, storage adapters, event validation and
rejection paths, ranking and BM25 search, retention, transcripts, dashboard write handshakes
and the dsh plugin bridge. Add a test with a bug fix; a behavior change without one is hard to
review in a system whose whole value is not silently changing what it remembers.

### `npm run check`

`node --check` over every first-party `.mjs` file. Vendored code (`vendor/`) and the committed
console bundle (`dashboard/static/`) are skipped because they are not ours to fix.

### `npm run leak-scan`

**This one is not optional.** It is the guard that keeps the repository safe to publish, and CI
fails the build on any hit. It scans the working tree for real user-profile paths, private store
names and layout fragments, personal project identifiers, private emails, private keys and
access tokens.

```console
$ npm run leak-scan
leak-scan: clean (117 files scanned)
```

If your change needs a new term that must never ship, add it to the `PATTERNS` list in
`scripts/leak-scan.mjs` in the same pull request, with the reason in a comment. Do not "fix" a
hit by deleting the scanner entry.

## Rebuilding the dashboard bundle

`dashboard/static/` is **committed on purpose** so the console runs with no build step after a
plain clone or `npm install`. That means a frontend change has two parts:

```bash
# 1. edit dashboard/app/src/**
# 2. rebuild the committed bundle
npm run dashboard:build
```

`npm run dashboard:build` runs `vite build` in `dashboard/app` and writes `dashboard/static/`.
Commit the regenerated `static/` output together with the source change — CI verifies that the
committed bundle is up to date, and a source-only pull request will fail that check.

Verbose frontend development uses the Vite dev server, which proxies `/api` to a locally running
console:

```bash
npm run dashboard     # terminal 1: the real server on 127.0.0.1
npm run dashboard:dev # terminal 2: Vite dev server with hot reload
```

The console server binds to loopback only. Keep it that way.

## Commit and pull request expectations

- **Small, single-purpose commits** with an imperative subject line ("Fix supersede chain for
  retired facts", not "fixes").
- **Explain the why.** The interesting part of a change here is usually the failure mode it
  prevents. Say what would have gone wrong without it.
- **Say what you verified.** State the commands you actually ran and their results. If you could
  not verify something, say so rather than implying it works.
- **Note behavior changes explicitly.** Anything that changes what an agent reads, what a hook
  injects, or what a projection contains is user-visible and belongs in the description.
- **Update the docs in the same change.** A new command belongs in `README.md`; a new event field
  belongs in `event-schema.md`; a new policy rule belongs in `bootstrap.md`. Remember that
  `bootstrap.md` and `event-schema.md` are published into the memory home by `setup`, so they are
  part of the product surface, not internal notes.
- **Never weaken a gate to make a build pass.** Do not loosen the leak scanner, skip a failing
  test, or delete an assertion to get green.
- **Do not commit generated state.** The memory home (`state/`, `backups/`, a real `config.json`)
  is user data and must stay out of the repository; `.gitignore` already excludes it.

## Where things live

| Area | Files |
| --- | --- |
| CLI entry point and commands | `memory.mjs`, `bin/memkeel.mjs` |
| Core memory logic | `lib/core.mjs`, `lib/lifecycle.mjs`, `lib/experience.mjs`, `lib/preferences.mjs` |
| Roles and layout model | `lib/layout.mjs` |
| Storage backends | `lib/storage/adapter.mjs`, `lib/storage/filesystem.mjs`, `lib/transport.mjs` |
| Search and ranking | `lib/search/bm25.mjs`, `lib/search/tiered-read.mjs`, `lib/search/index-bridge.mjs` |
| Host binding | `setup.mjs`, `integrate-mcp.mjs`, `integrate-hooks.mjs`, `publish.mjs` |
| Hooks | `hook-runner.mjs`, `lib/hooks.mjs`, `lib/checkpoints.mjs`, `dsh-memory-plugin.mjs` |
| MCP server | `mcp-server.mjs` |
| Web console | `dashboard.mjs`, `lib/dashboard-*.mjs`, `dashboard/app/`, `dashboard/static/` |
| Gates | `test/`, `scripts/check-syntax.mjs`, `scripts/leak-scan.mjs` |

## Design constraints to preserve

These are load-bearing properties, not stylistic preferences. A change that breaks one of them
needs a very good reason.

- **Markdown is the source of truth.** No database, no service, no hidden state that the store
  cannot be rebuilt from.
- **Events are immutable and evidence-backed.** Every event cites an existing note; changing a
  fact requires an explicit `supersedes`.
- **Projections are derived.** They can be deleted and rebuilt from the journal.
- **Reads do not mutate memory.** The only thing a read may write is the derived, rebuildable
  access log.
- **No shell, no arbitrary file writes** through the memory tools.
- **Writes go to disk as bytes and are verified by reading back.** Note content never travels
  through a CLI argument list — the CLI decodes `\n` and `\t` and cannot escape a literal
  backslash.
- **Zero runtime npm dependencies** for the core. Vendored code stays minimal and attributed in
  `THIRD_PARTY.md`.
- **Fail closed on corruption.** A half-parsed journal, a mutated consumed event or a stale review
  token is an error, never a silent partial success.

## License

By contributing you agree that your contributions are licensed under the MIT License, matching
this project.
