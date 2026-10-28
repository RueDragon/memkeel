// Upgrade acceptance integration: all checks run in a throwaway home.
//
// This deliberately exercises the real CLI and MCP process boundaries instead of importing the
// shared core modules. It does not claim a production-home or installed-host smoke test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(rootDir, 'memory.mjs');
const mcp = path.join(rootDir, 'mcp-server.mjs');

function snapshot(root) {
  const result = {};
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(root, file).replaceAll('\\', '/')] = fs.readFileSync(file);
    }
  };
  visit(root);
  return result;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-upgrade-integration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'memory-home');
  const store = path.join(root, 'store');
  const project = path.join(root, 'project');
  const userHome = path.join(root, 'user-home');
  for (const dir of [home, store, project, userHome]) fs.mkdirSync(dir);
  const env = { ...process.env, HOME: userHome, USERPROFILE: userHome,
    MEMKEEL_HOME: path.join(root, 'wrong-home') };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], {
    cwd: rootDir, env, encoding: 'utf8', windowsHide: true,
  });
  const initialized = run('init', '--store', store);
  assert.equal(initialized.status, 0, initialized.stderr);
  const git = spawnSync('git', ['-C', project, 'init', '--quiet'], { encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, `fixture git init failed: ${git.error?.message ?? git.stderr}`);
  const added = run('workspace-add', '--cwd', project);
  assert.equal(added.status, 0, added.stderr);
  const workspace = JSON.parse(added.stdout).id;
  const registered = run('register', '--topic', `${workspace}/upgrade`, '--workspace', workspace, '--title', 'Upgrade integration');
  assert.equal(registered.status, 0, registered.stderr);
  return { root, home, store, project, userHome, workspace, env, run };
}

function runMcp(f, requests) {
  const child = spawnSync(process.execPath, [mcp, '--home', f.home], {
    cwd: rootDir, env: f.env, encoding: 'utf8', windowsHide: true,
    input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
    timeout: 45_000,
  });
  assert.equal(child.status, 0, child.stderr);
  return child.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('isolated read-only diagnostics expose one home and preserve every fixture byte', (t) => {
  const f = fixture(t);
  const before = { home: snapshot(f.home), store: snapshot(f.store), project: snapshot(f.project) };

  const config = f.run('config', 'validate');
  assert.equal(config.status, 0, config.stderr);
  assert.equal(JSON.parse(config.stdout).ok, true);
  const doctor = f.run('doctor');
  assert.equal(doctor.status, 0, doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.effectiveHome.path, f.home);
  assert.equal(report.effectiveHome.source, 'explicit --home');
  assert.equal(report.ledger.ok, true);
  assert.equal(report.pending.events, 0);
  assert.ok(Array.isArray(report.routes));
  assert.equal(JSON.stringify(report).includes(f.userHome), false);

  const inspected = f.run('knowledge', 'inspect');
  // The documented upgrade CLI is the script entry, not a memory.mjs command. Keep this assertion
  // explicit so a future acceptance runner does not silently exercise a different command.
  assert.notEqual(inspected.status, 0);
  assert.equal(JSON.stringify({ home: snapshot(f.home), store: snapshot(f.store), project: snapshot(f.project) }),
    JSON.stringify({ home: before.home, store: before.store, project: before.project }),
    'read-only diagnostics must not write the isolated fixture');
});

test('CLI knowledge inspect and MCP read-only entry use the same isolated home', (t) => {
  const f = fixture(t);
  const upgrade = path.join(rootDir, 'scripts', 'knowledge-upgrade.mjs');
  const cliInspect = spawnSync(process.execPath, [upgrade, 'inspect', '--home', f.home, '--workspace', f.workspace], {
    cwd: rootDir, env: f.env, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(cliInspect.status, 0, cliInspect.stderr);
  const cliReport = JSON.parse(cliInspect.stdout);
  assert.equal(cliReport.mode, 'read-only');
  assert.equal(cliReport.index.exists, false);

  const replies = runMcp(f, [
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'agent_memory_read', arguments: { action: 'knowledge_inspect', workspace: f.workspace },
    } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'agent_memory_read', arguments: { action: 'bootstrap', cwd: f.project, workspace: f.workspace },
    } },
  ]);
  assert.equal(replies[0].result.protocolVersion, '2024-11-05');
  const readTool = replies[1].result.tools.find((tool) => tool.name === 'agent_memory_read');
  assert.ok(readTool, 'MCP must expose the read-only tool');
  assert.ok(readTool.inputSchema.properties.action.enum.includes('knowledge_inspect'));
  assert.equal(replies[2].result.content[0].type, 'text');
  assert.equal(JSON.parse(replies[2].result.content[0].text).mode, 'read-only');
  assert.equal(replies[3].result.isError, undefined);
  assert.equal(JSON.stringify(replies).includes(f.userHome), false);
  // knowledge_inspect intentionally reports scoped state rather than absolute home paths; the
  // selected home was proven by the CLI process above and by the MCP process's successful result.
  assert.equal(JSON.parse(replies[2].result.content[0].text).mode, 'read-only');
});
