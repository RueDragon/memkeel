# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | :white_check_mark: |
| < 1.0 | :x: |

This project is pre-1.1 and moves fast. Security fixes are applied to the latest 1.x release
only; please reproduce on the newest tag before reporting.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub Security Advisories:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, the affected version or commit, and the steps to reproduce.

If you are working from a fork or cannot use the Security tab, contact a maintainer directly
rather than filing a public issue.

What to expect:

- An acknowledgement, normally within a few days.
- An assessment of severity and scope, and whether a fix is warranted.
- Credit in the advisory and release notes if you would like it.

Because Memkeel is a local-first tool, most real-world impact depends on the reporter's
machine, not on a shared service. That makes clear reproduction steps far more valuable than a
severity label, so please include the exact commands and the store layout involved.

## Threat model

Memkeel is a **single-user, local-first** system. It is not a multi-tenant service and does not
try to be one. The model below states what it does and does not protect.

### The store is local plaintext Markdown

Memory is stored as ordinary Markdown files in a folder you choose. There is no encryption at
rest, no password, and no access control layer of its own.

- Anyone who can read the folder can read every memory.
- Anyone who can write the folder can corrupt or forge it.
- Protection is whatever the operating system and disk provide: file permissions, full-disk
  encryption, account isolation.

Treat the store with the same care as your shell history or your notes app, and keep it out of
shared, synced or public locations.

### The memory tools expose no shell and no arbitrary file writes

The MCP server deliberately offers two narrowly-scoped tools:

- `agent_memory_read` is read-only by construction: its action list contains no write action,
  and the server rejects a write action presented to it.
- `agent_memory` writes only through the event path — `capture`, `record`, `consolidate`,
  `maintenance`, `register`, `habit_decide`.

Neither tool provides generic command execution, a shell, or an arbitrary file-write primitive.
Path handling resolves every store-relative path against the configured root and **rejects
paths that escape it**, including through a symlink (`lib/transport.mjs`). The tools also do not
disable or weaken the host's own sandbox, approvals or permission prompts.

Two consequences worth stating plainly:

- A prompt-injected or malicious agent can still write *memory content* through the allowed
  write actions. Memory is evidence, not authority, and is treated as data rather than
  instructions — but a poisoned memory can mislead a later session. Review what your agents
  record.
- The dashboard's write actions run against the same event path, so the console inherits these
  limits rather than widening them.

### The web console binds to loopback only

`dashboard.mjs` listens on `127.0.0.1` and renders local projections. There is **no
authentication**, in the deliberate expectation that only the same machine can reach it.

A loopback bind alone is not sufficient protection, so every request is also refused unless its
`Host` header names loopback (`127.0.0.1`, `localhost` or `::1`); an `Origin` header, when one is
present, must name loopback as well.

- The `Host` check defeats DNS rebinding, where a hostile page makes the browser treat the
  attacker's domain as same-origin with `127.0.0.1`.
- The `Origin` check defeats a cross-origin POST, which can still land as a side effect even when
  its response cannot be read. Requests with no `Origin` header at all (curl, scripts, the test
  suite) keep working.
- Do not expose the port through a reverse proxy, tunnel, container port publish or LAN bind.
- If you run it in a container, keep the mapping on the host loopback interface.
- Writes from the console require a two-step preview/execute handshake whose token is bound to
  the current store state, so a stale or replayed review fails closed instead of writing.

### Hooks capture automatically

Native hooks record bounded, redacted checkpoints at session end and prompt boundaries, which
means **content is written to memory without an explicit per-write confirmation**. This is the
intended design — it is what makes memory survive a session — and it is also the main reason
not to type secrets into an agent session.

- A prompt that says not to record suppresses checkpoint capture for that turn.
- Checkpoint text is redacted and truncated before it is written.
- Every checkpoint is an ordinary event: it lands in the journal, is reviewable, and can be
  dropped from projections through the retention ledger.

### Secrets must never be written to memory

**Do not put credentials, tokens, private keys, passwords or raw sensitive logs into memory.**
The store is plaintext and designed to be read by agents.

Memkeel defends in depth — capture and record reject recognizable credential shapes, output
redaction covers hook output, bootstrap, recall and checkpoint writes — but redaction is
pattern-based and therefore **best effort, not a guarantee**. A secret that does not match a
known shape will be stored. Do not rely on the filter.

If a secret does land in the store: rotate it first, then remove it from the affected notes and
from your backups. Remember that history is the point of this system — an event you "fixed"
still exists in the journal and in any snapshot or clone of it.

## The leak gate

`npm run leak-scan` checks generic private-path and credential patterns, including its
own source. Maintainer-specific literal terms belong in an external JSON array referenced
by `MEMKEEL_LEAK_TERMS_FILE`, never in public source. Match values are not printed.
The gate is best effort: review history, commit metadata, binary assets and distribution
artifacts separately. A clean result does not prove the absence of personal information.

Setup receipts and backups contain original host configuration and may include credentials.
Keep the memory home private and outside source control. Uninstall restores receipt-backed
files only when no later user changes would be overwritten; legacy backups require review.