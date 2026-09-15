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
import { sha, atomicJson } from './lib/transport.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
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
// A durable receipt retains the first pre-install bytes and the latest installed
// bytes. Restore refuses changed files instead of overwriting later user edits.
const receiptFile = path.join(memoryHome, 'state', 'setup-receipt.json');
const receipt = fs.existsSync(receiptFile) ? JSON.parse(fs.readFileSync(receiptFile, 'utf8')) : { files: {} };

function writeIfChanged(file, next, label) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (old === next) { report.push({ label, file, changed: false }); return; }
  if (receipt.files[file] && old !== receipt.files[file].after) throw new Error('Configuration changed since setup; review and restore manually before rebinding: ' + file);
  report.push({ label, file, changed: true, mode: dryRun ? 'dry-run' : check ? 'check' : 'write' });
  if (dryRun || check) return;
  wrote = true;
  fs.mkdirSync(backupDir, { recursive: true });
  // The file path is part of the backup name: several files share one label (each dsh
  // profile writes `dsh-hooks-*`), and a colliding name silently reduced the backup to
  // whichever file happened to be written last.
  if (old) fs.writeFileSync(path.join(backupDir, `${label}-${sha(file).slice(0, 8)}${path.extname(file) || '.txt'}`), old, 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== old) throw new Error(`Concurrent edit detected: ${file}`);
  if (!uninstall) {
    receipt.files[file] ??= { before: fs.existsSync(file) ? old : null, label };
    receipt.files[file].after = next;
    atomicJson(receiptFile, receipt);
  }
  fs.writeFileSync(file, next, 'utf8');
  if (fs.readFileSync(file, 'utf8') !== next) throw new Error(`Readback mismatch: ${file}`);
}
function skip(label, reason) { report.push({ label, skipped: true, reason }); }

// ---------------------------------------------------------------- MCP bindings

function codexMcp(file) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
function jsonMcp(file, mutate) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const config = old ? JSON.parse(old) : {};
  const changed = mutate(config);
  if (changed === null) return null;
  return JSON.stringify(config, null, 2) + '\n';
}
function zcodeMcp(file) {
  return jsonMcp(file, (config) => {
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
function claudeMcp(file) {
  return jsonMcp(file, (config) => {
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
function dshMcp(file) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
function hooksJson(file, host, events, zcode = false) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
function dshHookBlock(file) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
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
function policyFileFor(agent, file, policy) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (old.includes(POLICY_START)) {
    if (old.split(POLICY_START).length !== 2 || old.split(POLICY_END).length !== 2 || old.indexOf(POLICY_END) < old.indexOf(POLICY_START)) throw new Error(`Ambiguous policy markers in ${file}`);
    const block = uninstall ? '' : policyBlock(agent, policy);
    return (old.slice(0, old.indexOf(POLICY_START)) + block + old.slice(old.indexOf(POLICY_END) + POLICY_END.length)).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  if (uninstall) return null;
  return `${old.trim()}${old.trim() ? '\n\n' : ''}${policyBlock(agent, policy)}\n`;
}

// ------------------------------------------------------------------ Host table

const HOSTS = {
  codex: {
    label: 'Codex',
    dir: () => process.env.CODEX_HOME ?? path.join(home, '.codex'),
    mcp: (dir) => [{ file: path.join(dir, 'config.toml'), next: codexMcp(path.join(dir, 'config.toml')) }],
    hooks: (dir) => [{ file: path.join(dir, 'hooks.json'), next: hooksJson(path.join(dir, 'hooks.json'), 'codex', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd']) }],
    policy: (dir) => path.join(dir, 'AGENTS.md'),
    legacy: () => null,
  },
  claude: {
    label: 'Claude Code',
    dir: () => process.env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    mcp: () => [{ file: path.join(home, '.claude.json'), next: claudeMcp(path.join(home, '.claude.json')) }],
    hooks: (dir) => [{ file: path.join(dir, 'settings.json'), next: hooksJson(path.join(dir, 'settings.json'), 'claude', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'SessionEnd']) }],
    policy: (dir) => path.join(dir, 'CLAUDE.md'),
    legacy: () => null,
  },
  zcode: {
    label: 'ZCode',
    dir: () => process.env.ZCODE_HOME ?? path.join(home, '.zcode'),
    mcp: (dir) => [{ file: path.join(dir, 'cli', 'config.json'), next: zcodeMcp(path.join(dir, 'cli', 'config.json')) }],
    hooks: (dir) => [{ file: path.join(dir, 'cli', 'config.json'), next: hooksJson(path.join(dir, 'cli', 'config.json'), 'zcode', ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'], true) }],
    policy: (dir) => path.join(dir, 'AGENTS.md'),
    legacy: (dir) => path.join(dir, 'v2', 'setting.json'),
  },
  dsh: {
    label: 'dsh',
    dir: () => process.env.DSH_HOME ?? path.join(home, '.dsh'),
    mcp: (dir) => dshProfiles.filter((profile) => fs.existsSync(path.join(dir, 'profiles', profile, 'cordis.patch.yml')))
      .map((profile) => ({ file: path.join(dir, 'profiles', profile, 'cordis.patch.yml'), next: dshMcp(path.join(dir, 'profiles', profile, 'cordis.patch.yml')) })),
    hooks: (dir) => dshProfiles.filter((profile) => fs.existsSync(path.join(dir, 'profiles', profile, 'cordis.patch.yml')))
      .map((profile) => ({ file: path.join(dir, 'profiles', profile, 'cordis.patch.yml'), next: dshHookBlock(path.join(dir, 'profiles', profile, 'cordis.patch.yml')) })),
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
      const owned = Object.entries(receipt.files).filter(([, row]) => row.label.startsWith(`${id}-`));
      if (!owned.length) throw new Error('No installation receipt; restore legacy backups manually to avoid deleting unowned configuration');
      // Preflight every file before restoring any of this host's configuration.
      for (const [file, row] of owned) {
        const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (current !== row.after && current !== row.before) throw new Error(`Configuration changed since setup; preserve it and restore manually: ${file}`);
      }
      for (const [file, row] of owned) {
        report.push({ label: row.label, file, changed: true, mode: dryRun ? 'dry-run' : check ? 'check' : 'restore' });
        if (dryRun || check) continue;
        if (row.before === null) fs.rmSync(file, { force: true });
        else {
          fs.writeFileSync(file, row.before, 'utf8');
          if (fs.readFileSync(file, 'utf8') !== row.before) throw new Error(`Restore readback mismatch: ${file}`);
        }
        delete receipt.files[file];
        atomicJson(receiptFile, receipt);
      }
      continue;
    }
    for (const { file, next } of host.mcp(dir)) {
      if (next === null) { skip(`${id}-mcp`, 'nothing to do'); continue; }
      writeIfChanged(file, next, `${id}-mcp`);
    }
    if (withHooks) {
      const entries = id === 'dsh' ? [...host.hooks(dir), { file: path.join(memoryHome, 'dsh-hooks.json'), next: hooksJson(path.join(memoryHome, 'dsh-hooks.json'), 'dsh', ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) }] : host.hooks(dir);
      for (const { file, next } of entries) {
        if (next === null) { skip(`${id}-hooks`, 'nothing to do'); continue; }
        writeIfChanged(file, next, `${id}-hooks${entries.length > 1 ? `-${path.basename(path.dirname(path.dirname(file)))}` : ''}`);
      }
    }
    if (withPolicy) {
      const file = host.policy(dir);
      const next = policyFileFor(id, file, policy);
      if (next === null) skip(`${id}-policy`, 'nothing to do');
      else writeIfChanged(file, next, `${id}-policy`);
    }
    // ZCode ships its own memory feature. Leaving it enabled duplicates context, so
    // it is switched off on install; uninstall deliberately does not switch it back on.
    const legacyFile = host.legacy(dir);
    if (legacyFile && !uninstall && fs.existsSync(legacyFile)) {
      const next = jsonMcp(legacyFile, (config) => {
        if (config.memoryEnabled === false) return null;
        config.memoryEnabled = false;
        return true;
      });
      if (next) writeIfChanged(legacyFile, next, `${id}-legacy-memory`);
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

const summary = {
  mode: uninstall ? 'uninstall' : dryRun ? 'dry-run' : check ? 'check' : 'apply',
  memoryHome,
  changed: report.filter((row) => row.changed).length,
  skipped: report.filter((row) => row.skipped).length,
  report,
};
console.log(JSON.stringify(summary, null, 2));
if ((check && summary.changed > 0) || report.some((row) => row.refused)) process.exitCode = 1;
