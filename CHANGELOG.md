# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A collection policy that actually stops collection.** `collection` in `config.json` decides, once,
  whether a conversation may be collected, and the answer is consulted by every layer that writes
  conversation text: the hook queue, checkpoint draining (queue → evidence), the access log, and
  historical ingest. This is the difference the plan asks for — the switch is not a rendering
  setting. The test does not assert that a flag is false: it runs a turn with collection off, walks
  every file under the memory home and the store, and asserts the text is nowhere — then repeats the
  run with collection on to prove the search would have found it. That test found two real leaks
  while it was being written (the prompt was also persisted in `state.factRecall`, and in the session
  file's `prompt`), both of which are now gated too.
- **Four scopes, ordered so the answer can only get more private.** `enabled: false` is a hard stop
  that no narrower scope can override; then an exclusion rule that matches; then
  `workspaces[<id>] === false`; then `hosts[<host>] === false`. `true` values are accepted but never
  override a broader denial — a global off switch that a stale per-host entry could re-enable would
  be a trap rather than a feature.
- **Exclusion rules with stated semantics and a preview.** `exclude.paths` matches a directory itself
  and everything inside it (not a name that merely shares a prefix), while `exclude.sessionTypes` and
  `exclude.sources` match the whole value. `memkeel privacy exclusions --preview FILE` evaluates the
  rules against real sample values and names the rules nothing matched, so the semantics can be
  inspected before they are relied on.
- **`memkeel privacy show|exclusions|cleanup`.** Read-only. `show` prints the effective policy and
  *which scope decided it* — an off switch with no explanation is indistinguishable from a bug.
  `cleanup` previews what a retention cleanup would touch and lists what it would not (the ledger, the
  backups, the host's own transcripts). Nothing is deleted.
- **`memkeel privacy export --out FILE`, a redacted diagnostic export.** One file, safe to hand to
  someone else: versions and platform, counts of events / facts / contexts / actions / evidence
  citations and of the checkpoint queue by status, the configuration with credentials dropped and
  every path reduced, and the effective collection policy. What it withholds is stated *in the
  payload* so a reader can tell an omission from an accident: no session text, no note bodies or
  evidence, no full paths, no `dashboardTokenSecret` or Obsidian CLI path. The memory home and the
  store become fixed placeholders rather than basenames, because a basename can still identify a
  project.
- **The export audits itself before it is written, and refuses to write if the check fails.** The
  audit collects the payload's real string values instead of searching its serialized text: on Windows
  `JSON.stringify` doubles every backslash, so a plain `text.includes(home)` compares the single- and
  double-escaped spellings of the same path and never matches — an audit blind to the platform it runs
  on is worse than no audit, because it reports `clean`. The test asserts a planted leak is caught and
  that the audit does not echo the value it found. Writing also refuses to overwrite an existing file,
  since the export is cheap to regenerate and may already have been sent to someone.
- **The settings page shows the effective collection policy.** The dashboard's read model now carries
  the same `privacyView` payload the CLI prints, so the two cannot disagree, and Settings renders it
  read-only: the decision, the scope lists, the exclusion rules and the three-state vocabulary — with
  the unsupported state marked as unsupported. It is deliberately not an editor: turning collection off
  affects hooks, ingest and the access log, so the page reports what is in force instead of offering a
  control that only looks like a switch. The payload also states the context its verdict was computed
  for, so a context-free answer cannot be mistaken for a statement about the current session: a
  workspace-level opt-out legitimately does not apply when no workspace was named, and the page says so
  rather than implying otherwise.
- **Turning collection off covers what is already queued.** A checkpoint written before the switch
  was turned off does not become evidence afterwards: the drain marks it `held` and defers it rather
  than promoting it or discarding it, so turning collection back on drains it normally. `held` is a
  recognised status in the health check — reported with its reason, but not counted as a fault, since
  a permanently red `doctor` for an intentional setting is just noise.
- **Three states that are kept apart in the payload, not only in prose.** `not-collected`,
  `retained-not-retrieved` and `physically-deleted`, the last marked `supported: false`. Physical
  deletion is deliberately not offered: the ledger is append-only and event-verified, deleting in
  place would break its own integrity, and it cannot recall backups or external copies that already
  exist. The honest deliverable is an accurate statement of scope.
- **`memkeel migrate --to DIR`.** Moves a live memory home and store to a new location: a read-only
  plan by default, or a copy plus a repointed `config.json` with `--execute`. It reuses the archive's
  classification of what has to be carried, so "what must be copied" has one answer rather than two
  that can drift apart. The source is never modified or deleted, and the command prints the remaining
  steps — repoint `MEMKEEL_HOME`, re-run `setup`, remove the old home yourself — instead of inferring
  them from a successful run.
- **`config.json` is excluded from the copy loop and written last.** Not copied and then rewritten:
  an interrupted migration therefore leaves a destination with *no* configuration, which cannot be
  mistaken for a working home. Had the configuration been copied first, a failure partway through
  would leave a destination that looks like a home and reads the source store — a migration that
  reports nothing and changes nothing. The invariant is covered by a test that injects a failure
  mid-copy and asserts the destination has no configuration.
- **A migration refuses destinations it cannot do correctly.** A destination overlapping the source in
  either direction, a destination inside the memkeel checkout, or a destination that already holds
  data. Overlap is decided between canonical paths: symlinks are resolved through the nearest existing
  ancestor, so a destination that does not exist yet is still compared in the same spelling as its
  source. Resolving only where the path exists is not enough and fails quietly — on macOS
  `os.tmpdir()` sits behind `/var -> /private/var`, so a destination under the temporary directory was
  spelled differently from its source and a copy into itself was allowed. Recorded evidence keeps the
  paths it was written with, and workspace aliases travel verbatim.
- **`memkeel backup create` / `backup verify` / `restore`.** An archive of the journal, the memory
  home's configuration, the shared policy source and the state that cannot be recomputed — the
  installation receipt, retention decisions, pending captures and the checkpoint queue. The search
  index and topic catalog are deliberately not carried and the manifest lists them as `notCarried`,
  so what a restore will not bring back is stated rather than discovered. The snapshot is taken while
  holding the writer lock, so no capture or consolidation can land inside the copy.
  `backup verify` recomputes every checksum and reports corruption, missing files and unlisted files
  separately, because "which parts are still good" is the question worth answering. `restore` plans
  by default and writes only with `--execute`: it checks the manifest for absolute paths and `..`
  traversal, for entries outside the `home/`+`store/` layout, for an unsupported format, for a
  destination that already holds data, and for free space, then verifies the archive's checksums
  before copying a single byte. A restore into a new directory repoints the restored `config.json` at
  that directory — without it the restored home would still name the store it came from, which looks
  like a successful restore and behaves like a broken one.
- **The backup destination must live outside what is being backed up.** A destination inside the
  memory home or the store would be read into its own next run, and a restore could overwrite the
  only copy of the archive.
- **Backups are documented as sensitive, with the encryption decision recorded.** No encryption is
  built in: a key this program generated and stored beside the archive protects nothing, and a key
  the user must keep would make a restore impossible at the moment it is needed most. Full-disk
  encryption and directory permissions are the expectation, and an encrypted archive is the user's
  own tool's job. The archive directory is created `0700`.
- **All four hosts are covered by an isolated binding round-trip.** The host matrix had no coverage
  for Claude Code or dsh at all. A test now drives Codex, Claude Code, ZCode and dsh through the same
  cycle inside a throwaway tree — with every host directory, the user profile and the memory home
  redirected — asserting that a dry run writes nothing, that installing binds, that repeating changes
  no host file, that an edit the install did not make is refused (and that `--force` does not discard
  it), and that uninstall restores the original bytes and empties the receipt. It also covers dsh's
  three profiles (and that an absent profile is deliberately not created) and Claude's split layout,
  where hooks and the policy follow `CLAUDE_CONFIG_DIR` while the MCP server lives in `~/.claude.json`.
- **The generated launcher is executed, from a path built to break quoting.** The binding embeds the
  memory home in a command string for Codex and Claude, so a home containing spaces, quotes and `&`
  would break every hook at runtime. A test binds exactly such a home, takes the `command` the host
  would run, runs it through a real shell with a hook payload on standard input, and asserts it
  returns a well-formed hook result.
- **One shared config contract (`lib/config.mjs`).** The CLI, the MCP server, the hook runner and
  the web console each used to repeat the same read-and-normalise line, so a default or a
  validation rule could drift between them. They now share one loader, one home precedence
  (`--home`, then `MEMKEEL_HOME`, then `~/.memkeel` — the console previously ignored `--home`
  entirely, so `memkeel dashboard --home X` served a different store than the command that started
  it) and one validator: the same `inspectConfigGroups` the settings page already used.
- **`memkeel config validate` / `config show --effective` / `config migrate`.** The first three
  forms are read-only. `validate` prints every field problem at once plus notes for unknown and
  deprecated keys, and exits non-zero when invalid. `show` prints the normalised values the
  program will actually use with the source of each, masking paths unless `--reveal-paths` is
  given. `migrate` prints the upgrade plan for a document written by an older shape, and
  `migrate --apply` writes it: an empty plan is a no-op, the migrated document is validated before
  it is written, the original bytes are copied to `backups/config-migrations/`, the result is read
  back, and any mismatch rolls the file back. Re-running `--apply` is idempotent, and
  `--dry-run --apply` together is refused as contradictory. `validate`, `show` and `migrate`
  build no transport, so an invalid config cannot create a directory or touch a host binding.
- **A document schema separate from the release version.** `configSchema` records the shape of the
  file; `version` records which release wrote it and is never rewritten by a migration.
- **A versioned, self-describing installation receipt.** `state/setup-receipt.json` now records its
  own `format`, the `memoryHome` and `scope` it belongs to, and when it was last written, so the
  restore chain survives an upgrade of the program. A receipt written by an older build stays
  readable and is upgraded on the next write; `setup` reports the receipt state in its summary.
  An unreadable receipt is refused with one actionable line instead of being overwritten.
- **`setup` names the operation it is performing.** Every run reports one of `first-install`,
  `no-change`, `upgrade`, `rebind`, `refresh` or `uninstall`, with a sentence saying why, instead of
  leaving the user to infer it from a changed-file count. More than one can hold at once — upgrading
  the program *and* repointing it at a different home is a realistic move — so the remaining
  matches are carried in `also` rather than dropped by the priority order.
- **`memkeel doctor` reports the effective home, the restore record, binding drift and the
  launcher.** It prints which of `--home` / `MEMKEEL_HOME` / the default chose the home, the
  receipt's format, release, age and file count, whether the recorded bindings still point at that
  home, and whether the launcher and the three scripts a binding invokes still exist. An unreadable
  receipt or a missing launcher marks the store unhealthy, because that is what makes a later
  `setup --uninstall` fail closed or every host fail to start. A legacy receipt that recorded no
  home reports `unknown` drift rather than claiming agreement, and real drift is reported without
  failing the store, because the store itself is fine — the host bindings are stale.
- **The published package is tested, not only packed.** `npm pack` had never been more than a
  dry-run, so nobody had checked that what a user installs can actually run. A test now unpacks the
  real tarball into an empty directory and exercises `init`, `config validate`, `doctor`, `bootstrap`
  and a live console request from that copy, so the artifact is verified self-sufficient on every
  platform CI runs. It also asserts that development-only material (`dashboard/app`, `test`,
  `node_modules`) is not published.
- **The container image ships exactly what the published package ships.** It copied `dashboard/`
  wholesale, which pulled in the Vite app source and its lockfile that the runtime never reads; it
  copies `dashboard/static/` only, and `.dockerignore` now excludes `dashboard/app` from the build
  context. A test pins this by parsing the Dockerfile's `COPY` instructions, asserting every source
  exists and that the whole `dashboard/` tree is not copied.
- **The Docker section states what the image is, and what has not been verified.** It is a CLI and
  storage tool rather than a service, which is why no compose file ships — the default command is a
  health check, so `docker compose up` would report a healthy container as restarting forever. The
  section also gives the Windows PowerShell form of the volume arguments (`${PWD}`, quoted), and
  says plainly that the file set and the command contract are tested while an actual image build and
  container run are not, because this environment has no container runtime.
- **`npm run pack-scan`: a packaged-artifact gate.** A clean working tree says nothing about
  what `npm pack` ships, so this gate packs, unpacks the real tarball in a temporary directory,
  checks that every shipped file is declared in `package.json` `files`, and scans the unpacked
  text with the same rules as the source gate. An undeclared shipped file fails the run.
- **The private term list can arrive from CI.** A new `privacy` CI job and the tag-release
  workflow read the optional `MEMKEEL_LEAK_TERMS` repository secret, stage it outside the
  checkout and pass it through `MEMKEEL_LEAK_TERMS_FILE`. The value is never printed.
- **The coverage of every leak run is stated.** `leak-scan` now reports how many non-text files
  and binary files it skipped and how many symlinks it did not follow, so a clean result is never
  mistaken for a guarantee about files the scanner cannot read.
- **`leak-scan --root DIR` and `--json`.** The same rule set can scan an arbitrary tree, which is
  what makes the packaged-artifact gate possible, and emit machine-readable hits containing the
  file, line and rule id but never the matched value.
- **Rules for macOS and Linux profile paths**, non-public `.npmrc` registries and inline
  `_authToken` values, and AWS, GitLab, Slack and Google key shapes. Documented placeholders such
  as a home directory template stay exempt.
- **The release workflow now runs the gates ordinary CI runs**, including the packaged-artifact
  gate and the committed-console-bundle freshness check, so a tag cannot bypass them.

### Changed

- **Restore stays whole-file, and that is a decision rather than an omission.** Restoring only the
  fields we recognise would need a real parser per host format — TOML for Codex, JSON for Claude and
  ZCode, YAML for dsh — and this program ships with zero runtime dependencies by design. The
  alternative, cutting a field back out of the document with a regular expression, cannot tell a key
  from a string that looks like one, and a restore that guesses boundaries would corrupt the file it
  is meant to repair. So the conservative rule stands: keep the exact bytes from before the install,
  restore them only while the file is still in a state this install produced, and otherwise refuse
  for a human to resolve.
- **Config validation now agrees with the runtime on legacy keys.** A config that still uses the
  old flat role keys (`habitsNote`, `projectRoot`, …) works at runtime, because the layout rules
  read them. `config validate` therefore folds them the same way and reports a note instead of
  rejecting a file the program runs happily. The settings editor stays stricter on purpose: it
  writes the modern `roles` block, so it will not save an incomplete one.
- **A store root that two fields disagree about is an error, not a guess.** `memoryRoot` is the
  store and `vaultRoot` is what note paths resolve against; when both are present and differ, the
  document is rejected with an explanation rather than one value silently winning.
- **`leak-scan` reports and fails cleanly.** A missing or malformed private term list exits 2 with
  one actionable line instead of a raw stack trace. Diagnostics still print only the file, line
  and rule id; matched values are never echoed, because a CI log on a public repository is public.

### Fixed

- **Rewriting a host configuration no longer changes who can read it.** The atomic replace wrote a
  temporary file and renamed it over the target, and rename keeps the *source* file's mode, so a
  config that was `0600` came back with the process default. Host configuration can carry
  credentials, so a widened mode would expose exactly what the installation receipt and its backups
  exist to protect. The mode is now read from the target and applied to the replacement, and the
  same rule covers the pre-install backups, which hold the original bytes.
- **Two concurrent `setup` runs no longer lose each other's receipt entries.** Each run wrote its
  whole in-memory copy, so the loser's entries — and the pre-install bytes they hold, which are the
  only way to restore those files — were dropped. The receipt is now re-read inside a lock and
  merged, so the update is additive.
- **An interrupted `setup` no longer bricks a host binding.** The receipt used to be written
  *before* the file it describes, so a crash in between left a receipt claiming an installed state
  the filesystem did not have. Because the write guard only accepted the "installed" state, every
  later `setup` then refused that file with "Configuration changed since setup" until someone
  edited the receipt by hand. The receipt is now recorded after the file, and the guard accepts
  both states this install owns — the pre-install bytes and the installed bytes — refusing only an
  unknown state. That is the same rule the uninstall preflight already applied, so the two paths
  now agree; a later user edit is still refused.
- **Both READMEs described `version` as the config schema version, and documented a
  `hook.codexDeferredAdvisoryModels` key the code does not read.** `version` records the release
  that wrote the file; the document shape is `configSchema`. The real key is
  `hook.codexDeferAdvisory`, and model lists are ignored deliberately, so the text now says that.
- **`CONTRIBUTING.md` no longer tells contributors to add private terms to the public rule list.**
  That instruction would have published the very identifiers the gate exists to keep out. It now
  points at the external term list and states that the in-repository rules must stay generic.
- **`CONTRIBUTING.md` and both READMEs described the gate inaccurately.** They now describe the
  three separate scopes (source, package, history) and the bounded coverage of each.

## [1.0.0] - 2026-09-15

The first public release. Memkeel is a local-first agent-memory ledger: four coding agents
share one plain-Markdown store in which every memory is an immutable, evidence-backed event,
and every projection is rebuilt from the event journal.

### Added

- **Event ledger with a supersede chain.** Every memory is an append-only event stored as JSON
  inside a Markdown note. Events are immutable, must cite at least one existing note as
  evidence, and carry `occurred_at` and `recorded_at` separately so late imports keep their real
  date. Changing a fact requires an explicit `supersedes` link to the event it replaces; a
  differing claim without one is preserved as a visible **conflict** instead of overwriting,
  and resolving a conflict clears it by taking a side explicitly. Reusing an `event_id` with
  identical content is an idempotent retry, which makes interrupted writes safe to repeat.
- **Four-host binding through `memkeel setup`.** One command registers the MCP stdio server,
  installs the native hooks, and publishes the shared policy block for **Codex, Claude Code,
  ZCode and dsh**. Hosts that are not installed are detected and skipped with an explicit
  report. `--dry-run` prints intended changes, `--check` reports drift without writing and
  exits non-zero on drift, `--no-hooks` skips hook installation, and `--uninstall` removes the
  bindings and restores backups. Every write is backed up, verified by readback, and idempotent.
- **`memkeel init`.** Creates an empty, ready-to-use memory store — directory layout, config and
  empty projections — without touching any agent, so setup and content creation stay separate
  steps.
- **Config, roles and layout model with a filesystem-first storage adapter.** Code depends on
  logical roles (`eventsRoot`, `topicsRoot`, `habitsNote`, …) rather than physical paths, so the
  same build serves a neutral folder, a house-style vault or an Obsidian tree. The default
  **`filesystem`** backend needs no Obsidian at all; **`obsidian-cli`** is an optional backend
  that keeps the filesystem as the write channel and uses the CLI to confirm the vault view.
  Generated content lives in marked managed blocks, so consolidation never touches hand-written
  prose, and legacy flat configs keep working without a migration.
- **BM25 search with tiered reads.** Lexical retrieval using BM25 (term-frequency saturation and
  inverse document frequency) replaces naive substring counting while keeping the same
  eligibility rules, with a title-hit boost and boosts for canonical topic pages and catalogued
  sources. Results can be rendered at three tiers — one line per hit, headings only, or the
  bounded full body — so a caller stops at the cheapest tier that answers the question.
- **History ingest and backfill.** `ingest-plan` reports historical agent turns that could be
  recovered, read-only; `ingest-apply` writes them back as reported task contexts, optionally
  auto-registering the workspaces it finds. Late imports keep their original occurrence date.
- **Memory weight and access log.** The one thing a read may write is a derived, rebuildable
  access log recording which facts and learnings were surfaced. A settlement pass turns repeated
  use into weight and idleness into decay. Weight affects **retrieval ranking only**: it never
  changes what a fact says, never confirms a habit, and never grants permission. Access log
  entries are bounded and compacted.
- **Web console with session replay.** A read-mostly local console on loopback
  (`http://127.0.0.1:3247`) over the same projections the CLI and MCP use, including a session
  replay view that renders each session as a chronological chat transcript — the archived
  checkpoint summary and the host's real transcript — with Markdown rendering and the raw event
  detail behind every bubble. Writable actions use a two-step preview/execute handshake with a
  token bound to the current state fingerprint, so a stale review fails closed. Writes are
  appends carrying `supersedes`; the console never edits Markdown. The production bundle is
  committed under `dashboard/static/`, so the console runs with no build step.
- **Retention ledger.** A soft drop for automatic conversation checkpoints that recorded nothing
  durable. The judgment is kept beside the journal and applied where events are rendered or
  recalled, so the event stays auditable and immutable and a later pass can flip the decision.
  A substance guardrail makes any event carrying a conclusion, action, mistake, preference,
  habit decision or verification ineligible, however conversational its title looks.
- **Native hooks for all four hosts.** Startup, prompt, tool and closeout hooks inject the
  bootstrap summary and relevant facts, run a bounded execution-experience check before tool use
  (able to deny a definite violation), prompt for a captured experience after failures or
  repeated searches, and queue bounded redacted checkpoints at session end for durable capture.
  Hooks never grant permission, reads never reinforce, no-record instructions are honoured, and
  failed checkpoints keep their payload and last error for retry.
- **MCP server with two purpose-limited tools.** `agent_memory_read` is read-only by
  construction; `agent_memory` writes only through the event path. Neither exposes a shell or
  arbitrary file writes, and neither relaxes the host sandbox. Path handling rejects escapes
  from the store root, including through symlinks.
- **Leak gate.** `npm run leak-scan` fails the build on real user-profile paths, private store
  names and layout fragments, personal project identifiers, private emails, private keys and
  access tokens. It runs in CI, and keeping the repository free of personal data is a
  contribution rule rather than a convention.
- **Documentation set:** `README.md` for first-time users, `SECURITY.md` with the threat model,
  `CONTRIBUTING.md`, `THIRD_PARTY.md`, this changelog, and an inspectable example store under
  `examples/neutral-vault/`.
- **Packaging:** a `filesystem`-only `Dockerfile` with no Obsidian dependency and no GUI,
  a `.dockerignore`, and CI/release workflows covering the test, syntax and leak gates plus a
  dashboard-bundle freshness check.

### Security

- Note content is written as bytes straight to the store path and verified by reading it back;
  it never travels through a CLI argument list, because the Obsidian CLI decodes `\n` and `\t`
  and cannot escape a literal backslash.
- Appends are exact-or-rollback, exact replacements are guarded by an expected value with
  timestamped backups and before/after hashes, and an orphaned writer lock is reclaimed only
  when the recorded holder is provably gone.
- Recognizable credentials are rejected at write time and redaction is applied to hook output,
  bootstrap, recall and checkpoint writes. Redaction is pattern-based and best effort — secrets
  must never be written to memory in the first place.
- The web console binds to loopback only and has no authentication by design.

[Unreleased]: https://github.com/RueDragon/memkeel/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/RueDragon/memkeel/releases/tag/v1.0.0
