import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'custom home');
  const host = path.join(root, 'codex');
  fs.mkdirSync(host);
  const env = { ...process.env, MEMKEEL_HOME: path.join(root, 'wrong-home'), CODEX_HOME: host };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run('init').status, 0);
  return { root, home, host, run };
}
test('custom home survives setup, repeated setup and exact uninstall', (t) => {
  const { home, host, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  assert.ok(fs.readFileSync(config, 'utf8').includes(JSON.stringify(home)));
  const hooks = JSON.parse(fs.readFileSync(path.join(host, 'hooks.json'), 'utf8'));
  assert.ok(hooks.hooks.PreToolUse[0].hooks[0].command.includes(home));
  const second = run('setup', '--hosts', 'codex');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).changed, 0);
  assert.equal(run('setup', '--hosts', 'codex', '--uninstall').status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(host, 'hooks.json')), false);
});
test('refused binding fails and CLI force is forwarded', (t) => {
  const { host, run } = fixture(t);
  fs.writeFileSync(path.join(host, 'config.toml'), '[mcp_servers.agent_memory]\ncommand = "other"\n');
  assert.equal(run('setup', '--hosts', 'codex').status, 1);
  assert.equal(run('setup', '--hosts', 'codex', '--force').status, 0);
});
test('uninstall preserves later user changes', (t) => {
  const { host, run } = fixture(t);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const config = path.join(host, 'config.toml');
  fs.appendFileSync(config, '\n# later user edit\n');
  const edited = fs.readFileSync(config, 'utf8');
  assert.equal(run('setup', '--hosts', 'codex', '--uninstall').status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), edited);
});
test('dry-run writes no host binding or receipt', (t) => {
  const { host, home, run } = fixture(t);
  assert.equal(run('setup', '--hosts', 'codex', '--dry-run').status, 0);
  assert.deepEqual(fs.readdirSync(host), []);
  assert.equal(fs.existsSync(path.join(home, 'state/setup-receipt.json')), false);
});
test('ZCode setup and uninstall restore native memory settings', (t) => {
  const { root, home } = fixture(t);
  const host = path.join(root, 'zcode');
  fs.mkdirSync(path.join(host, 'cli'), { recursive: true });
  fs.mkdirSync(path.join(host, 'v2'));
  const file = path.join(host, 'cli/config.json');
  const legacy = path.join(host, 'v2/setting.json');
  const before = JSON.stringify({ memory: { use: true }, features: { memory: true }, other: 42 });
  fs.writeFileSync(file, before);
  fs.writeFileSync(legacy, '{"memoryEnabled":true}');
  const run = (...args) => spawnSync(process.execPath, [cli, 'setup', '--hosts', 'zcode', '--home', home, ...args], {
    env: { ...process.env, ZCODE_HOME: host }, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(run().status, 0);
  const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(installed.memory.use, false);
  assert.deepEqual(installed.mcp.servers.agent_memory.args.slice(-2), ['--home', home]);
  assert.equal(run().status, 0);
  assert.equal(run('--uninstall').status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"memoryEnabled":true}');
});