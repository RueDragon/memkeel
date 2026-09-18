#!/usr/bin/env node
// Memkeel host setup.
//
// One entry point that binds the memory system into the agent hosts it finds:
//   1. registers the MCP stdio server,
//   2. installs the native hooks,
//   3. publishes the shared policy block into the host's instruction file.
//
// Usage:
//   memkeel setup [--hosts codex,claude,zcode,dsh] [--dry-run] [--check]
//                 [--no-hooks] [--no-policy] [--uninstall] [--home DIR]
//
// Hosts that are not installed are detected and skipped with an explicit report.
// Every write is backed up, read back, and idempotent: running setup twice changes
// nothing the second time. `--check` never writes and exits non-zero on drift.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha, atomicJson, withLock, writeFilePreservingMode } from './lib/transport.mjs';
import { RECEIPT_FORMAT, describeIntent, dropReceiptEntry, mergeReceiptEntry, readInstallReceipt } from './lib/install-receipt.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
// The receipt records which release wrote it, so a later run can tell an upgrade from a re-run.
const packageVersion = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).version;
const home = os.homedir();
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const value = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

const memoryHome = path.resolve(value('--home') ?? process.env.MEMKEEL_HOME ?? path.join(home, '.memkeel'));
const dryRun = has('--dry-run');
const check = has('--check');
const uninstall = has('--uninstall');
const withHooks = !has('--no-hooks');
const withPolicy = !has('--no-policy');
const allHosts = has('--all-hosts');
const force = has('--force');
const requested = (value('--hosts') ?? 'codex,claude,zcode,dsh').split(',').map((id) => id.trim()).filter(Boolean);

const nodeBin = process.execPath.replaceAll('\\', '/');
const serverPath = path.join(source, 'mcp-server.mjs').replaceAll('\\', '/');
const runnerPath = path.join(source, 'hook-runner.mjs').replaceAll('\\', '/');
const pluginUrl = pathToFileURL(path.join(source, 'dsh-memory-plugin.mjs')).href;
const policyFile = path.join(memoryHome, 'bootstrap.md');
const mcpServerName = 'agent_memory';
const dshProfiles = ['headless', 'web', 'desktop'];
const yaml = (text) => JSON.stringify(text);

const report = [];
const backupDir = path.join(memoryHome, 'backups', `setup-${Date.now()}`);
let wrote = false;
// The receipt, its format and its reader live in lib/install-receipt.mjs, because `doctor` reads
// the same record and the two must agree about what it says.
const previousReceipt = readInstallReceipt(memoryHome);
const receiptFile = previousReceipt.file;
if (previousReceipt.malformed) {
  // The restore chain for files this install already changed lives in that record, so setup will
  // not overwrite one it cannot read: the recorded `before` bytes are the only way back.
  console.error(`setup: the installation receipt is unusable (${receiptFile}): ${previousReceipt.malformed}.\nRepair or remove it deliberately, then run setup again.`);
  process.exit(1);
}
// A receipt written before the format field existed is read as-is and upgraded on the next write.
const legacyReceipt = previousReceipt.legacy;
const receipt = previousReceipt.exists ? { ...previousReceipt, files: { ...previousReceipt.files } } : { files: {} };

// Why the restore is whole-file rather than field-level.
//
// Restoring only the fields we recognise would need a real parser for each host's format - TOML for
// Codex, JSON for Claude and ZCode, YAML for dsh - and this program ships with zero runtime
// dependencies by design. The alternative, cutting a field back out of the document with a regular
// expression, cannot tell a key from a string that looks like one, and a restore that guesses
// boundaries would corrupt the very file it is trying to repair. So the conservative rule stands:
// keep the exact bytes from before the install, restore them only when the file is still in a state
// this install produced, and refuse - for a human to resolve - otherwise.
//
// A dedicated lock root, so this never contends with the memory writer lock: `setup` rewrites other
// applications' files, not the store, and a running checkpoint drain must not block it.
//
// What this lock does and does not cover is worth being exact about, because "setup is serialized"
// would be too strong a claim. It lives inside one memory home, so it serializes the runs that share
// that home - two `setup` runs, or a `setup` and an `--uninstall`, against the same host
// configuration. It does not serialize two *different* memory homes that bind the same host file:
// each takes its own lock, and each keeps its own receipt, so the second one finds bytes the first
// one wrote and refuses them as an unknown state. That case is not made safe here; it needs `--force`
// and a human deciding which home that host should point at. It also does not stop a writer that
// never takes the lock at all, such as a person editing the file or another program rewriting it.
// The transforms are written so that such an edit is refused rather than overwritten, but the lock
// itself is a convention among cooperating runs, not a guarantee against every writer.
const receiptLockRoot = path.join(memoryHome, 'state', 'setup-lock');

/** Write a receipt draft, and keep the in-memory view in step with what is on disk. */
function persistReceipt(draft) {
  atomicJson(receiptFile, draft);
  for (const key of Object.keys(receipt)) delete receipt[key];
  Object.assign(receipt, draft);
}

/**
 * Read the receipt while the setup lock is held, so the decision that follows is made against what is
 * actually on disk.
 *
 * Two concurrent `setup` runs would otherwise each write their whole in-memory copy, and the loser's
 * entries - together with the `before` bytes of files it changed - would be lost. Re-reading inside
 * the lock is what makes the update additive rather than last-writer-wins.
 */
function readReceiptLocked() {
  const current = readInstallReceipt(memoryHome);
  if (current.malformed) throw new Error(`The installation receipt became unreadable during this run (${current.file}): ${current.malformed}`);
  return current;
}

const receiptMeta = () => ({ format: RECEIPT_FORMAT, version: packageVersion, memoryHome, scope: selected });

/**
 * Read-modify-write one host file and its receipt row, under the setup lock.
 *
 * The lock has to cover the read and the decision, not just the receipt write. Two runs of `setup` -
 * or a `setup` racing an `--uninstall` - would otherwise judge the same file from the same stale
 * bytes and then write in either order, which can leave a host file and the receipt disagreeing
 * about what is installed. A competing run now waits, re-reads what the winner actually did, and
 * either finds nothing left to change or refuses a state this install does not own.
 */
function writeIfChanged(file, label, transform) {
  // A dry run and a check both promise not to write, so they must not create the lock directory
  // either; the decision they report is made from the receipt the run already read.
  const write = !dryRun && !check;
  const apply = (current) => {
    const present = fs.existsSync(file);
    const old = present ? fs.readFileSync(file, 'utf8') : '';
    const row = current.files[file];
    // Only an UNKNOWN state is refused. `before` and `after` are both states this install is
    // responsible for, so a file still sitting in its pre-install state is safe to write - and that
    // is what makes an interrupted install recoverable by running setup again. Anything else is
    // someone else's edit and has to be reviewed by hand. This is the same rule the uninstall
    // preflight already applies, so the two paths now agree. A recorded `before` of null means the
    // file did not exist, which is why absence has to be compared as absence and not as ''.
    const matchesBefore = row?.before === null ? !present : old === row?.before;
    if (row && old !== row.after && !matchesBefore) throw new Error('Configuration changed since setup; review and restore manually before rebinding: ' + file);
    // The transform runs here, on the bytes read in this critical section, so an edit that landed
    // before the lock was taken is part of its input instead of being overwritten by content derived
    // from an older read. The guard above still runs first, so a file this install does not own is
    // refused with the same message it always was.
    const next = transform(file, old, present);
    if (next === null) { skip(label, 'nothing to do'); return; }
    if (next === old) { report.push({ label, file, changed: false }); return; }
    report.push({ label, file, changed: true, mode: dryRun ? 'dry-run' : check ? 'check' : 'write' });
    if (!write) return;
    wrote = true;
    fs.mkdirSync(backupDir, { recursive: true });
    // The file path is part of the backup name: several files share one label (each dsh
    // profile writes `dsh-hooks-*`), and a colliding name silently reduced the backup to
    // whichever file happened to be written last.
    if (old) writeFilePreservingMode(path.join(backupDir, `${label}-${sha(file).slice(0, 8)}${path.extname(file) || '.txt'}`), old, { modeFrom: file });
    // The restore chain is recorded BEFORE the file it describes, and that order is the point. A
    // crash between the two writes now leaves the pre-install bytes on disk, so a later run still
    // knows how to undo the install. The opposite order - which is what this used to do - loses them
    // for good, because the file is already written and the next run finds it matching and skips it.
    // That order existed because the guard once accepted only the installed state, so a receipt ahead
    // of the file would have made every later run refuse it; the guard owns both states now.
    persistReceipt(mergeReceiptEntry(current, file, { label, before: present ? old : null, after: next }, receiptMeta()));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== old) throw new Error(`Concurrent edit detected: ${file}`);
    // Replacing a host configuration must keep its permissions: these files can carry credentials,
    // and a rewrite that widened the mode would expose them.
    writeFilePreservingMode(file, next);
    if (fs.readFileSync(file, 'utf8') !== next) throw new Error(`Readback mismatch: ${file}`);
  };
  // The lock is taken only when this run may write. A check that created a lock file would not be
  // the read-only operation it is documented to be.
  if (write) withLock(receiptLockRoot, () => apply(readReceiptLocked()));
  else apply(receipt);
}
function skip(label, reason) { report.push({ label, skipped: true, reason }); }

// -------------------------------------------------------------------- Transform
//
// Every transform below takes the bytes to work from instead of reading them itself, because the
// caller has to read them while it holds the setup lock. Content computed from a read taken *before*
// the lock is content that can overwrite whatever landed in between: the run then writes bytes
// derived from a file state that no longer exists, and an edit that was merely concurrent is silently
// lost. The lock, the guard, the new content and the receipt row all come from one read inside the
// lock.
//
// A transform returns the new file content, or null when this host needs nothing. `uninstall` is
// still consulted, because the same transform describes how to take a binding back out.

function codexMcp(old) {
  const section = `[mcp_servers.${mcpServerName}]`;
  const block = `${section}\ncommand = ${JSON.stringify(nodeBin)}\nargs = ${JSON.stringify([serverPath, '--home', memoryHome])}\nstartup_timeout_sec = 30\n`;
  if (old.includes(section)) {
    const start = old.indexOf(section);
    const rest = old.slice(start + section.length);
    const nextSection = rest.search(/\n\[/);
    const end = nextSection === -1 ? old.length : start + section.length + nextSection + 1;
    if (!uninstall && old.slice(start, end).trim() !== block.trim() && !force) throw new Error('Existing MCP binding differs; use --force after review');
    return uninstall ? `${old.slice(0, start).trimEnd()}\n${old.slice(end).trimStart()}`.trimEnd() + '\n'
      : old.slice(0, start) + block + old.slice(end);
  }
  if (uninstall) return null;
  return `${old.trimEnd()}${old.trim() ? '\n\n' : ''}${block}`;
}
function jsonMcp(old, mutate) {
  const config = old ? JSON.parse(old) : {};
  const changed = mutate(config);
  if (changed === null) return null;
  return JSON.stringify(config, null, 2) + '\n';
}
function zcodeMcp(file, old) {
  return jsonMcp(old, (config) => {
    if (uninstall) {
      if (!config.mcp?.servers?.[mcpServerName]) return null;
      delete config.mcp.servers[mcpServerName];
      return true;
    }
    config.mcp ??= {}; config.mcp.servers ??= {};
    const entry = { type: 'stdio', command: nodeBin, args: [serverPath, '--home', memoryHome], enabled: true };
    const existing = config.mcp.servers[mcpServerName];
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry) && !force) throw new Error(`An existing "${mcpServerName}" MCP server points somewhere else. Re-run with --force to rebind it, or remove it by hand (${file})`);
    config.mcp.servers[mcpServerName] = entry;
    // The host ships its own memory feature; leaving it on duplicates context.
    config.memory = { ...(config.memory ?? {}), use: false };
    config.features = { ...(config.features ?? {}), memory: false };
    return true;
  });
}
function claudeMcp(old) {
  return jsonMcp(old, (config) => {
    config.mcpServers ??= {};
    if (uninstall) {
      if (!config.mcpServers[mcpServerName]) return null;
      delete config.mcpServers[mcpServerName];
      return true;
    }
    const entry = { type: 'stdio', command: nodeBin, args: [serverPath, '--home', memoryHome] };
    const existing = config.mcpServers[mcpServerName];
    if (existing && JSON.stringify(existing) !== JSON.stringify(entry) && !force) throw new Error('Existing MCP binding differs; use --force after review');
    config.mcpServers[mcpServerName] = entry;
    return true;
  });
}
function dshMcp(old) {
  const marker = `id: mcp-agent-memory`;
  const block = `- insert:\n    - id: mcp-agent-memory\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: ${mcpServerName}\n        transport: stdio\n        command: '${nodeBin}'\n        args:\n          - '${serverPath}'\n          - '--home'\n          - ${yaml(memoryHome)}\n`;
  if (old.includes(marker)) {
    if (!uninstall && old.includes(block.trim())) return null;
    // A YAML sequence item is bounded by the next top-level "- " entry.
    const at = old.lastIndexOf('- insert:', old.indexOf(marker));
    const rest = old.slice(at + 1);
    const nextItem = rest.search(/\n- /);
    const end = nextItem === -1 ? old.length : at + 1 + nextItem + 1;
    if (at < 0) throw new Error('Cannot safely locate existing dsh MCP block');
    if (!uninstall && !force) throw new Error('Existing MCP binding differs; use --force after review');
    return `${old.slice(0, at)}${uninstall ? '' : block}${old.slice(end)}`.replace(/\n{3,}/g, '\n\n');
  }
  if (uninstall) return null;
  return old.replace(/^\[\]\s*$/m, '').trimEnd() + '\n' + block;
}

// -------------------------------------------------------------- Hook bindings

function ownsHook(hook) {
  return Boolean(hook?.command?.includes(runnerPath)) || Boolean(Array.isArray(hook?.args) && hook.args.includes(runnerPath));
}
function hookDeclaration(host, zcode) {
  if (zcode) return { type: 'process', command: process.execPath, args: [runnerPath, host, '--home', memoryHome], timeoutMs: 90000 };
  const command = `"${nodeBin}" "${runnerPath}" ${host} --home "${memoryHome}"`;
  if (host === 'codex') return { type: 'command', command, commandWindows: command, async: false, timeoutSec: 90 };
  return { type: 'command', command, timeout: 90 };
}
function hooksJson(file, old, host, events, zcode = false) {
  const config = old ? JSON.parse(old) : {};
  if (zcode) { config.hooks ??= {}; config.hooks.enabled ??= true; config.hooks.events ??= {}; }
  else config.hooks ??= {};
  if (host === 'codex' && config.disableAllHooks) throw new Error(`Hooks are explicitly disabled in ${file}`);
  const table = zcode ? config.hooks.events : config.hooks;
  let touched = false;
  for (const event of events) {
    const groups = Array.isArray(table[event]) ? table[event] : [];
    const retained = groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !ownsHook(hook)) })).filter((group) => group.hooks.length);
    const next = uninstall ? retained : [...retained, { hooks: [hookDeclaration(host, zcode)] }];
    if (JSON.stringify(next) !== JSON.stringify(groups)) touched = true;
    if (next.length) table[event] = next; else delete table[event];
  }
  if (!touched) return null;
  return JSON.stringify(config, null, 2) + '\n';
}
function dshHookBlock(file, old) {
  const start = '# AGENT-MEMORY-HOOKS:START'; const end = '# AGENT-MEMORY-HOOKS:END';
  const block = `${start}\n- insert:\n    - id: agent-memory-hooks\n      name: '${pluginUrl}'\n      config:\n        runner: '${runnerPath}'\n        memoryHome: ${yaml(memoryHome)}\n        timeoutMs: 90000\n${end}`;
  if (old.includes(start)) {
    if (old.split(start).length !== 2 || !old.includes(end) || old.split(end).length !== 2) throw new Error(`Ambiguous dsh hook markers in ${file}`);
    const stripped = old.slice(0, old.indexOf(start)) + old.slice(old.indexOf(end) + end.length);
    return uninstall ? stripped.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n' : old.slice(0, old.indexOf(start)) + block + old.slice(old.indexOf(end) + end.length);
  }
  if (uninstall) return null;
  return old.trimEnd() + '\n\n' + block + '\n';
}

// ------------------------------------------------------------ Policy binding

const POLICY_START = '<!-- AGENT-POLICY:START -->';
const POLICY_END = '<!-- AGENT-POLICY:END -->';
function policyBlock(agent, policy) {
  const body = agent === 'claude' ? `@${policyFile.replaceAll('\\', '/')}` : policy;
  return `${POLICY_START}\nSource: ${policyFile.replaceAll('\\', '/')}; sha256: ${sha(policy)}; adapter: ${agent}.\n${body}\n${POLICY_END}`;
}
function policyFileFor(agent, file, policy, old) {
  if (old.includes(POLICY_START)) {
    if (old.split(POLICY_START).length !== 2 || old.split(POLICY_END).length !== 2 || old.indexOf(POLICY_END) < old.indexOf(POLICY_START)) throw new Error(`Ambiguous policy markers in ${file}`);
    const block = uninstall ? '' : policyBlock(agent, policy);
    return (old.slice(0, old.indexOf(POLICY_START)) + block + old.slice(old.indexOf(POLICY_END) + POLICY_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  if (uninstall) return null;
  return `${old.trim()}${old.trim() ? '\n\n' : ''}${policyBlock(agent, policy)}\n`;
}

// ------------------------------------------------------------------ Host table
//
// A host reports the files it owns together with the transform that produces each file's new content.
// The transform is a function, not a value: it runs inside the setup lock on the bytes that are on
// disk at that moment. Computing the content here, where the table is read, is what let a concurrent
// edit be overwritten - the run would hold content derived from a file it had not yet taken the lock
// for. ZCode in particular binds two things into one file (`cli/config.json` for both the MCP server
// and the hooks), and each of those transforms now reads what the previous one committed.

const HOSTS = {
  codex: {
    label: 'Codex',
    dir: () => process.env.CODEX_HOME ?? path.join(home, '.codex'),
    mcp: (dir) => [{ file: path.join(dir, 'config.toml'), transform: (file, old) => codexMcp(old) }],
    hooks: (dir) => [{ file: path.join(dir, 'hooks.json'), transform: (file, old) => hooksJson(file, old, 'codex', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd']) }],
    policy: (dir) => path.join(dir, 'AGENTS.md'),
    legacy: () => null,
  },
  claude: {
    label: 'Claude Code',
    dir: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    mcp: () => [{ file: path.join(home, '.claude.json'), transform: (file, old) => claudeMcp(old) }],
    hooks: (dir) => [{ file: path.join(dir, 'settings.json'), transform: (file, old) => hooksJson(file, old, 'claude', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'SessionEnd']) }],
    policy: (dir) => path.join(dir, 'CLAUDE.md'),
    legacy: () => null,
  },
  zcode: {
    label: 'ZCode',
    dir: () => process.env.ZCODE_HOME ?? path.join(home, '.zcode'),
    mcp: (dir) => [{ file: path.join(dir, 'cli', 'config.json'), transform: (file, old) => zcodeMcp(file, old) }],
    hooks: (dir) => [{ file: path.join(dir, 'cli', 'config.json'), transform: (file, old) => hooksJson(file, old, 'zcode', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'], true) }],
    policy: (dir) => path.join(dir, 'AGENTS.md'),
    legacy: (dir) => path.join(dir, 'v2', 'setting.json'),
  },
  dsh: {
    label: 'dsh',
    dir: () => process.env.DSH_HOME ?? path.join(home, '.dsh'),
    mcp: (dir) => dshProfiles.filter((profile) => fs.existsSync(path.join(dir, 'profiles', profile, 'cordis.patch.yml')))
      .map((profile) => ({ file: path.join(dir, 'profiles', profile, 'cordis.patch.yml'), transform: (file, old) => dshMcp(old) })),
    hooks: (dir) => dshProfiles.filter((profile) => fs.existsSync(path.join(dir, 'profiles', profile, 'cordis.patch.yml')))
      .map((profile) => ({ file: path.join(dir, 'profiles', profile, 'cordis.patch.yml'), transform: (file, old) => dshHookBlock(file, old) })),
    policy: (dir) => path.join(dir, 'AGENTS.md'),
    legacy: () => null,
  },
};

// ------------------------------------------------------------------- Execution

let policy = '';
if (withPolicy && !uninstall) {
  if (!fs.existsSync(policyFile)) throw new Error(`Missing shared policy: ${policyFile}. Run \`memkeel init\` first.`);
  policy = fs.readFileSync(policyFile, 'utf8').trim();
}

const selected = allHosts ? Object.keys(HOSTS) : requested;
for (const id of selected) {
  const host = HOSTS[id];
  if (!host) { report.push({ label: id, refused: true, reason: 'unknown host id' }); continue; }
  const dir = host.dir();
  if (!fs.existsSync(dir)) { skip(id, `not installed (${dir})`); continue; }
  // One host refusing (for example an existing MCP entry that points somewhere else)
  // must not abort the remaining hosts; it is reported instead.
  try {
    if (uninstall) {
      // The preflight and the restores belong to one critical section. A competing install that wrote
      // between them would otherwise be judged against bytes that are already stale, and the row it
      // recorded in that window could be dropped by a restore that never saw it - leaving the file
      // installed with nothing recording how to restore it.
      const write = !dryRun && !check;
      const restore = (current) => {
        const owned = Object.entries(current.files).filter(([, row]) => row.label.startsWith(`${id}-`));
        if (!owned.length) throw new Error('No installation receipt; restore legacy backups manually to avoid deleting unowned configuration');
        // Preflight every file before restoring any of this host's configuration.
        for (const [file, row] of owned) {
          const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
          if (onDisk !== row.after && onDisk !== row.before) throw new Error(`Configuration changed since setup; preserve it and restore manually: ${file}`);
        }
        let draft = current;
        for (const [file, row] of owned) {
          report.push({ label: row.label, file, changed: true, mode: dryRun ? 'dry-run' : check ? 'check' : 'restore' });
          if (!write) continue;
          if (row.before === null) fs.rmSync(file, { force: true });
          else {
            // Restoring must also keep the permissions the file had before the install.
            writeFilePreservingMode(file, row.before);
            if (fs.readFileSync(file, 'utf8') !== row.before) throw new Error(`Restore readback mismatch: ${file}`);
          }
          draft = dropReceiptEntry(draft, file, receiptMeta());
          persistReceipt(draft);
        }
      };
      if (write) withLock(receiptLockRoot, () => restore(readReceiptLocked()));
      else restore(receipt);
      continue;
    }
    for (const { file, transform } of host.mcp(dir)) writeIfChanged(file, `${id}-mcp`, transform);
    if (withHooks) {
      const entries = host.hooks(dir);
      // dsh keeps its own hook declarations in a file inside the memory home, which is not part of
      // the host's own directory tree.
      if (id === 'dsh') entries.push({ file: path.join(memoryHome, 'dsh-hooks.json'), transform: (file, old) => hooksJson(file, old, 'dsh', ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) });
      for (const { file, transform } of entries) {
        writeIfChanged(file, `${id}-hooks${entries.length > 1 ? `-${path.basename(path.dirname(path.dirname(file)))}` : ''}`, transform);
      }
    }
    if (withPolicy) {
      writeIfChanged(host.policy(dir), `${id}-policy`, (file, old) => policyFileFor(id, file, policy, old));
    }
    // ZCode ships its own memory feature. Leaving it enabled duplicates context, so it is switched
    // off on install. Uninstall restores the recorded bytes, so the host's own setting returns to
    // whatever the user had before we ever touched the file - we never replay our own preference.
    const legacyFile = host.legacy(dir);
    if (legacyFile && !uninstall && fs.existsSync(legacyFile)) {
      writeIfChanged(legacyFile, `${id}-legacy-memory`, (file, old, present) => (present ? jsonMcp(old, (config) => {
        if (config.memoryEnabled === false) return null;
        config.memoryEnabled = false;
        return true;
      }) : null));
    }
  } catch (error) {
    report.push({ label: id, refused: true, reason: error.message });
  }
}

if (!dryRun && !check && !uninstall) {
  atomicJson(path.join(memoryHome, 'state', 'setup.json'), {
    at: new Date().toISOString(),
    memoryHome,
    scope: selected,
    hooks: withHooks,
    policy: withPolicy,
    backupDir: wrote ? backupDir : null,
    server: serverPath,
    report,
  });
}

const changedCount = report.filter((row) => row.changed).length;
const summary = {
  mode: uninstall ? 'uninstall' : dryRun ? 'dry-run' : check ? 'check' : 'apply',
  // Which of the five operations this actually is, named rather than left to be inferred from a
  // changed-file count.
  intent: describeIntent({
    mode: uninstall ? 'uninstall' : dryRun ? 'dry-run' : check ? 'check' : 'apply',
    receipt: previousReceipt,
    changed: changedCount,
    home: memoryHome,
    version: packageVersion,
    forced: force,
  }),
  memoryHome,
  // The restore chain is reported, not just maintained: a legacy or malformed receipt is exactly
  // what makes a later uninstall fail closed, so the user should see it before that happens.
  receipt: {
    file: receiptFile,
    exists: previousReceipt.exists,
    format: receipt.format ?? null,
    version: receipt.version ?? null,
    legacy: legacyReceipt,
    files: Object.keys(receipt.files).length,
  },
  changed: changedCount,
  skipped: report.filter((row) => row.skipped).length,
  report,
};
console.log(JSON.stringify(summary, null, 2));
if ((check && summary.changed > 0) || report.some((row) => row.refused)) process.exitCode = 1;
