import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withLock } from '../lib/transport.mjs';
const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
// A synchronous sleep, so a test can hold the setup lock while a spawned run is given time to reach
// it. Atomics.wait blocks this process only; the child is a separate process and keeps running.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
/** Start a run without waiting for it, so the caller can watch what it does while it is blocked. */
function spawnRun(args, env, home) {
  const state = { code: null, stderr: '' };
  const child = spawn(process.execPath, [cli, ...args, '--home', home], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  child.on('close', (code) => { state.code = code; });
  return state;
}
async function settled(state, ms = 30000) {
  const deadline = Date.now() + ms;
  while (state.code === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(state.code, null, 'the spawned run did not finish');
  return state.code;
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'custom home');
  const host = path.join(root, 'codex');
  fs.mkdirSync(host);
  const env = { ...process.env, MEMKEEL_HOME: path.join(root, 'wrong-home'), CODEX_HOME: host };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run('init').status, 0);
  return { root, home, host, env, run };
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
  return { root, home, codex, zcode, env, run };
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

// ------------------------------------------------------- install receipt (DEP-02)

/** The durable restore chain: per file, the pre-install bytes and the latest installed bytes. */
function receiptOf(home) {
  return JSON.parse(fs.readFileSync(path.join(home, 'state/setup-receipt.json'), 'utf8'));
}

test('an interrupted install is recoverable by running setup again', (t) => {
  const { host, home, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const installed = fs.readFileSync(config, 'utf8');
  const row = receiptOf(home).files[config];
  assert.equal(row.before, original, 'the receipt must keep the first pre-install bytes');

  // A crash between the file write and the receipt write, or a hand-restored file, leaves the
  // file in its pre-install state. That is a state this install owns, so writing again is safe;
  // refusing it would brick the binding until someone edited the receipt by hand.
  fs.writeFileSync(config, original, 'utf8');
  const again = run('setup', '--hosts', 'codex');
  assert.equal(again.status, 0, again.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), installed);
});

test('the receipt is versioned and records the home and scope it belongs to', (t) => {
  const { host, home, run } = fixture(t);
  fs.writeFileSync(path.join(host, 'config.toml'), 'model = "demo"\n');
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const receipt = receiptOf(home);
  assert.equal(receipt.format, 1);
  assert.equal(receipt.memoryHome, home);
  assert.deepEqual(receipt.scope, ['codex']);
  assert.match(receipt.at, /^\d{4}-\d\d-\d\dT/);
  assert.ok(Object.keys(receipt.files).length > 0);
});

test('a receipt from before the format field is reported and still restores', (t) => {
  const { host, home, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex').status, 0);

  const receiptPath = path.join(home, 'state/setup-receipt.json');
  const legacy = receiptOf(home);
  delete legacy.format; delete legacy.memoryHome; delete legacy.scope; delete legacy.at;
  fs.writeFileSync(receiptPath, JSON.stringify(legacy, null, 2));

  const check = run('setup', '--hosts', 'codex', '--check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).receipt.legacy, true);
  assert.equal(JSON.parse(check.stdout).receipt.format, null);

  // The restore chain is the recorded bytes, not the format field, so uninstall still works.
  assert.equal(run('setup', '--hosts', 'codex', '--uninstall').status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
});

test('a malformed receipt is refused instead of being silently overwritten', (t) => {
  const { home, run } = fixture(t);
  const receiptPath = path.join(home, 'state', 'setup-receipt.json');
  const broken = JSON.stringify({ files: ['not-an-object'] });
  fs.writeFileSync(receiptPath, broken);
  const result = run('setup', '--hosts', 'codex');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installation receipt is unusable/);
  // A clean refusal, not a stack trace a user cannot act on.
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(fs.readFileSync(receiptPath, 'utf8'), broken, 'the unreadable record is preserved for inspection');
});

test('doctor reports the effective home and the receipt state', (t) => {
  const { host, home, run } = fixture(t);
  fs.writeFileSync(path.join(host, 'config.toml'), 'model = "demo"\n');
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const doctor = run('doctor');
  assert.equal(doctor.status, 0, doctor.stdout);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.effectiveHome.path, home);
  assert.equal(report.effectiveHome.source, 'explicit --home');
  assert.equal(report.receipt.exists, true);
  assert.equal(report.receipt.format, 1);
  assert.equal(report.receipt.legacy, false);
  assert.ok(report.receipt.files > 0);
});

test('an unreadable receipt makes doctor unhealthy', (t) => {
  const { home, run } = fixture(t);
  fs.writeFileSync(path.join(home, 'state', 'setup-receipt.json'), '{ not json');
  const doctor = run('doctor');
  assert.equal(doctor.status, 1);
  assert.match(JSON.parse(doctor.stdout).receipt.malformed, /JSON/);
});

test('doctor reports the recorded bindings and the launcher it depends on', (t) => {
  const { host, home, run } = fixture(t);
  fs.writeFileSync(path.join(host, 'config.toml'), 'model = "demo"\n');
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const report = JSON.parse(run('doctor').stdout);
  assert.equal(report.bindingDrift.status, 'ok');
  assert.equal(report.bindingDrift.expected, home);
  assert.equal(report.bindingDrift.bound, home);
  assert.equal(report.launcher.ok, true);
  // The launcher and the three scripts a binding invokes are all checked by name.
  assert.deepEqual(report.launcher.checks.map((check) => check.label), ['launcher', 'mcp-server.mjs', 'hook-runner.mjs', 'dsh-memory-plugin.mjs']);
});

test('doctor reports drift when the receipt was bound to another memory home', (t) => {
  const { host, home, root, run } = fixture(t);
  fs.writeFileSync(path.join(host, 'config.toml'), 'model = "demo"\n');
  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  const receiptPath = path.join(home, 'state', 'setup-receipt.json');
  const receipt = receiptOf(home);
  receipt.memoryHome = path.join(root, 'an-older-home');
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));

  const report = JSON.parse(run('doctor').stdout);
  assert.equal(report.bindingDrift.status, 'drift');
  assert.equal(report.bindingDrift.bound, path.join(root, 'an-older-home'));
  // Drift is reported, not fatal: the store itself is fine, it is the host bindings that are stale.
  assert.equal(report.receipt.malformed, null);
});

test('setup names the operation it is performing', (t) => {
  const { host, home, root, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  fs.writeFileSync(config, 'model = "demo"\n');

  assert.equal(JSON.parse(run('setup', '--hosts', 'codex').stdout).intent.kind, 'first-install');
  assert.equal(JSON.parse(run('setup', '--hosts', 'codex').stdout).intent.kind, 'no-change');

  // A receipt recording a different release is an upgrade, and one recording a different home is
  // a rebind - both are named even when no file needs changing, because they change what the run
  // means rather than only what it writes.
  const receiptPath = path.join(home, 'state', 'setup-receipt.json');
  const upgraded = receiptOf(home);
  upgraded.version = '0.0.1';
  fs.writeFileSync(receiptPath, JSON.stringify(upgraded, null, 2));
  const upgrade = JSON.parse(run('setup', '--hosts', 'codex', '--check').stdout).intent;
  assert.equal(upgrade.kind, 'upgrade');
  assert.equal(upgrade.from, '0.0.1');

  const moved = receiptOf(home);
  moved.version = upgrade.to; // same release, so the moved home is the only condition
  moved.memoryHome = path.join(root, 'elsewhere');
  fs.writeFileSync(receiptPath, JSON.stringify(moved, null, 2));
  assert.equal(JSON.parse(run('setup', '--hosts', 'codex', '--check').stdout).intent.kind, 'rebind');

  assert.equal(JSON.parse(run('setup', '--hosts', 'codex', '--uninstall').stdout).intent.kind, 'uninstall');
});

test('rewriting a host config keeps its permissions', { skip: process.platform === 'win32' ? 'Windows reports a synthesised mode and chmod only toggles the read-only bit, so a 0600 assertion cannot hold there; the same path runs on Linux and macOS in CI' : false }, (t) => {
  const { host, home, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  fs.writeFileSync(config, 'token = "secret"\n', { mode: 0o600 });
  fs.chmodSync(config, 0o600);
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);

  assert.equal(run('setup', '--hosts', 'codex').status, 0);
  // Host configuration can carry credentials; binding it must not widen who can read it.
  assert.equal(fs.statSync(config).mode & 0o777, 0o600);

  // The pre-install backup holds the same bytes, so it must not be more readable than the original.
  const backupRoot = path.join(home, 'backups');
  const [dir] = fs.readdirSync(backupRoot).filter((name) => name.startsWith('setup-'));
  const [backup] = fs.readdirSync(path.join(backupRoot, dir));
  assert.equal(fs.readFileSync(path.join(backupRoot, dir, backup), 'utf8'), 'token = "secret"\n');
  assert.equal(fs.statSync(path.join(backupRoot, dir, backup)).mode & 0o777, 0o600);
});

test('two concurrent setups both keep their receipt entries', async (t) => {
  const { home, env } = multiFixture(t);
  const runSetup = (hosts) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'setup', '--hosts', hosts, '--home', home], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });

  // Both processes read the receipt, rewrite host files and record what they did. Writing each
  // one's own in-memory copy would lose the other's entries - and with them the pre-install bytes
  // that are the only way to restore those files.
  const results = await Promise.all([runSetup('codex'), runSetup('zcode')]);
  const codes = results.map((row) => row.code);
  // This test exists to catch a concurrent setup failing, and that failure is intermittent: it
  // happened once on a Windows CI runner and did not reproduce in twelve local runs. The child's own
  // message is the only thing that says why it failed, so it is carried into the assertion instead of
  // being discarded - with stdio: 'ignore' a failure here said nothing at all.
  assert.deepEqual(codes, [0, 0], results.map((row) => row.stderr.trim()).filter(Boolean).join('\n---\n'));

  const files = Object.keys(receiptOf(home).files);
  assert.ok(files.some((file) => file.includes('codex')), `no codex entry in ${JSON.stringify(files)}`);
  assert.ok(files.some((file) => file.includes('zcode')), `no zcode entry in ${JSON.stringify(files)}`);
});

test('a host file that cannot be written still leaves its restore chain recorded', (t) => {
  const { host, home, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  // The write fails at exactly the point an interruption would land: after the restore chain is
  // recorded and before the host file is replaced. With the other order the host file was written
  // first, so a failure here left our content in it with no `before` bytes recorded anywhere - and a
  // re-run then skipped the file because it already matched, dropping the only way to restore the
  // user's own configuration. Nothing about that loss was visible.
  fs.chmodSync(config, 0o444);
  try {
    const result = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy');
    assert.notEqual(result.status, 0, 'a host file that cannot be written must fail the run');
    assert.equal(fs.readFileSync(config, 'utf8'), original, 'the host file must be left as it was');

    const receiptFile = path.join(home, 'state', 'setup-receipt.json');
    assert.equal(fs.existsSync(receiptFile), true, 'the restore chain must be recorded before the file it describes');
    const row = JSON.parse(fs.readFileSync(receiptFile, 'utf8')).files[config];
    assert.ok(row, 'a failure between the two writes must not lose the restore chain');
    assert.equal(row.before, original);
    assert.match(row.after, /mcp_servers\.agent_memory/);
  } finally {
    // The failure above is a read-only bit; clearing it is what lets the fixture clean up.
    fs.chmodSync(config, 0o644);
  }
});

test('a setup waits for the setup lock instead of writing a host file under a live holder', async (t) => {
  const { host, home, env } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  const state = spawnRun(['setup', '--hosts', 'codex'], env, home);

  // Hold the lock the setup path itself has to take before it may rewrite a host file. A run that
  // writes anyway is the interleaving that lets a competing run judge a file it does not own yet:
  // two runs could each read the receipt and the host file, write, and record, in either order.
  withLock(path.join(home, 'state', 'setup-lock'), () => {
    sleepSync(1200);
    assert.equal(fs.readFileSync(config, 'utf8'), original, 'a host file must not be written while another holder has the setup lock');
    assert.equal(state.code, null, 'the second run must be waiting for the lock, not already finished');
  });

  assert.equal(await settled(state), 0, state.stderr);
  assert.match(fs.readFileSync(config, 'utf8'), /mcp_servers\.agent_memory/);
  assert.ok(receiptOf(home).files[config], 'and it must record the restore chain once it can run');
});

test('an uninstall waits for the setup lock instead of restoring a host file under a live holder', async (t) => {
  const { host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy').status, 0);
  const installed = fs.readFileSync(config, 'utf8');

  const state = spawnRun(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall'], env, home);

  // The same rule on the way back out. A restore that runs under someone else's lock can drop the
  // receipt entry for a file a competing install is recording at that moment, which leaves the file
  // installed with nothing recording how to restore it.
  withLock(path.join(home, 'state', 'setup-lock'), () => {
    sleepSync(1200);
    assert.equal(fs.readFileSync(config, 'utf8'), installed, 'a host file must not be restored while another holder has the setup lock');
    assert.equal(state.code, null, 'the uninstall must be waiting for the lock, not already finished');
  });

  assert.equal(await settled(state), 0, state.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'the uninstall must restore the pre-install bytes once it holds the lock');
});