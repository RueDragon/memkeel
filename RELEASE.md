# Release and upgrade

How a release is prepared, what has to be true before it goes out, and how an existing installation is
upgraded or rolled back. The checks live in `scripts/release-check.mjs`; this file explains what they
mean and what is deliberately left to a human.

## Fixed: the published package could not run when installed

**`npm install memkeel` used to produce a package whose CLI failed on every command.** The release check
found it on 2026-09-16 and it is fixed. The section is kept because the failure is invisible from a
checkout, and because the tripwire that catches it is worth knowing about.

```
Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: Stripping types is currently unsupported for
files under node_modules, for ".../node_modules/memkeel/vendor/obsidian-mind/session-start.ts"
```

`lib/core.mjs` imports the vendored engine adapter statically:

```js
import { applyInjectionBudget, formatInjectionSize } from '../vendor/obsidian-mind/session-start.ts';
```

Node 22 strips TypeScript types for `.ts` files it is asked to run, *except* under `node_modules`. Since
`memory.mjs` imports `core.mjs`, the restriction applies to every subcommand. Cloning the repository
works, which is why this survived: nothing in the test suite installed the package into a real
`node_modules` directory.

`test/package-install.test.mjs` looks like it covers this and does not. It unpacks the tarball into
`<tmp>/installed/package/` and runs the CLI from there, which is *extraction*, not installation, so the
path is never under `node_modules`. The header comment even states the intent — "if it reached back into
the repository the test would pass while a real install failed" — but extraction still is not
installation.

**Fixed** by generating `.mjs` files from the pinned `.ts` sources with Node's own type stripper
(`scripts/build-vendor.mjs`) and importing those, rather than by rewriting the vendored code by hand —
it is 28 KB of real TypeScript, and hand-editing it would have diverged from the upstream copy
`THIRD_PARTY.md` pins. Using Node's own stripper means the published module is produced by the same
mechanism that was already stripping the types in memory when the program ran from a checkout, so its
behaviour is unchanged by construction; the `.ts` files remain the sources of record, and the generated
files carry a header saying they are generated. They are checked for freshness the same way the dashboard
bundle is, so a vendored update cannot silently go stale.

The check now passes end to end, including installing the tarball into an empty prefix and running the
installed CLI, and `no runtime .ts imports` guards every shipped module rather than the one file that
broke.

**Still open:** `test/package-install.test.mjs` has not been changed to perform a real installation, so
the gap that hid this for so long is still there — it would not catch the next defect of this kind.

## Versioning policy

- The version in `package.json` must have a matching `## [x.y.z]` heading in `CHANGELOG.md`; the release
  check enforces this, because release notes nobody can find are release notes nobody wrote.
- The schema of `config.json` is versioned separately (`configSchema`), deliberately. A release number
  is never rewritten into a schema number, so a migration can be described without inventing a
  `1.0.0 -> 1` mapping.
- Which number to use is a maintainer decision, not a script's. The plan's suggestion, recorded here
  because it is sound: patch releases for security and maintenance fixes, a minor release for new
  configuration or migration features. **This repository is at 1.0.0 and this file does not decide what
  comes next.**

## Pre-release checklist

```bash
node scripts/release-check.mjs          # gates, pack, contents, version, install-and-run, checksum
node scripts/release-check.mjs --fast   # same, without the full test suite
```

It runs the four gates (`check-syntax`, `leak-scan`, `pack-scan`, the test suite), packs the tarball into
a temporary directory so the repository is never written to, asserts the required documents are inside
it and the forbidden ones are not, checks the version against the changelog, installs the tarball into an
empty prefix and runs the installed CLI, and prints the tarball's SHA-256.

The dashboard bundle is part of the artifact, so a release must rebuild it from the tag and commit the
result. `dashboard bundle` in CI already fails when the committed bundle does not match its source; run
`npm run build` in `dashboard/app` and check that `git status` is clean afterwards.

Two things the check deliberately cannot do:

- **It never publishes.** `npm publish` needs the maintainer's credentials and a decision about who owns
  the package name. A verification script that could publish by accident is a liability.
- **It never upgrades an existing installation.** See below.

## Supported platforms

The matrix below is what CI actually exercises on every push, not an aspiration:

| | Node 22 | Node 24 |
| --- | --- | --- |
| Ubuntu | yes | yes |
| macOS | yes | yes |
| Windows | yes | yes |

- Node **>= 22.18** is required (`engines`), because the program uses `fs.statfsSync` and type stripping.
- The filesystem backend needs no external service and no runtime dependencies; `obsidian-cli` is an
  optional backend and needs Obsidian plus its CLI.
- Two permission tests are POSIX-only and skip on Windows with a stated reason. They run on Ubuntu and
  macOS in CI, so a permission regression is still caught — but a Windows-only permission problem would
  not be.

## Breaking changes to state in release notes

Release notes must name these, not bury them:

- **The Codex model list no longer governs the advisory deferral.** Deferral is on by default
  (`hook.codexDeferAdvisory`) and the model lists are deliberately ignored; a store configured with the
  old lists keeps working but the lists no longer change behaviour.
- **Uninstalling requires the installation receipt.** `state/setup-receipt.json` is what makes an
  uninstall put a host configuration back the way it was. A store created before receipts existed
  cannot be uninstalled automatically — the command reports that instead of guessing.
- **Rebinding after a move is a separate step.** `memkeel migrate` copies and repoints the copy; it does
  not touch host bindings. `memkeel setup --check` shows the drift and `memkeel setup` rebinds. Deleting
  the old home is left to the user.
- **`config.json` gained a `collection` section and a `migration` record.** Both are optional; an absent
  `collection` means collect, so an existing store behaves exactly as before.

## Upgrading an existing installation

Public release and upgrading a live memory home are separate operations, in that order.

```bash
# 1. Back up first. The archive is the rollback path.
memkeel backup create --out ~/memkeel-backups/$(date +%F)
memkeel backup verify --dir ~/memkeel-backups/$(date +%F)

# 2. Upgrade the program only. This never touches the store.
npm install -g memkeel@<version>

# 3. Check the store before trusting it.
memkeel doctor
memkeel setup --check        # host bindings still point where they should?
```

Then verify the two things an upgrade actually breaks:

- **Hooks are not duplicated.** `setup --check` reports the binding state; a second `setup` must be
  idempotent. If a host file gained a second copy of the hook entry, `setup --uninstall` (with the
  receipt) then `setup` is the repair.
- **The store did not get crossed with another.** `memkeel doctor` reports the home and store it
  resolved and the routes it loaded. If the wrong store answers, stop and compare
  `memkeel privacy show` output and `doctor`'s `effectiveHome` against what you expect.

### Rollback

1. Reinstall the previous version: `npm install -g memkeel@<previous>`.
2. If configuration was migrated and must be undone, `config migrate --apply` keeps a copy of the exact
   bytes it replaced under `<memory home>/backups/config-migrations/`; restoring that file is the undo.
3. If the store itself must be rolled back, restore the archive into a **new** directory and point
   `MEMKEEL_HOME` at it — a restore never writes over a live store.

## Checksums

`release-check.mjs` prints the tarball's SHA-256 and the contents of `package.json`'s `integrity` field.
Publish both with the release notes. A checksum is only useful if it is recorded somewhere other than
next to the thing it verifies.
