import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccessLog } from './access-log.mjs';
import {
  CONFIG_LAYOUT_OPTIONS, CONFIG_NUMBER_FIELDS, CONFIG_ROLE_FIELDS, CONFIG_STORAGE_OPTIONS,
  configFilePath, inspectConfigGroups,
} from './dashboard-actions.mjs';

// Read models for the dashboard. Kept separate from the HTTP layer so the shapes can be
// unit-tested without starting a server.

export function accessLogSummary(config) {
  const log = new AccessLog(config);
  const state = log.load();
  const counts = log.countsSince(null);
  const last = log.lastAccess();
  const byKind = {};
  for (const [key, value] of counts) {
    const kind = key.split('\u0000')[0];
    byKind[kind] = (byKind[kind] ?? 0) + value;
  }
  const top = [...counts.entries()]
    .map(([key, value]) => { const [kind, id] = key.split('\u0000'); return { kind, id, reads: value, lastAccess: last.get(key) ?? null }; })
    .sort((a, b) => b.reads - a.reads)
    .slice(0, 20);
  return { entries: state.entries.length, byKind, top, lastEntryAt: state.entries.at(-1)?.at ?? null };
}

// --- Settings read model -------------------------------------------------------------
//
// Host binding is deliberately CLI-only: it rewrites other applications' config files.
// This reads exactly the files `setup.mjs` writes and reports whether the entry is there,
// so the page can separate "host installed" from "MCP/hooks actually bound" while doing
// nothing itself. Only booleans and paths are reported; file contents are never echoed.

const MCP_SERVER_NAME = 'agent_memory';
const MCP_DSH_MARKER = `id: mcp-${MCP_SERVER_NAME.replace('_', '-')}`;
const HOOK_RUNNER_FILE = 'hook-runner.mjs';
const HOOK_DSH_MARKER = 'AGENT-MEMORY-HOOKS:START';
const MAX_INSPECT_BYTES = 1024 * 1024;
const DSH_PROFILES = ['headless', 'web', 'desktop'];

function dshProfileFiles(dir) {
  return DSH_PROFILES
    .map((profile) => path.join(dir, 'profiles', profile, 'cordis.patch.yml'))
    .filter((file) => fs.existsSync(file));
}

// The host directories mirror setup.mjs. A host counts as installed when its directory
// exists — the same rule `memkeel setup` uses to skip a host.
const HOST_SPECS = [
  {
    id: 'codex',
    label: 'Codex',
    dir: ({ home, env }) => env.CODEX_HOME ?? path.join(home, '.codex'),
    mcp: ({ dir }) => [{ file: path.join(dir, 'config.toml'), marker: `[mcp_servers.${MCP_SERVER_NAME}]` }],
    hooks: ({ dir }) => [{ file: path.join(dir, 'hooks.json'), marker: HOOK_RUNNER_FILE }],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    dir: ({ home, env }) => env.CLAUDE_CONFIG_DIR ?? path.join(home, '.claude'),
    mcp: ({ home }) => [{ file: path.join(home, '.claude.json'), marker: MCP_SERVER_NAME }],
    hooks: ({ dir }) => [{ file: path.join(dir, 'settings.json'), marker: HOOK_RUNNER_FILE }],
  },
  {
    id: 'zcode',
    label: 'ZCode',
    dir: ({ home }) => path.join(home, '.zcode'),
    mcp: ({ dir }) => [{ file: path.join(dir, 'cli', 'config.json'), marker: MCP_SERVER_NAME }],
    hooks: ({ dir }) => [{ file: path.join(dir, 'cli', 'config.json'), marker: HOOK_RUNNER_FILE }],
  },
  {
    id: 'dsh',
    label: 'dsh',
    dir: ({ home, env }) => env.DSH_HOME ?? path.join(home, '.dsh'),
    mcp: ({ dir }) => dshProfileFiles(dir).map((file) => ({ file, marker: MCP_DSH_MARKER })),
    hooks: ({ dir, policyRoot }) => [...dshProfileFiles(dir), path.join(policyRoot, 'dsh-hooks.json')]
      .map((file) => ({ file, marker: HOOK_DSH_MARKER })),
  },
];

// A host config can be large (Claude keeps its history inside ~/.claude.json), so the
// content is read only when it is small; a big file reports `bound: null` = unknown
// rather than being slurped on every settings request.
function inspectBinding({ file, marker }) {
  const row = { path: file, exists: false, size: null, bound: false };
  let stat;
  try { stat = fs.statSync(file); } catch { return row; }
  if (!stat.isFile()) return row;
  row.exists = true;
  row.size = stat.size;
  if (stat.size > MAX_INSPECT_BYTES) { row.bound = null; return row; }
  try { row.bound = fs.readFileSync(file, 'utf8').includes(marker); }
  catch { row.bound = null; }
  return row;
}

function summarizeBindings(files) {
  return {
    present: files.some((row) => row.bound === true),
    unknown: files.some((row) => row.bound === null),
    files,
  };
}

export function hostBindings({ home = os.homedir(), env = process.env, policyRoot = '' } = {}) {
  return HOST_SPECS.map((spec) => {
    const context = { home, env, policyRoot };
    const dir = spec.dir(context);
    const installed = fs.existsSync(dir);
    const withDir = { ...context, dir };
    const mcp = installed ? summarizeBindings(spec.mcp(withDir).map(inspectBinding)) : summarizeBindings([]);
    const hooks = installed ? summarizeBindings(spec.hooks(withDir).map(inspectBinding)) : summarizeBindings([]);
    return { id: spec.id, label: spec.label, dir, installed, mcp, hooks };
  });
}

// Common install locations, checked without running anything. `obsidianCli` is whatever
// the user configured; the rest are the usual places Obsidian itself lands.
const OBSIDIAN_LOCATIONS = [
  ['Windows 当前用户安装', ({ home, env }) => path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Obsidian', 'Obsidian.exe')],
  ['Windows 全局安装', ({ env }) => path.join(env.ProgramFiles ?? 'C:\\Program Files', 'Obsidian', 'Obsidian.exe')],
  ['macOS 应用目录', () => '/Applications/Obsidian.app'],
  ['Linux 系统安装', () => '/usr/bin/obsidian'],
  ['用户本地 bin', ({ home }) => path.join(home, '.local', 'bin', 'obsidian')],
];

function pathObsidian({ env }) {
  const found = [];
  for (const entry of String(env.PATH ?? '').split(path.delimiter)) {
    const dir = entry.trim();
    if (!dir) continue;
    for (const name of ['obsidian.exe', 'obsidian', 'obsidian.cmd']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file) && !found.includes(file)) found.push(file);
    }
  }
  return found.slice(0, 4);
}

export function obsidianStatus(config, { home = os.homedir(), env = process.env } = {}) {
  const configuredPath = String(config?.obsidianCli ?? '').trim();
  const detected = [];
  if (configuredPath) detected.push({ label: '配置里的 obsidianCli', path: configuredPath, exists: fs.existsSync(configuredPath) });
  for (const [label, resolve] of OBSIDIAN_LOCATIONS) {
    const file = resolve({ home, env });
    detected.push({ label, path: file, exists: fs.existsSync(file) });
  }
  for (const file of pathObsidian({ env })) detected.push({ label: 'PATH 中发现的 obsidian', path: file, exists: true });
  return {
    // Obsidian is optional: the filesystem backend needs no external service at all.
    optional: true,
    installed: detected.some((row) => row.exists),
    cli: { path: configuredPath, configured: Boolean(configuredPath), exists: configuredPath ? fs.existsSync(configuredPath) : false },
    detected,
    downloadUrl: 'https://obsidian.md/download',
  };
}

// What has to be restarted after a config write. The CLI and the hook runner re-read the
// config on every invocation; the MCP servers the four hosts keep alive read it once at
// startup. Nothing here restarts anything automatically.
export const RESTART_NOTICE = Object.freeze({
  required: true,
  reason: 'CLI 与 hook runner 每次调用都会重新读取配置；四个宿主里常驻的 MCP 服务只在启动时读一次，'
    + '必须重启宿主进程后才会用上新配置。',
  processes: [
    { id: 'codex', label: 'Codex', service: `${MCP_SERVER_NAME} MCP 服务进程` },
    { id: 'claude', label: 'Claude Code', service: `${MCP_SERVER_NAME} MCP 服务进程` },
    { id: 'zcode', label: 'ZCode', service: `${MCP_SERVER_NAME} MCP 服务进程` },
    { id: 'dsh', label: 'dsh', service: `${MCP_SERVER_NAME} MCP 服务进程（每个已启用的 profile 一个）` },
  ],
  command: 'memkeel setup --check',
  commandHint: '重启宿主后再跑一次，确认 MCP 与 hooks 绑定仍然完整；这条命令只读，不写任何文件。',
  checkoutCommand: 'node setup.mjs',
});

export const SETUP_COMMANDS = Object.freeze({
  apply: 'memkeel setup',
  check: 'memkeel setup --check',
  dryRun: 'memkeel setup --dry-run',
  note: '宿主绑定会改写其他应用的配置文件，因此只能从命令行执行；这里只做只读体检。',
  checkoutFallback: 'node setup.mjs',
});

export function settingsSnapshot(config, { home = os.homedir(), env = process.env } = {}) {
  const file = configFilePath(config);
  // Read the file that is actually on disk: the page is an editor for it, so it must show
  // what the program will read, not a merged view of what the dashboard happened to load.
  let raw = {};
  let readable = true;
  let readError = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { readable = false; readError = error.message; }

  const effective = (key) => (raw[key] !== undefined ? raw[key] : config[key]);
  const effectiveRoles = raw.roles && typeof raw.roles === 'object' ? raw.roles : config.roles ?? {};
  const candidate = {
    storage: effective('storage'),
    memoryRoot: effective('memoryRoot'),
    vaultRoot: effective('vaultRoot'),
    vaultName: effective('vaultName'),
    obsidianCli: effective('obsidianCli'),
    layout: effective('layout'),
    roles: effectiveRoles,
    activeLimit: effective('activeLimit'),
    recentLimit: effective('recentLimit'),
    recentDays: effective('recentDays'),
    budgetBytes: effective('budgetBytes'),
  };
  // Read-only validation: `createRoots: false` means opening this page never creates a
  // directory, while the write path runs the very same checks with creation enabled.
  const { groups, issues, notes } = inspectConfigGroups(candidate, { createRoots: false });

  const known = new Set(Object.keys(groups));
  const preservedKeys = readable ? Object.keys(raw).filter((key) => !known.has(key)) : [];

  return {
    configPath: file,
    policyRoot: config.policyRoot,
    hostHome: home,
    exists: fs.existsSync(file),
    readable,
    readError,
    groups,
    validation: { ok: readable && issues.length === 0, issues, notes },
    preservedKeys,
    roleFields: CONFIG_ROLE_FIELDS.map(([key, label]) => ({ key, label })),
    numberFields: CONFIG_NUMBER_FIELDS.map(([key, label, min, max, hint]) => ({ key, label, min, max, hint })),
    layoutOptions: CONFIG_LAYOUT_OPTIONS.map(([value, label]) => ({ value, label })),
    storageOptions: CONFIG_STORAGE_OPTIONS.map(([value, label]) => ({ value, label })),
    hostBindings: hostBindings({ home, env, policyRoot: config.policyRoot }),
    setup: { ...SETUP_COMMANDS },
    obsidian: obsidianStatus(config, { home, env }),
    restart: { ...RESTART_NOTICE, processes: RESTART_NOTICE.processes.map((row) => ({ ...row })) },
  };
}
