**English** | [简体中文](README.zh-CN.md)

# Memkeel

**A local-first memory ledger for coding agents.** Four different agent hosts share one
plain-Markdown store where every memory is an immutable, evidence-backed event.

Memkeel is not a chatbot memory widget and not a vector database. It is a small ledger
that four coding agents — **Codex, Claude Code, ZCode and dsh** — read and write through
one shared contract. Each memory is an append-only event recorded as JSON inside a
Markdown note; Markdown is the source of truth; every projection the agents actually read
(topic pages, daily digests, habit lists, action and mistake ledgers) is *derived* from
that event journal and can be rebuilt from it. A fact never silently changes: replacing a
value requires an explicit `supersedes` link to the event it replaces, so the store keeps
a provenance and supersede chain for every claim, and two disagreeing claims become a
visible conflict instead of a last-write-wins overwrite. There is no service to run, no
database, no API key and no daemon: the whole system is Node.js and files on disk, so it
works the same in a terminal, in an air-gapped checkout or inside a container.

- **Immutable events.** Events are append-only and never edited in place.
- **Evidence-backed.** Every event must cite at least one existing note that already exists on disk.
- **Plain Markdown.** Any Markdown folder is a valid store. Obsidian is an optional enhancement.
- **No service, no database.** Files, and a read-only local web console when you want one.
- **Provenance and supersede.** `supersedes` links build a reviewable history per fact key.

---

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [The roles and layout model](#the-roles-and-layout-model)
- [Storage backends](#storage-backends)
- [Host integrations](#host-integrations)
- [CLI reference](#cli-reference)
- [The web console](#the-web-console)
- [Native hooks](#native-hooks)
- [The event and evidence contract](#the-event-and-evidence-contract)
- [The shared policy block](#the-shared-policy-block)
- [Tests and the leak gate](#tests-and-the-leak-gate)
- [Why Obsidian (optional)](#why-obsidian-optional)
- [Docker](#docker)
- [Project layout](#project-layout)
- [License and credits](#license-and-credits)

---

## Requirements

- **Node.js >= 22.18** (`engines` in `package.json`). Node 24 is also supported.
- A Markdown folder to act as the store. It does not have to exist yet — `memkeel init` creates it.
- Optional: [Obsidian](https://obsidian.md) plus an `obsidian` CLI on `PATH`, only if you want the
  `obsidian-cli` storage backend.
- Optional: npm, only if you want the long-form `memkeel` command name instead of `node memory.mjs`.

Node 22.18 or newer is enough on its own. TypeScript-typed helper files are loaded through
Node's built-in type stripping, so **no `--experimental-strip-types` flag is required**:

```console
$ node --version
v22.22.3
$ node memory.mjs doctor
```

Older runtimes (for example Node 22.0–22.17) will fail to load the vendored helpers.

## Install

### From a clone

```bash
git clone https://github.com/RueDragon/memkeel.git
cd memkeel
node memory.mjs help
```

That is the entire install. Memkeel has **zero runtime npm dependencies**: the core library,
the MCP server, the hooks, the CLI and the web server all run on the Node standard library.
The committed web console bundle under `dashboard/static/` means you do not need to build
anything to use it either.

### As an npm package (not published yet)

The package is prepared for npm, but v1.0.0 ships from GitHub and the npm release is planned
for v1.1. Until then, install from a clone.

```bash
npm install -g memkeel   # available from v1.1
memkeel help
```

Once installed either way you get the same program. `bin/memkeel.mjs` is a thin shim that forwards to
`memory.mjs`, so `memkeel <command>` and `node memory.mjs <command>` are interchangeable.
The rest of this document uses `memkeel`; substitute `node memory.mjs` if you are running
from a clone without putting the binary on `PATH`.

## Quick start

Three commands take you from nothing to a working, agent-connected store.

### 1. Create the store

```bash
memkeel init
```

`init` creates an empty but ready-to-use memory home: a `config.json`, the shared policy source
(`bootstrap.md`), the event contract (`event-schema.md`), the store directory layout
(`events/`, `topics/`, `digest/`, `projects/`) and an empty `habits.md`. It deliberately
**does not touch any agent** — no MCP registration, no hooks, no instruction files. Run it
before `setup`.

The remaining projection notes (`actions.md`, `mistakes.md`, `candidates.md`,
`experience.md`) are not created up front; each appears the first time consolidation has
something to write into it. `memkeel doctor` on a freshly initialised store is healthy and
exits zero.

Point it somewhere other than the default with `--home <dir>` or by setting `MEMKEEL_HOME`.
The default memory home is `~/.memkeel`, and the default store is created underneath it.

### 2. Bind your agents

```bash
memkeel setup                       # detect installed hosts and bind the ones it finds
memkeel setup --hosts codex,dsh     # only these hosts
memkeel setup --dry-run             # print what would change, write nothing
memkeel setup --check               # report drift, write nothing, exit non-zero on drift
memkeel setup --no-hooks            # register MCP + policy, skip native hooks
memkeel setup --uninstall           # remove the bindings and restore backups
```

`setup` registers the MCP stdio server, installs the native hooks, and publishes the shared
policy block, for each host it finds. **Hosts that are not installed are detected and skipped
with an explicit report** rather than failing the run.

`setup` is idempotent: every write is backed up first, read back for verification, and a
second run changes nothing. See [Host integrations](#host-integrations) for exactly which
file each host gets.

### 3. Verify

```bash
memkeel doctor
```

`doctor` reports the config path, missing expected files, pending captures, checkpoint
health, and both writer locks (the store lock and the hook-queue lock) together with holder
liveness. It exits non-zero when something is genuinely wrong.

A writer lock is never removed automatically, not even when its recorded holder is provably gone.
`doctor` reports that case as stale so the diagnosis is visible, and a blocked write names the same
holder and the file to delete, but the decision stays with you: stop every writer first — including
anything that would start one again, such as a host hook that respawns a run — and then delete the
lock file yourself, rather than let a recovering process guess whether the holder it cannot see is
really finished. The lock is a file the runs agree to respect, so it excludes another run that takes
it and does nothing about a program that rewrites the store without taking it. Two writers in the
ledger is the failure this trades against, and it is the worse one.

Then use it from any bound host, or from the shell:

```bash
memkeel bootstrap --cwd "$PWD" --query "release checklist"
memkeel recall --query "storage backend" --workspace my-project
```

---

## Configuration

Memkeel reads **one JSON file**: `~/.memkeel/config.json`.

The memory home is resolved by one precedence, shared by every command:

1. `--home <dir>`
2. `MEMKEEL_HOME`
3. the per-user default, `~/.memkeel`

The same directory holds `bootstrap.md`, `event-schema.md`, `backups/` and `state/`.

The language of everything the CLI prints for a person is resolved by a second precedence:

1. `MEMKEEL_LOCALE` (`en` or `zh-Hans`)
2. `LC_ALL`, `LC_MESSAGES`, `LANG`
3. English

Only the text meant for a person is translated. The JSON payloads keep their field names, and text
that lands in the store - note bodies, event bodies, evidence text - is data and is never translated.

The schema is documented in full by [`config.example.json`](config.example.json). Copy it to
`<memory home>/config.json` and edit it, or let `memkeel init` write it for you. Three read-only
commands inspect it and write nothing:

```bash
memkeel config validate           # every field error at once; non-zero exit when invalid
memkeel config show --effective   # normalised values and where each one came from
memkeel config migrate --dry-run  # the upgrade plan for an older document
memkeel config migrate --apply    # write that plan, after a backup and a readback
```

`config validate`, `config show` and `config migrate --dry-run` never write. `config migrate
--apply` is the only one that does, and it refuses to write an empty plan, refuses to write a
document that would not validate, copies the exact bytes it read to
`<memory home>/backups/config-migrations/` first, and rolls back if the readback disagrees.

`config show` masks paths; add `--reveal-paths` to print them in full.

| Key | Meaning |
| --- | --- |
| `version` | The release that wrote the file. Migrations never rewrite it. |
| `configSchema` | The shape of this document. `memkeel config migrate` adds or updates it. |
| `memoryRoot` | Absolute path to the memory root (the store root). |
| `layout` | Layout model. `neutral` is the modern default; older flat layouts are still readable. |
| `roles` | Logical role → relative path map. See below. |
| `storage` | `filesystem` (default) or `obsidian-cli`. |
| `vaultRoot` | Absolute path to the Markdown store. Relative roles resolve against this. |
| `vaultName` | Obsidian vault name. Only used by `obsidian-cli`. |
| `obsidianCli` | Absolute path to the `obsidian` CLI. Only used by `obsidian-cli`. |
| `policyRoot` | Absolute path to the memory home. Set automatically from `--home` / `MEMKEEL_HOME`. |
| `activeLimit` | How many active projects the bootstrap summary lists. |
| `recentLimit` | How many recent-change groups the bootstrap summary lists. |
| `recentDays` | Width of the "recent changes" window in days (default 14). |
| `budgetBytes` | Byte budget for the injected bootstrap summary (default 14000). |
| `workspaceAliases` | Extra path aliases per workspace id, for worktrees and moved checkouts. |
| `hook.codexDeferAdvisory` | Defer Codex tool advisories to the next prompt (`true`, the default). Only `false` opts out; model lists are ignored on purpose. |
| `topics` | Registered topic routes: `{ id, workspace, title, aliases, path }`. |
| `catalogTopics` | Grouping metadata used by history ingest and the topic catalog. |

`config.example.json` uses documented placeholders such as `C:/Users/<you>/agent-memory` and
`C:/Users/<you>/.memkeel`. Replace them with real paths for your machine.

## The roles and layout model

Code depends on **logical roles**, never on hard-coded physical paths. A role is a name such
as `eventsRoot`; its value is a path relative to `vaultRoot`. That indirection is what lets
the same build serve a neutral folder, an existing vault with a house style, or an
Obsidian-specific tree, with no code changes.

Default (neutral) roles:

| Role | Default | Holds |
| --- | --- | --- |
| `root` | `''` | The store root itself. |
| `eventsRoot` | `events` | The immutable event journal, one file per day/workspace/agent, plus `events/Evidence/`. |
| `topicsRoot` | `topics` | Generated topic pages (current state per topic). |
| `projectRoot` | `projects` | Workspace registry notes (`workspace-<id>.md`) and topic descriptors. |
| `habitsNote` | `habits.md` | Confirmed habits, plus a managed block of event-confirmed rules. |
| `actionsNote` | `actions.md` | Generated open-action ledger. |
| `mistakesNote` | `mistakes.md` | Generated confirmed-mistake increment. |
| `candidatesNote` | `candidates.md` | Generated pending preference candidates. |
| `experienceNote` | `experience.md` | Generated experience / short-term-context catalog. |
| `inboxRoot` | `digest` | Daily digests and long-form notes. |

Two rules keep this safe:

1. **Managed blocks only.** Generated content lives between `<!-- AUTO-MANAGED:START -->` and
   `<!-- AUTO-MANAGED:END -->` comments. Consolidation replaces exactly that block and never
   touches the prose around it, so you can hand-write anything else in those notes.
2. **Journal is the write path.** Anything generated is rebuilt from the journal. Editing a
   generated page by hand is overwritten on the next consolidation — record an event instead.

A legacy flat config (top-level `eventsRoot`, `projectRoot`, `habitsNote`, `inboxRoot`, …)
still resolves to the same role map, so existing stores keep working byte-for-byte without a
migration.

## Storage backends

Every backend implements the same five verbs — `read`, `create`, `append`, `replace`,
`verify` — so no caller ever branches on which one is active (`lib/storage/adapter.mjs`).
`storage` selects it; when the key is absent, a configured `obsidianCli` implies
`obsidian-cli` and otherwise `filesystem` is used.

### `filesystem` (default)

Plain file IO against `vaultRoot`. **Zero external dependencies**, works headless, on any OS,
inside a container, and on a plain Markdown folder that has never seen Obsidian.

- `create` refuses to overwrite an existing note, then writes and reads the bytes back.
- `append` is exact-or-rollback: the file is read back, and any mismatch restores the previous bytes.
- `replace` is guarded by an expected value, writes a timestamped backup under
  `backups/replacements/` with before/after hashes, and re-checks that the target did not move
  between preflight and write.

### `obsidian-cli` (optional)

Drives an installed Obsidian instance through `obsidianCli` and `vaultName`. Note content is
still written as bytes straight to the vault path and then confirmed by reading it back
through the CLI — the CLI is the *verification* channel, not the write channel. Exact managed
replacements additionally generate a Git patch, preflight it with `git apply --check`, and
only publish the verified result.

Both backends share the write path described in
[The event and evidence contract](#the-event-and-evidence-contract), including the rule that
note content never travels through a CLI argument list.

## Host integrations

Memkeel speaks to four hosts: **Codex**, **Claude Code**, **ZCode** and **dsh**. `memkeel setup`
binds a host only when its configuration directory exists, and reports every skipped host.

| Host | MCP server registered in | Hooks installed in | Shared policy published to |
| --- | --- | --- | --- |
| Codex | `<CODEX_HOME or ~/.codex>/config.toml` → `[mcp_servers.agent_memory]` | `<codex home>/hooks.json` | `<codex home>/AGENTS.md` |
| Claude Code | `~/.claude.json` → `mcpServers.agent_memory` | `<CLAUDE_CONFIG_DIR or ~/.claude>/settings.json` | `<claude config dir>/CLAUDE.md` (native `@`-import) |
| ZCode | `~/.zcode/cli/config.json` → `mcp.servers.agent_memory` | `~/.zcode/cli/config.json` (`hooks.events.*`) | `~/.zcode/AGENTS.md` |
| dsh | `~/.dsh/profiles/<profile>/cordis.patch.yml` | same file, plus `<memory home>/dsh-hooks.json` | `~/.dsh/AGENTS.md` |

Notes on each:

- **Codex.** `setup` writes a `[mcp_servers.agent_memory]` TOML section with the current
  `process.execPath` and the absolute `mcp-server.mjs` path. Codex keeps its own hook trust
  boundary; nothing bypasses it.
- **Claude Code.** The MCP entry goes into `~/.claude.json`, and the shared policy is published
  as a native `@`-import line inside the managed markers rather than as an inlined copy.
- **ZCode.** The MCP entry and the hook table both live in `~/.zcode/cli/config.json`. `setup`
  also turns the host's own built-in memory feature off (`memory.use`, `features.memory`),
  because running both duplicates context. Only the read-only tool is pre-approved; writes go
  through the host's normal approval flow.
- **dsh.** MCP and hooks are injected as marked blocks in the profile's `cordis.patch.yml`,
  one per profile that actually exists (headless / web / desktop). Hooks are provided by the
  zero-dependency `dsh-memory-plugin.mjs` bridge so dsh shares the host's own protocol objects
  instead of installing duplicate peer packages.

MCP exposes two tools:

- **`agent_memory_read`** — read-only: `help`, `status`, `bootstrap`, `recall`,
  `experience_recall`, `context_recall`, `check_operation`. It cannot write, capture, confirm a
  habit or execute a shell command.
- **`agent_memory`** — purpose-limited writes: `capture`, `record`, `consolidate`,
  `maintenance`, `register`, `habit_decide`. **Neither tool exposes a shell or arbitrary
  file-write capability**, and neither relaxes the host sandbox.

Restart an existing host session after changing hook or MCP configuration; running sessions do
not pick up user-level entries mid-session.

To undo everything, run `memkeel setup --uninstall`. It removes the MCP entries, the hook
declarations and the policy blocks it owns, restores from `state/setup-receipt.json`, and leaves any
configuration it does not own untouched.

## CLI reference

Every command takes optional `--home <dir>` to point at a different memory home.

### Setup

| Command | What it does |
| --- | --- |
| `init [--store DIR] [--obsidian-cli PATH] [--vault-name NAME]` | Create an empty, ready-to-use memory home and store: directory layout, `config.json`, the policy source, the event contract and an empty `habits.md`. Touches no agent. `--store` sets the store root; the Obsidian flags pre-fill the optional `obsidian-cli` backend. |
| `setup [--hosts codex,claude,zcode,dsh] [--dry-run] [--check] [--no-hooks] [--uninstall] [--force]` | Bind the store into installed hosts: register the MCP server, install native hooks, publish the shared policy. `--dry-run` prints intended changes; `--check` reports drift without writing and exits non-zero on drift; `--no-hooks` skips hook installation; `--uninstall` removes the bindings and restores backups. Uninstalled hosts are detected and **skipped** with a clear report. If a host already has an `agent_memory` MCP server that points somewhere else, that host is **refused** rather than silently rebound; review it, or re-run with `--force`. |

### Config

| Command | What it does |
| --- | --- |
| `config validate` | Read-only. Validates the whole document and prints every field problem at once, plus notes for unknown or deprecated keys, and exits non-zero when invalid. It shares its validator with the settings page, so `memkeel config validate` and the console reach the same verdict. |
| `config show [--effective] [--reveal-paths]` | Read-only. Prints the normalised values the program will actually use, each with its source: the file, a legacy flat key, or a default. Paths are masked unless `--reveal-paths` is given. |
| `config migrate [--dry-run]` | Read-only. Prints the upgrade plan for a document written by an older shape: the schema number, deprecated flat role keys folded into `roles`, a store root derived from the one that is present, and missing defaults. It writes nothing and creates nothing. |
| `config migrate --apply` | Writes that plan. It is a no-op when the plan is empty, validates the migrated document before writing, copies the original bytes to `<memory home>/backups/config-migrations/`, and rolls back if the readback disagrees. Re-running it is idempotent, and `--dry-run --apply` together is refused as contradictory. |

### Backup and restore

| Command | What it does |
| --- | --- |
| `backup create --out DIR` | Write an archive of the journal, the memory home's configuration, the policy source, and the state that cannot be recomputed — the installation receipt, retention decisions, pending captures and the checkpoint queue. The search index and the topic catalog are **not** carried: they are rebuilt from the journal by `memkeel index` and `memkeel consolidate`, and the manifest lists them as `notCarried` so the omission is visible. Taken while holding the writer lock, so no capture or consolidation can land inside the copy. Refuses a destination inside the memory home or the store, and refuses a destination that is not empty. |
| `backup verify --dir DIR` | Recompute every checksum and report corruption, missing files and unlisted files **separately** — "which parts of my archive are still good" is the question you actually have. Exits non-zero when the archive is not intact. |
| `restore --dir DIR --into DIR` | Read-only plan. Checks the manifest for absolute paths and `..` traversal, for entries outside the `home/` + `store/` layout, for an unsupported format, for a destination that already holds data, and for free space. Writes nothing. |
| `restore --dir DIR --into DIR --execute` | Verify the archive, then restore into a **new** directory and repoint the restored `config.json` at it. The rewrite is not optional: without it the restored home would still name the store it came from, which looks like a successful restore and behaves like a broken one. |

```bash
memkeel backup create --out ~/memkeel-backups/2026-09-16
memkeel backup verify --dir ~/memkeel-backups/2026-09-16
memkeel restore  --dir ~/memkeel-backups/2026-09-16 --into ~/restored     # plan only
memkeel restore  --dir ~/memkeel-backups/2026-09-16 --into ~/restored --execute
```

**A backup is itself sensitive data.** It contains the whole journal and may contain the original
bytes of host configuration, which can carry credentials — which is exactly why the receipt is
carried at all. The archive directory is created `0700`, but that is all this program does about it:

- **No encryption is built in, deliberately.** A key that this program generates and stores next to
  the archive protects nothing, and a key the user must keep would make a restore impossible at the
  moment it is needed most. Rely on full-disk encryption for the volume and on directory
  permissions; if you need an encrypted archive, put it through your own tool (`age`, `gpg`,
  `restic`) and treat the passphrase as the recovery responsibility it is.
- **Restoring over a live store is not implemented.** `--into` writes to a new directory, and an
  existing non-empty destination is refused. Overwriting in place needs a pre-restore snapshot and an
  explicit confirmation step, and that is deliberately not improvised here.

### Moving a store

A restore brings a store back; a migration moves the live one. They are different operations with
the same shape — copy, verify, repoint — so they share one classification of what has to be carried
and one rule about where the configuration is written.

| Command | What it does |
| --- | --- |
| `migrate --to DIR` | Read-only plan. Reports the source, the destination, the file and byte counts, the configuration keys that would be rewritten, and the workspace aliases in effect. Writes nothing. |
| `migrate --to DIR --execute` | Copies the home and store to `DIR/home` and `DIR/store`, verifies each file against the hash it read, and writes the repointed `config.json` **last**. Refuses a destination that overlaps the source, sits inside the memkeel checkout, or already holds data. |

```bash
memkeel migrate --to /srv/memkeel            # plan only
memkeel migrate --to /srv/memkeel --execute
MEMKEEL_HOME=/srv/memkeel/home memkeel doctor
```

Three properties are worth stating because each is a way this goes wrong:

- **The source is never modified or deleted.** A migration is a copy plus a switch. Removing the old
  home is a separate, deliberate act by a human, and the command prints it as such rather than
  inferring it from a successful run.
- **The configuration is written last.** `config.json` is excluded from the copy loop entirely, not
  copied and then rewritten: an interrupted run therefore leaves a destination with no configuration
  at all, which cannot be mistaken for a working home. A destination whose config still named the old
  store would look like a completed migration and read the source store.
- **Recorded evidence is not rewritten.** Events keep the evidence paths they were written with.
  Workspace aliases travel verbatim, because an alias is how a moved project directory keeps
  resolving to the same workspace; the ledger is a record of what happened, not a set of live links.

### Collection and privacy

Collection is off means off. `collection` in `config.json` is consulted by every layer that writes
conversation text, not by the pages that display it:

| Layer | What the switch does |
| --- | --- |
| Hook queue | Nothing is queued. The text never reaches `state/hook-queue/`. |
| Session file | The prompt and the last reply are not written to `state/hook-sessions/`, and neither is the recall query in `factRecall`. |
| Checkpoint drain | A checkpoint queued *before* the switch was turned off is `held`, not promoted to evidence. Held rows drain normally once collection is on again. |
| Access log | No entry is appended for a workspace that opted out. |
| Historical ingest | `ingest-apply` skips candidates whose workspace, host or path is not collected. |

| Command | What it does |
| --- | --- |
| `privacy show [--host H] [--workspace W] [--cwd DIR]` | Read-only. Prints the effective policy, the vocabulary below, and **which scope decided** — a switch that cannot explain itself is indistinguishable from a bug. |
| `privacy exclusions --preview FILE` | Read-only. Evaluates each exclusion rule against sample values from a JSON file and names the rules nothing matched. |
| `privacy cleanup [--host H] [--workspace W] [--cwd DIR]` | Read-only preview. Lists **every path** a retention pass would remove, with its group, measured size and the modified time the decision was based on, plus an explicit list of what it would not touch. Deletes nothing. |
| `privacy cleanup --execute` | Removes exactly the paths that plan listed. Four things are out of reach by construction: the ledger and the store (retention never rewrites immutable records), archives you wrote elsewhere with `backup create --out` (that directory is yours and this program does not know where it is), `backups/replacements/` — the rollback store an in-flight atomic write depends on, which looks like a backup by its path and is not one — and anything outside the memory home, since every target is re-derived from the home and re-checked before deletion rather than trusted from the plan. |
| `privacy export --out FILE` | Writes **one** redacted file, safe to hand to someone else: versions, counts, the configuration with credentials dropped and paths reduced, and the effective collection policy. No session text, no evidence, no full paths, no credentials. It audits its own payload against the real string values before writing and refuses to write if that check fails; it also refuses to overwrite an existing file. |

The dashboard's **Settings** page renders this same policy read-only — the decision, the scope lists,
the exclusion rules and the three states above — from the same function the CLI uses, so the page and
`privacy show` cannot disagree. It is not an editor on purpose: turning collection off reaches hooks,
ingest and the access log, so the page reports what is in force rather than offering a control that
only looks like a switch. Because the page has no session context, it labels its verdict as the default
for an unnamed host and workspace, and lists the scopes separately — a workspace-level opt-out does not
apply to a question that names no workspace, and the page says so instead of implying otherwise.

```json
{
  "collection": {
    "enabled": true,
    "hosts": { "codex": false },
    "workspaces": { "project-a1b2c3": false },
    "exclude": { "paths": ["/srv/private"], "sessionTypes": ["scratch"], "sources": ["transcript"] },
    "retention": { "contextDays": 30, "backups": 5, "diagnosticsDays": 14 }
  }
}
```

The scopes are ordered so the answer can only ever become *more* private:

1. `enabled: false` is a hard stop. Nothing below it re-enables collection. A global off switch that a
   stale per-host entry could override would be a trap, not a feature.
2. An exclusion rule that matches wins. An explicit denial is the most specific thing a user can say.
3. `workspaces[<id>] === false`.
4. `hosts[<host>] === false`.

`true` values are accepted so a config can state its intent, but they never override a broader
denial. An absent or malformed `collection` section means **collect** — so an existing store keeps
behaving exactly as it did before this switch existed — and a typo can never silently stop collection.

Matching is exact and each kind says what it means: a `paths` rule matches the directory itself and
everything inside it (not `workshop` when the rule is `work`), while `sessionTypes` and `sources`
match the whole value. There are no globs and no substring surprises.

**Three different things get called "deleted", so they are named separately** — in the payload, not
only here:

- **不采集 / not collected** — the conversation was never written. No queue entry, no checkpoint, no
  evidence, no access-log entry. Nothing to reverse.
- **软删除 / retained but not retrieved** — the original record is still complete in the ledger; it
  just stops entering default summaries and ordinary recall. History and provenance remain traceable.
- **物理删除 / physically deleted** — **not offered.** The ledger is append-only and every event is
  verified, so deleting in place would break its own integrity, and it cannot recall backups,
  snapshots or external copies that already exist. What you can do instead: stop collection, exclude
  the sensitive paths *before* collecting, and let retention expire derived material — see
  `memkeel privacy cleanup` for the exact scope.

### Reading

| Command | What it does |
| --- | --- |
| `bootstrap --cwd PATH --query TEXT [--workspace ID] [--json] [--all] [--audit]` | Startup summary: confirmed habits, active projects, recent changes, matching task guidance and live short-term context, collapsed to `budgetBytes`. Read-only; `--audit` deliberately persists diagnostics. |
| `recall --query TEXT [--workspace ID\|NAME\|PATH] [--history]` | Topic and fact lookup. Prefers current event-backed facts, then registered canonical topics, then BM25-ranked evidence. `--history` widens to provenance and archived material. |
| `experience-recall` / `context-recall` | Retrieve execution experience or short-term task contexts. No read ever increments usage or writes a cache. |
| `check-operation --file INPUT.json` | Bounded static preflight for a proposed operation (kind, command, shell, cwd, boundary). Returns matched experiences and warnings — **not** permission, and not a guarantee that a command is safe. |
| `audit` | Report the note index by type and list untyped historical sources. Historical claims require deliberate promotion. |
| `doctor` | Health check: config and expected files, pending captures, checkpoint health, and both writer locks with holder liveness. |

### Writing

| Command | What it does |
| --- | --- |
| `register --topic WORKSPACE/KEY --workspace ID --title TEXT [--alias TEXT]` | Add a topic route. Cannot overwrite an existing topic and never promotes a historical claim. |
| `record --file EVENT.json` \| `record --stdin` | Append one immutable event and consolidate it synchronously. |
| `capture --file INPUT.json` \| `capture --stdin` | Take `{event, evidence_text}`, write the evidence note, record the event, consume it with readback. |
| `habit-decide --file INPUT.json` \| `habit-decide --stdin` | Close a preference candidate as `confirmed` or `rejected` with an exact user quote that must exist in the evidence note. |
| `consolidate` | Consume pending events and rebuild managed projections. `pending` is the remaining backlog; `pendingBefore` is the backlog at the start of the pass. |
| `retain --candidates` / `retain --file DECISIONS.json` / `retain` | Retention ledger. `--candidates` lists undecided automatic checkpoints read-only; a decisions file applies soft drops; bare `retain` prints the ledger. |
| `maintenance [--rebuild]` | Recover interrupted captures, drain queued checkpoints, settle weight, promote eligible candidates to *probationary*, consolidate, and refresh the index and catalog. `--rebuild` regenerates marked projections that are missing. |
| `index [--force]` | Rebuild the incremental lexical index under the memory home. |
| `ingest-plan [--since ISO] [--limit N] [--root DIR] [--auto-register]` | Read-only report of historical agent turns that could be backfilled. |
| `ingest-apply [...]` | Write those historical turns as reported task contexts. |

## The web console

```bash
npm run dashboard          # or: node dashboard.mjs
# Agent Memory dashboard: http://127.0.0.1:3247
```

The console is a read-mostly local UI over the same projections the CLI and MCP use.
**No build step is needed**, because the built bundle is committed under `dashboard/static/`.

Views include facts, contexts, experiences, habits and candidates, actions, conflicts, the
event feed, workspace routes, topics, a system/health page, and a **session replay** view that
renders each agent session as a chronological chat transcript (user turns right, agent turns
left, Markdown-rendered) with two tabs: the archived checkpoint summary and the host's real
transcript. Reading a transcript is read-only and never writes to memory.

Writable actions — closing an action, confirming or rejecting a preference, composing a fact,
action, context or experience, revising or retiring an existing record — go through a two-step
preview/execute handshake: the server returns a plan plus a token bound to the current state
fingerprint, and execute **fails closed** if the journal moved in between. Every revision is an
append carrying `supersedes`, so the console never edits Markdown directly.

The server binds to **loopback only** (`127.0.0.1`) and takes `--port` to override the port.

Contributors changing the frontend rebuild the bundle:

```bash
npm --prefix dashboard/app install
npm run dashboard:build    # writes dashboard/static/
npm run dashboard:dev      # Vite dev server proxying /api to the running console
```

## Native hooks

`setup` installs hooks for every supported host so memory works without being asked. The
runner is `hook-runner.mjs`, invoked by the host with a JSON payload on stdin. Events and what
they do:

| Event | Behaviour |
| --- | --- |
| `SessionStart` | Injects the first bootstrap summary once per session. |
| `UserPromptSubmit` | Injects up to four long-term facts relevant to the prompt, plus matching short-term contexts, experiences and queued checkpoints; performs the first bootstrap synchronously where a host's `SessionStart` seam is detached. |
| `PreToolUse` | Runs the bounded execution-experience check for the proposed operation. It can return a **deny** decision for a definite violation, and otherwise injects an advisory. Memory tools themselves are skipped. |
| `PostToolUse` / `PostToolUseFailure` | Prompts for a recorded experience after a failure or after several search steps — the point being to capture a path or a ruled-out route before compaction loses it. |
| `Stop` / `PreCompact` / `SessionEnd` | Queues a bounded, redacted checkpoint (the user's request plus a truncated reply excerpt) for durable capture. |
| `SessionEnd` | Also reuses the current turn's reply if the host sends no assistant text, instead of replacing a richer checkpoint. |

Guarantees worth knowing:

- **Hooks never grant permission.** They inject context and can deny; they never relax the
  host's sandbox or approval mode.
- **Reads never reinforce.** No read path promotes a habit or extends a context's lifetime.
- **Redaction is applied** to hook output, bootstrap, recall and checkpoint writes, and capture
  rejects recognizable credentials. Historical journals are not rewritten by read paths.
- **No-record instructions are honoured.** A prompt that says not to record suppresses
  checkpoint capture for that turn (`state.readOnly`), creating neither events nor workspace notes.
- **Failures stay visible.** A failed checkpoint keeps its payload and last error in the
  hook queue and is retried; a missing workspace is never counted as a successful closeout.

On Codex, tool advisories are deferred for **every** model instead of being injected
mid-sequence: Codex turns extra hook context into a developer message, which can land between a
tool call and its result and split `tool_calls` from the tool reply, an ordering strict providers
reject. The text waits and rides the next prompt instead. Deny decisions are never deferred. A
model name cannot establish whether the forwarding provider accepts interleaved tool messages, so
legacy model lists are ignored; `hook.codexDeferAdvisory: false` is the only opt-out.

## The event and evidence contract

The authoritative contract is [`event-schema.md`](event-schema.md), which `setup` publishes
into the memory home so agents can read it locally. The short version:

```json
{
  "event_id": "20260907-codex-example-01",
  "workspace": "my-project",
  "topic": "my-project/channel-config",
  "agent": "codex",
  "occurred_at": "2026-09-07T16:00:00+08:00",
  "evidence": ["digest/existing-source.md"],
  "facts": [{ "key": "specific-contract", "text": "A verified conclusion." }],
  "verification": ["Exactly what was checked and what was not."],
  "actions": [{ "id": "verify-specific-case", "status": "open", "text": "One next action." }]
}
```

Rules the implementation enforces:

- **Required fields:** `event_id`, `workspace`, `topic`, `agent`, `occurred_at`, `recorded_at`,
  and at least one `evidence` entry.
- **Evidence must exist on disk.** Every entry is a store-relative path to an existing note,
  optionally with a `#heading`. An event cannot cite a note that is not there, and it must never
  cite itself.
- **The topic must be registered** for that workspace first, via `register`.
- **Immutability.** Events are appended, never edited. Reusing an `event_id` with different
  content is an error; reusing it with identical content is an idempotent retry, which is what
  makes interrupted writes safe to repeat.
- **`supersedes` is required to change a fact.** A differing claim for the same
  `topic` + `key` without it is recorded as a **conflict**: the current value is preserved and
  the disagreement is surfaced. Timestamps alone never win, and resolving a conflict clears it
  by explicitly superseding one side.
- **Retirement.** A replacement may mark itself `status: "invalidated"`, which removes the
  record from the current view without breaking the evidence chain.
- **Optional arrays:** `experiences`, `contexts`, `preferences` (candidates only),
  `habit_decisions`, `mistakes`.
- **No event size ceiling.** Long bodies belong in a note under `digest/longform/` with a small
  pointer event; injection stays bounded on the read side instead.
- **Secrets are rejected.** Recognizable credentials and private keys are refused at write time.

Journal on disk: one file per recorded day, workspace and agent at
`events/<YYYY-MM-DD>-<workspace>-<agent>.md`, with each event stored as a delimited block:

````markdown
<!-- EVENT:20260907-codex-example-01 -->
```json
{ "event_id": "20260907-codex-example-01", "...": "..." }
```
<!-- END-EVENT -->
````

A journal with unbalanced blocks, an event whose marker disagrees with its `event_id`, or a
consumed event that changed or disappeared makes the store fail closed rather than serve a
half-parsed history.

### Engineering note: content is written as bytes

Note content is written as bytes straight to the target path and then verified by reading it
back. It is **never** passed through a CLI argument list. The Obsidian CLI decodes the
two-character sequences `\n` and `\t` inside every argument and offers no way to escape a
literal backslash before those letters, so a Windows path such as `C:\temp\new\file.md` would
arrive as `C:<TAB>emp<LF>ew\file.md` and corrupt the journal. Reads are byte-faithful, so the
CLI stays the verification channel while the filesystem stays the write channel. Appends are
exact-or-rollback for the same reason: one corrupt append would otherwise break `loadEvents`
for the whole store.

## The shared policy block

The behavior the agents follow lives in one file: `<memory home>/bootstrap.md`
([`bootstrap.md`](bootstrap.md) in this repository is the seed copy). `setup` publishes it into
each host's instruction file inside managed markers:

```markdown
<!-- AGENT-POLICY:START -->
Source: <memory home>/bootstrap.md; sha256: <hash>; adapter: codex.
...policy text...
<!-- AGENT-POLICY:END -->
```

- Text outside the markers is always preserved.
- Each block records the source path, the source hash and the adapter name, so drift is visible.
- Claude Code receives a native `@`-import of the policy file instead of an inlined copy.
- The publisher checks source hashes, **not** runtime model behavior. An existing session may
  need a new task before it loads changed instructions.
- Maintain the policy source, never the generated host blocks.

Confirmed habits have exactly one data source: the note named by `roles.habitsNote`, in the
validated JSON block between its managed markers. Only confirmed, scope- and trigger-matching
preferences apply; one-off requests stay session-only, and inferred candidates never become
mandatory on their own.

## Tests and the leak gate

```bash
npm test          # node --test test/*.test.mjs
npm run check     # node scripts/check-syntax.mjs
npm run leak-scan # node scripts/leak-scan.mjs  (the working tree)
npm run pack-scan # node scripts/pack-scan.mjs   (the real `npm pack` artifact)
```

- **`npm test`** runs the unit and integration suite (26 test files) over the layout model,
  storage adapters, event validation, ranking, search, retention, transcripts, dashboard writes,
  the dsh plugin bridge and the leak gates themselves.
- **`npm run check`** runs `node --check` over every first-party `.mjs` file. Vendored code and
  the committed console bundle are skipped because they are not ours to fix.
- **`npm run leak-scan`** scans the working tree, including its own source, for generic
  credential, private-path and non-public-registry patterns. Maintainer-specific literal terms
  belong in an external JSON array referenced by `MEMKEEL_LEAK_TERMS_FILE`; never commit that
  file, and never put a private term in the scanner's own rule list. Diagnostics report the file,
  line and rule id but never the matched value, because a CI log on a public repository is public
  too.
- **`npm run pack-scan`** packs with `npm pack`, unpacks the real tarball, checks that every
  shipped file is declared in `package.json` `files`, and scans the artifact with the same rules.
  A clean working tree says nothing about what would actually be published.

There are three distinct scopes, and a result in one says nothing about the others:

| Scope | Command | Covers |
|---|---|---|
| Source | `npm run leak-scan` | the working tree, rule set plus the external term list |
| Package | `npm run pack-scan` | the real tarball's file list and text content |
| History | not automated | earlier commits, dangling objects, forks and downloaded copies |

**Coverage is bounded, and the summary states the bounds.** Files skipped as non-text
(`.png`, `.woff2`, `.pdf`, archives and other binaries) are not read, and symbolic links are not
followed; the run prints how many were skipped. A screenshot of a private vault or a PDF of an
internal page would pass this gate. Treat a clean result as "no match in the text that was read",
never as proof that a release contains no personal information.

### Upgrade and deployment notes

- **`setup` keeps a versioned installation receipt** at `<memory home>/state/setup-receipt.json`:
  per file, the bytes from before the install and the bytes it wrote. `setup --uninstall` restores
  from it and refuses any file that changed since, so treat it as private and do not edit it by
  hand. An interrupted install is not fatal — re-running `setup` completes it. Every run also names
  what it did: `first-install`, `no-change`, `upgrade`, `rebind`, `refresh` or `uninstall`.
- **`memkeel doctor` checks the install, not only the store.** It reports which of `--home` /
  `MEMKEEL_HOME` / the default chose the memory home, the receipt's state, whether the recorded
  bindings still point at that home, and whether the launcher and the scripts it invokes still
  exist. Drift is the quiet one: if the store moves and the hosts are not rebound, agents simply
  remember nothing.
- Codex advisory injection is deferred for every model by default. Legacy model lists are
  ignored, including empty lists. Only `hook.codexDeferAdvisory: false` opts out.
- Setup pins the absolute memory home in MCP and hook declarations. After upgrading an
  existing binding, review `setup --dry-run`; use `setup --force` to explicitly rebind it.
- Installation refusals return a nonzero exit code. `--check` also fails on drift.
- Uninstall restores the original bytes recorded in `state/setup-receipt.json`, including
  native-memory settings. It refuses later user edits rather than overwriting them. Legacy
  installations without a receipt require manual restoration from their setup backups.
- Keep the receipt and backups private: they may contain existing host credentials.
- Changing store paths in Settings selects a store; it does not migrate or copy data.
  Stop writers, back up both the memory home and store, copy and verify the store, then
  change paths and run `doctor`. Keep the old store until reads and writes are verified.
- CI tests Node 22/24 on Windows, Linux and macOS. Publishing to npm and rewriting public
  Git history remain separate maintainer operations, not automatic upgrade steps.
## Why Obsidian (optional)

The store is a folder of Markdown files, and that is the whole contract. Any editor works.

Obsidian is an *enhancement*, not a requirement:

- With the **`filesystem`** backend (the default) Memkeel never needs Obsidian at all.
- With the **`obsidian-cli`** backend, writes still go to disk as bytes and the CLI is used to
  confirm the vault view, so Obsidian's cache can never be the source of truth.
- If you already live in a vault, point `vaultRoot` at it and fill in `roles` to match your
  house structure. Managed blocks keep generated content separate from your own prose.
- If you do not use Obsidian, keep `storage: "filesystem"` and forget the last two keys.

What you give up without Obsidian is only the CLI readback confirmation step and any vault
conveniences you personally rely on. Nothing in the event model depends on it.

## Docker

The image runs the **`filesystem`** backend only: no Obsidian, no GUI, no external services.

```bash
docker build -t memkeel .

# First run: create the memory home and point the store at the mounted volume.
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel init --store /store

# Afterwards the default command is the health check.
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel
```

| Volume | Container path | Why |
| --- | --- | --- |
| Memory home | `/memkeel` | `config.json`, `bootstrap.md`, `event-schema.md`, `state/`, `backups/`. |
| Markdown store | `/store` | The `vaultRoot`: the event journal and every projection. Keep this on a real volume — it is the data. |

Mount both. The memory home holds the config and derived state; the store holds the Markdown
you would be sad to lose. `MEMKEEL_HOME` is set to `/memkeel` in the image.

`init` is idempotent, and it has to be told where the store lives: without `--store /store` it
creates the store inside the home volume and the `/store` mount goes unused. Once a memory home
exists the default command is `node memory.mjs doctor`, and you can override it with any other
command, for example:

```bash
docker run --rm -v memkeel-home:/memkeel -v "$PWD/store:/store" memkeel \
  bootstrap --cwd /store --query "release checklist"
```

On Windows PowerShell the volume argument needs its own quoting, and `$PWD` is `${PWD}`:

```powershell
docker build -t memkeel .
docker run --rm -v memkeel-home:/memkeel -v "${PWD}/store:/store" memkeel init --store /store
docker run --rm -v memkeel-home:/memkeel -v "${PWD}/store:/store" memkeel
```

On macOS the bash form works as written; Docker Desktop maps the same volume syntax.

### What this image is, and is not

It is a **CLI and storage tool**, not a service. The default command is a health check, so a
non-zero exit is a finding about your store rather than a crashed process. That is why no compose
file ships with it: `docker compose up` would report a perfectly healthy container as restarting
forever. If you want the console reachable, write your own compose file and give the console its own
long-running command (`node memory.mjs dashboard --port 3247`) instead of reusing `doctor`.

Hooks are meaningless in a container (no agent host lives there), so skip `setup` there and bind
the hosts from the machine that actually runs the agents. Never bake a config, a store, a receipt
or a token into the image.

### What has been verified, and what has not

The commands above are covered by the test suite against the **published package**, not the
checkout: `npm pack`, unpack into an empty directory, then `init` → `config validate` → `doctor` →
`bootstrap` → a live console request from the unpacked copy. A further test asserts that every path
the Dockerfile copies exists and that `dashboard/app` is not copied, so the image ships exactly what
`npm pack` ships.

What is **not** verified is the container itself: this machine has no container runtime, so no image
build and no container run has been performed. Treat the file set and the command contract as
tested, and the image build as untested.

## Project layout

```text
memkeel/
├── bin/memkeel.mjs          # npm bin shim -> memory.mjs
├── memory.mjs               # CLI entry point (all commands, help text, option parsing)
├── mcp-server.mjs           # MCP stdio server: agent_memory_read + agent_memory
├── hook-runner.mjs          # Native hook entry point (JSON payload on stdin)
├── dsh-memory-plugin.mjs    # Zero-dependency dsh hook bridge
├── setup.mjs                # `memkeel setup`: MCP + hooks + policy per host
├── dashboard.mjs            # Local read-mostly console HTTP server
├── integrate-mcp.mjs        # Standalone MCP registration (legacy convenience wrapper)
├── integrate-hooks.mjs      # Standalone hook installation (legacy convenience wrapper)
├── publish.mjs              # Publish the shared policy block to host instruction files
├── bootstrap.md             # The shared policy source (published into each host)
├── event-schema.md          # The authoritative event/evidence contract
├── config.example.json      # Config schema with placeholders
├── lib/
│   ├── core.mjs             # Bootstrap, recall, event load/validate, projections
│   ├── layout.mjs           # Role resolution (modern roles + legacy flat keys)
│   ├── lifecycle.mjs        # capture, habit decisions, maintenance
│   ├── checkpoints.mjs      # Durable drain of queued hook checkpoints
│   ├── hooks.mjs            # Per-event hook behaviour
│   ├── preferences.mjs      # Habit rules, candidates, validated JSON block
│   ├── experience.mjs       # Experiences, contexts, promotion rules
│   ├── retention.mjs        # Soft-drop ledger with substance guardrail
│   ├── weight.mjs           # Read-driven weight settlement (ranking only)
│   ├── access-log.mjs       # The one derived log a read may write
│   ├── transport.mjs        # Path safety, atomic JSON, writer locks, Obsidian transport
│   ├── digest.mjs           # Daily digest projection
│   ├── dashboard-*.mjs      # Read models and the preview/execute write handshake
│   ├── storage/             # adapter.mjs, filesystem.mjs, index.mjs (backend factory)
│   ├── search/              # bm25.mjs, tiered-read.mjs, index-bridge.mjs
│   └── ingest/              # Pipeline, sources and history backfill
├── dashboard/
│   ├── app/                 # React + Vite + Ant Design + TanStack Table + ECharts sources
│   └── static/              # Committed production bundle (no build step needed)
├── test/                    # node --test suite
├── scripts/                 # check-syntax.mjs, leak-scan.mjs
├── examples/neutral-vault/  # A tiny example store for inspection
└── vendor/obsidian-mind/    # Vendored MIT helpers (see THIRD_PARTY.md)
```

## License and credits

MIT. See [LICENSE](LICENSE).

Memkeel vendors a small amount of MIT-licensed code from
[`breferrari/obsidian-mind`](https://github.com/breferrari/obsidian-mind) under
`vendor/obsidian-mind/`, with its license preserved. Full attribution — including the frontend
runtime dependencies of the web console — is in [THIRD_PARTY.md](THIRD_PARTY.md).
