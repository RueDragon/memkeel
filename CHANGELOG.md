# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The collection policy panel renders library prose in the reader's language.** `privacy.mjs` emitted
  the deletion vocabulary, the reason behind a collection decision and the `permanentDeletion`
  explanation as Chinese sentences, so the settings page showed Chinese in English and the CLI showed
  Chinese next to English error lines. Those fields now travel as message references, and the settings
  page renders them through the same catalogue the CLI uses, so one reference cannot be worded two
  ways. The diagnostics export renders the bundle before it is audited and written, because that
  artifact is read by a person and a reference must never reach the file. With this, `lib/privacy.mjs`
  and `lib/cleanup.mjs` hold no Chinese outside comments, and `memkeel privacy show|cleanup|exclusions`
  print none in English. The dashboard imports `lib/messages.mjs` across its app root on purpose: the
  bundle carries its own copy, so nothing is fetched at runtime.
- **The privacy previews emit message references too.** `privacy.mjs`'s `cleanupPreview` and
  `previewExclusions` built their scope rows, their notCovered lists and their notes out of Chinese
  sentences, so `memkeel privacy cleanup` and `memkeel privacy exclusions` printed English error
  lines around a Chinese payload. Both now emit references and the CLI renders them, which leaves
  exactly one Chinese line in that output: the collection decision's `reason`. That field is not
  convertible yet because the dashboard renders it too, and the dashboard cannot render a reference
  until it does so itself.
- **Library code no longer picks a language: it emits message references.** `lib/cleanup.mjs` used to
  build its retention plan out of Chinese sentences, so `memkeel privacy cleanup` printed English
  error lines next to a Chinese plan and there was no way to render that plan in another language at
  all. The plan now carries `{ key, params }` references and whoever prints it renders them:
  `lib/messages.mjs` gains `msg()`, `isMessageReference()` and `renderMessages()`, and the CLI renders
  the payload before printing it, so its JSON output stays prose while the plan itself stays
  language-neutral. This is also the mechanism the dashboard and the diagnostics export will need,
  because both display prose that originates in `lib/` while the language is chosen on the client.
  Converted here: the retention plan, its group descriptions, its per-target reasons, its refusals
  and its `notCovered` list. Not converted: `privacy.mjs`'s preview wrapper, the deletion vocabulary,
  `permanentDeletion`, the collection decision's reason and the config validation messages - those
  still print in Chinese.
- **The CLI's user-facing text now comes from a catalogue, and one locale governs all of it.** Until
  now the same program printed English in its `Usage:` and error lines while the `note`, `readError`
  and `maskNote` prose inside its JSON output was Chinese, so a single run could mix both languages.
  Every string printed for a person now lives in `lib/messages.mjs` with `en` and `zh-Hans` tables,
  and the language is resolved from `MEMKEEL_LOCALE`, then `LC_ALL`/`LC_MESSAGES`/`LANG`, then
  English. It is a second catalogue rather than a share of the dashboard's because the published
  package ships `lib/` and the built `dashboard/static/` but not `dashboard/app/`, so an installed
  CLI has no dashboard catalogue on disk to read. `test/cli-messages.test.mjs` applies the same
  discipline the dashboard guardrails do - equal key sets, no blank strings, every referenced key
  present - plus the check that would have caught the original bug: the entry point must print no
  Chinese of its own, and the same broken invocation must come back in the language the environment
  asked for. Text produced by `lib/` itself (config validation messages, cleanup group labels,
  digests) is not catalogued yet.
- **Fixed: `localDay` rebuilt an `Intl.DateTimeFormat` on every call, and consolidating a ledger was
  spending much of its time constructing formatters.** Measured at 8000 events, 8000 `localDay` calls cost
  440 ms through a per-call formatter against 11 ms through one shared formatter, and a single
  `consolidate` made roughly 25,000 such calls, because the projection derives each event's occurrence and
  recording day as well as the digest loop. The formatter is now module-level. Consolidating 8000 events
  went from 1936.1 ms to 319.3-511.7 ms with one event pending, and from 19520.0 ms to 736.3-875.7 ms with
  every event pending, measured on one machine with one harness; the harness is committed as
  `scripts/perf-consolidate.mjs` so the numbers can be re-measured rather than taken on trust, and the
  ranges are given because repeated runs of unchanged code differed by up to 1.6x.
- **The daily-digest loop no longer re-derives every event's day once per pending day.** It was
  O(visible x days) and is now a single bucketing pass, O(visible + days), which changes what the loop
  costs as a store accumulates days rather than what it costs at the scale measured here — applying that
  change alone moves the two rows above by less than their run-to-run spread, and `PERFORMANCE.md` says so
  instead of claiming it as a second speed-up. The digests produced are unchanged, including the day
  boundaries, and a test asserts that two pending events on different Shanghai days land in their own
  digest and never share text.
- **`scripts/release-check.mjs` and `RELEASE.md`: a release is verified from the artifact.** The check
  runs the gates, packs the tarball into a temporary directory (the repository is never written to),
  asserts the required documents are inside it and the forbidden ones are not, checks the version against
  the changelog, refuses a shipped module that imports a `.ts` file at runtime, installs the tarball into
  an empty prefix and runs the installed CLI, and prints the SHA-256. `RELEASE.md` records the versioning
  policy, the platform matrix CI actually exercises, the breaking changes to state in release notes, and
  the upgrade and rollback procedure. It publishes nothing and never touches an existing installation —
  both are the maintainer's decisions, not a script's.
- **Fixed: the published package could not run when installed.** `lib/core.mjs` imported
  `vendor/obsidian-mind/session-start.ts` at runtime, and Node refuses to strip TypeScript types under
  `node_modules`, so every command failed from an installed package while a clone worked. The `.mjs`
  files are now generated from the pinned `.ts` sources by `scripts/build-vendor.mjs` — using Node's own
  type stripper, the same mechanism that was already stripping the types in memory from a checkout — and
  committed, so the published module behaves as the vendored source did and the `.ts` files remain the
  sources of record. Their freshness is checked the way the dashboard bundle is, and the release check
  now passes end to end, including installing the tarball into an empty prefix and running the installed
  CLI. The failure was invisible because `test/package-install.test.mjs` unpacked the tarball and ran it
  from there — extraction, not installation — and **that gap is closed**: the test now performs a real
  `npm install` into an empty prefix, asserts the package landed under `node_modules` before doing
  anything else, and was verified to fail with the original error when the `.ts` import is put back.
- **The settings payload says where each editable value came from.** Every field the page can edit now
  carries an origin — `config-file` if the file sets it, `fallback` if it is in force because the program
  chose it. The page already showed the effective value; this is what lets it explain *why* that value is
  what it is, which is the difference between a setting and a default. Only the origin is reported, never
  a default *value*: several fallbacks are described in prose rather than as a literal, and inventing a
  number here would create a second source of truth for something the validator already owns. A legacy
  flat role key counts as the file setting the field, because it still feeds the role map. The rendering
  is a follow-up; this commit is the contract and its test.
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
- **`privacy cleanup --execute`: the retention values now do something.** The plan resolves the
  configured numbers into concrete paths — keeping the newest `backups` setup snapshots and config
  migration backups, and removing `state/hook-sessions/` directories and `state/last-bootstrap.json`
  older than `diagnosticsDays` — and reports each target's group, measured size and the modified time
  the decision came from, so the preview is checkable rather than reassuring. Execution re-derives
  every path from the memory home and re-checks its group before deleting, because a plan is data and
  may be stale or hand-edited: a target outside the home, an unknown group, or a protected path is
  refused rather than honoured. Four things are out of reach by construction — the ledger and the
  store (retention never rewrites immutable records), archives written elsewhere with
  `backup create --out`, `backups/replacements/` (the rollback store an in-flight atomic write depends
  on, which looks like a backup by its path and is not one), and anything outside the memory home. The
  plan names the protected directories it spared rather than skipping them silently, so a reader can
  see they were considered.
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

- **A cached `refreshIndex` no longer rewrites the index.** It already skipped re-parsing files whose
  `mtime` and size were unchanged, which made the remaining cost easy to overlook: it still serialised
  and wrote the whole index on every call, and every entry carries the lowercased full text of its
  note, so that write scaled with the entire store. The index is now written only when a file actually
  changed, or when the route table differs from what is on disk, or when `force` is passed — so
  `builtAt` records when the index changed rather than when it was last looked at. Measured on the
  recorded baseline machine: 15.77 → 7.56 ms at 1k events and 129.01 → 60.91 ms at 10k, both 2.1×. The
  regression test pins the semantics (no write when nothing changed; a note change, a stale route table,
  `force` and `persist: false` all still behave as documented) rather than the timing, and it fails
  against the previous always-write behaviour. See `PERFORMANCE.md` for the method and the numbers.
- **The index is no longer re-parsed on every call.** The parsed index is kept in memory, keyed on the
  file's own path, `mtime` and size, so a file written by another process or restored from a backup is
  read rather than served stale. A cached refresh goes from 2.90 ms at 1k events to 12.00 ms at 10k
  (5.4× and 10.8× against where this started). This one carries a risk the previous change did not:
  the `entries` handed out are now the same objects across calls, so callers must treat them as
  read-only. That was checked before the change — `dashboard.mjs`, `memory.mjs`, `lib/catalog.mjs`,
  `lib/core.mjs` and `lib/lifecycle.mjs` all use `Object.values`, filters and property reads — and the
  function now says so, because a later caller that mutated an entry would corrupt every call after it.
  Tests cover the two ways this could go wrong: two stores in one process must not share an index, and a
  legacy or corrupt `index.json` must be rebuilt rather than masked by a warm cache.
- **`inside()` resolves its root's real path once instead of on every call.** The path containment
  helper called `fs.realpathSync` twice per invocation, and a journal replay calls it once per evidence
  source per event — measured at 1k events, those two calls were 452 ms of a 502 ms validation pass,
  while the entire parse of the journal was 6.9 ms. Nearly every code path uses `inside`, so the fix
  shows up almost everywhere: 1.5-2.2× across `loadEvents`, `record`, `recallFacts`, `settingsSnapshot`
  and the dashboard routes. Only successful resolutions are cached, so a root that does not exist still
  throws on every call, and the cursor is deliberately not cached because whether a path exists yet is
  exactly what changes between calls; the symlink-escape check is unchanged and still tested.
- **Recorded, because it is the more useful half of the result: a plausible optimisation was measured
  and thrown away.** Caching the journal parse per file — the diagnosis at the time — was implemented
  and produced no improvement (721 ms against 625 ms on the row that measures it). Splitting the replay
  and timing it showed why: the parse is about 1% of the cost, and the rest is validation calling into
  `inside()`. The cache added shared state and a caller contract for nothing, so it was reverted rather
  than kept because it had felt right. `PERFORMANCE.md` records both the numbers and the dead end.
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

- **A receipt row with no usable label was read as if it were fine.** The label is what attributes a
  row to a host, and `setup --uninstall` selects the rows it may restore with
  `row.label.startsWith(...)`, so a row whose label was absent or not a string could only fail later,
  inside the one path that restores a user's configuration - as a `TypeError` rather than a refusal.
  Such a row now makes the record unusable, naming the file, and `mergeReceiptEntry` refuses to write
  an unlabelled row at all, so the writer and the reader agree on what a usable row is instead of each
  defending itself separately. Every release that has written this file recorded a label, so no
  legitimate record is refused by the stricter rule.
- **`setup` rewrote host files outside its lock, and recorded the restore chain after the write.**
  Both halves lose the user's own configuration. The host-file read-modify-write sat outside the
  setup lock, which wrapped only the receipt update, so a `setup` racing another `setup` - or an
  `--uninstall` - could read, decide and write in either order; a restore could then drop the row a
  competing install was recording at that moment, leaving a file installed with nothing recording how
  to restore it. And the receipt row was written *after* the host file, so an interruption between
  the two left memkeel's content in a host file with the pre-install bytes recorded nowhere; the next
  run found the file already matching and skipped it, discarding the only way back. The lock now
  covers the read, the decision, the file write and the row, and the row is written first, so an
  interruption leaves the original bytes on disk and a later run still knows how to undo the install.
  The old order was justified by a guard that accepted only the installed state; that guard has since
  accepted both states this install owns, which is what makes the new order safe. A dry run and
  `--check` still create no lock file, because they promise not to write.
- **One unusable row in the installation receipt made the whole restore chain look healthy.**
  `readInstallReceipt` dropped any `files` row it could not restore from - one without a string
  `after`, or without a `before` that is a string or null - and still reported `malformed: null`, so
  a corrupt record passed every check. An uninstall would then restore the files it still had rows
  for, report success, and leave memkeel's own content in a host file whose original bytes were
  gone, with nothing said about it. A row that cannot restore anything now makes the whole record
  unusable, naming each affected file, so `setup` refuses it and keeps the file for inspection and
  `doctor` reports it as unhealthy. A receipt written by 1.0.0 always recorded `before` and `after`,
  so this does not refuse one: it still reads as legacy but valid.
- **A second writer could enter while a live holder owned the writer lock.** Recovering an orphaned
  lock meant verifying the recorded holder and then renaming the file aside, and those are two
  steps. One contender could read a dead holder's record while another contender created a fresh,
  live lock at the same path, so the stale rename moved *that* lock away and a second writer entered
  while the live holder still believed it held the lock. The unconditional `unlinkSync` in `finally`
  had the mirror-image flaw, deleting whichever lock sat at the path instead of the one the call had
  acquired, `processAlive` treated every `process.kill` error other than `EPERM` as proof of death
  rather than an unanswerable question, and a failure while writing the owner record happened
  outside the `try` that released it, so a failed acquisition leaked its own lock. Writer locks are
  no longer removed automatically at all: acquisition fails closed and names the holder, the age and
  the exact file to delete, `inspectLock` reports the same facts read-only and answers `null` for
  "cannot be determined" instead of "dead", a holder counts as gone only on `ESRCH`, the owner
  record is written inside the same `try` that releases it, and release removes the file only when
  the open handle or the recorded token proves it is still this call's own file. A crash after a
  write now costs one manual delete; the alternative was two writers in the ledger.
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
