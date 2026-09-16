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

// ---------------------------------------------------------------- drift, retry, receipts

/** Every file under a directory as relative path -> exact bytes, for a no-write assertion. */
function snapshot(dir) {
  const out = {};
  const walk = (current) => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).replaceAll('\\', '/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** A Codex directory plus a ZCode directory, so one host can fail while another proceeds. */
function multiFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-setup-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const codex = path.join(root, 'codex');
  const zcode = path.join(root, 'zcode');
  fs.mkdirSync(codex);
  fs.mkdirSync(path.join(zcode, 'cli'), { recursive: true });
  const env = { ...process.env, MEMKEEL_HOME: path.join(root, 'wrong-home'), CODEX_HOME: codex, ZCODE_HOME: zcode };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run('init').status, 0);
  return { root, home, codex, zcode, run };
}

test('check reports drift and writes nothing at all', (t) => {
  const { host, home, run } = fixture(t);
  const check = run('setup', '--hosts', 'codex', '--check');
  // Nothing is bound yet, so the check must report drift and fail - without binding it.
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).mode, 'check');
  assert.ok(JSON.parse(check.stdout).changed > 0);
  assert.deepEqual(fs.readdirSync(host), []);
  assert.equal(fs.existsSync(path.join(home, 'state/setup-receipt.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'state/setup.json')), false);
});

test('check after a clean apply reports no drift and still writes nothing', (t) => {
  const { host, home, run } = fixture(t);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const before = snapshot(host);
  const receipt = path.join(home, 'state/setup-receipt.json');
  const receiptBefore = fs.readFileSync(receipt, 'utf8');

  const check = run('setup', '--hosts', 'codex', '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).changed, 0);
  // A check must not rewrite a host file, refresh the receipt or leave a backup behind.
  assert.deepEqual(snapshot(host), before);
  assert.equal(fs.readFileSync(receipt, 'utf8'), receiptBefore);
});

test('a later user edit refuses rebinding, and force cannot bypass that refusal', (t) => {
  const { host, run } = fixture(t);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const config = path.join(host, 'config.toml');
  fs.appendFileSync(config, '\n# later user edit\n');
  const edited = fs.readFileSync(config, 'utf8');

  assert.equal(run('setup', '--hosts', 'codex').status, 1);
  const forced = run('setup', '--hosts', 'codex', '--force');
  assert.equal(forced.status, 1);
  // --force rebinds a conflicting entry, but it must never discard work the user added
  // after the install; only an explicit manual restore may do that.
  assert.match(JSON.stringify(JSON.parse(forced.stdout).report), /changed since setup/);
  assert.equal(fs.readFileSync(config, 'utf8'), edited);
});

test('uninstall without an installation receipt refuses and leaves configuration untouched', (t) => {
  const { host, run } = fixture(t);
  // A binding this install never created, and no receipt to prove ownership of.
  const config = path.join(host, 'config.toml');
  const hooks = path.join(host, 'hooks.json');
  fs.writeFileSync(config, '[mcp_servers.agent_memory]\ncommand = "other"\n');
  fs.writeFileSync(hooks, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command: 'legacy runner' }] }] } }, null, 2));
  const before = { config: fs.readFileSync(config, 'utf8'), hooks: fs.readFileSync(hooks, 'utf8') };

  const result = run('setup', '--hosts', 'codex', '--uninstall');
  assert.equal(result.status, 1);
  assert.match(JSON.stringify(JSON.parse(result.stdout).report), /No installation receipt/);
  assert.equal(fs.readFileSync(config, 'utf8'), before.config);
  assert.equal(fs.readFileSync(hooks, 'utf8'), before.hooks);
});

test('one refusing host does not block the others, and a retry completes it without duplication', (t) => {
  const { home, codex, zcode, run } = multiFixture(t);
  // Codex holds a conflicting binding, so it refuses; ZCode must still be bound.
  fs.writeFileSync(path.join(codex, 'config.toml'), '[mcp_servers.agent_memory]\ncommand = "other"\n');
  const first = run('setup', '--hosts', 'codex,zcode');
  assert.equal(first.status, 1);
  assert.equal(JSON.parse(first.stdout).report.find((row) => row.label === 'codex').refused, true);

  const zcodeConfig = path.join(zcode, 'cli', 'config.json');
  const bound = JSON.parse(fs.readFileSync(zcodeConfig, 'utf8'));
  assert.deepEqual(bound.mcp.servers.agent_memory.args.slice(-2), ['--home', home]);
  const afterFirst = fs.readFileSync(zcodeConfig, 'utf8');

  // Resolve the conflict and retry: the refused host is now bound, the earlier one is not
  // bound twice, and its hook declarations are not duplicated.
  fs.writeFileSync(path.join(codex, 'config.toml'), 'model = "demo"\n');
  const second = run('setup', '--hosts', 'codex,zcode');
  assert.equal(second.status, 0, second.stderr);
  assert.ok(fs.readFileSync(path.join(codex, 'config.toml'), 'utf8').includes(JSON.stringify(home)));
  assert.equal(fs.readFileSync(zcodeConfig, 'utf8'), afterFirst);
  for (const groups of Object.values(bound.hooks.events)) assert.equal(groups.length, 1);
});