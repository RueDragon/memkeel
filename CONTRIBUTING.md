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

Run all four before you push. CI runs the same commands.

```bash
npm test            # node --test test/*.test.mjs
npm run check        # node scripts/check-syntax.mjs  (node --check on every first-party file)
npm run leak-scan    # node scripts/leak-scan.mjs     (working tree; mandatory in CI)
npm run pack-scan    # node scripts/pack-scan.mjs     (real npm pack artifact)
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
names and layout fragments, personal project identifiers, private emails, private keys, access
tokens and non-public package registries.

```console
$ npm run leak-scan
leak-scan: clean (145 files scanned)
leak-scan: coverage: 10 non-text file(s) not inspected (.woff2 x10) - files that were not inspected are not covered by this result.
```

The coverage line is part of the contract: this gate only reads text, so it states what it did
not read. Do not suppress it, and do not present a clean run as proof that a release is free of
private data.

**The rule list is public.** Rules in `scripts/leak-scan.mjs` must stay generic, because naming a
specific employer, customer or private project in that file publishes the very name it is meant
to protect. A term that must never ship belongs in the external list instead:

```bash
# outside the repository, never committed, never printed
MEMKEEL_LEAK_TERMS_FILE=/path/to/private-terms.json npm run leak-scan
```

The file is a JSON array of literal strings. CI reads the same list from the optional
`MEMKEEL_LEAK_TERMS` repository secret. A missing, unreadable or malformed list fails the run
instead of scanning without it, so a misconfigured gate can never pass silently. Do not "fix" a
hit by deleting the rule or the term — fix the leak.

### `npm run pack-scan`

A clean working tree says nothing about the tarball, so this gate runs on the real artifact: it
calls `npm pack`, unpacks it in a temporary directory, checks that every shipped file is declared
in `package.json` `files`, and scans the unpacked text with the same rules. A file that ships
without being declared fails the gate.

When you add something that must ship, add its path to `files` in the same pull request. When you
add a build output, confirm the resulting file list is what you intended.

## Syncing a runtime directory

An agent host runs the package from a directory of its own, not from your checkout: the hooks and
the MCP server are pointed at a copy of the published artifact. Editing the checkout therefore does
nothing until that copy is rebuilt, and the drift is silent — the checkout is clean, the runtime
directory is complete, and the only symptom is a hook that behaves like last week's code.

`npm run sync-app` rebuilds that copy from the real tarball, verifies every file by reading it back,
and keeps the previous copy as a rollback directory beside the target:

```bash
npm run sync-app -- --into C:/Users/<you>/memkeel-app            # rebuild the runtime directory
npm run sync-app -- --into C:/Users/<you>/memkeel-app --check    # report drift; writes nothing
```

`--check` exits non-zero on drift and names the files that differ, the same way
`node scripts/build-vendor.mjs --check` reports an out-of-sync vendored module. It is the quick way
to answer "is the host running the code I just wrote?" before blaming the code.

The target is never the checkout itself, and a directory that is not already a memkeel copy is
refused unless you pass `--force`, so a mistyped path cannot overwrite something else. Syncing from
a tarball you already have, rather than from the working tree, is `--from path/to/memkeel-1.0.0.tgz`.

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
| Gates | `test/`, `scripts/check-syntax.mjs`, `scripts/leak-scan.mjs`, `scripts/pack-scan.mjs` |

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
