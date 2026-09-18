import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withLock } from '../lib/transport.mjs';
import { readInstallReceipt } from '../lib/install-receipt.mjs';
const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
// A synchronous sleep, so a test can hold the setup lock while a spawned run is given time to reach
// it. Atomics.wait blocks this process only; the child is a separate process and keeps running.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
async function settled(state, ms = 30000) {
  const deadline = Date.now() + ms;
  while (state.code === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.notEqual(state.code, null, 'the spawned run did not finish');
  return state.code;
}
async function waitForFile(file, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(file), true, `the child never reached ${path.basename(file)}`);
}

/**
 * The documented recovery after a killed run: a crash mid-write leaves the setup lock behind, and
 * nothing removes it automatically. Doing it here is part of the test rather than a workaround - it
 * asserts that the lock is left for a human (the fail-closed behaviour) and then clears it the way the
 * refusal message tells the user to.
 */
function clearStaleLock(home) {
  const lock = path.join(home, 'state', 'setup-lock', 'writer.lock');
  assert.equal(fs.existsSync(lock), true, 'a run killed while it held the lock must leave it behind');
  fs.rmSync(lock, { force: true });
}

/** Why a run refused, which `setup` reports per host instead of on stderr. */
function refusal(result) {
  try { return JSON.stringify(JSON.parse(result.stdout).report.filter((row) => row.refused)); }
  catch { return result.stderr || '(no output)'; }
}

// A child-side barrier, so a test can force an exact interleaving instead of hoping for one.
//
// The preload module is written into the test's own temp directory and loaded into the child with
// `--import`, so nothing in the repository changes to make a race testable. It stops the child at a
// chosen filesystem call until the test releases it, which turns "the child is probably about to
// take the lock" into "the child is stopped at the lock". Waiting on that handshake is what makes
// the assertions below about the boundary between reading, deciding and writing rather than about
// how fast this machine happens to be.
const BARRIERS = {
  // Stops the child immediately before its first attempt to acquire the setup lock.
  lock: `
    const real = fs.openSync;
    fs.openSync = function (target, flags, ...rest) {
      const isSetupLock = path.basename(String(target)) === 'writer.lock' && path.basename(path.dirname(String(target))) === 'setup-lock';
      if (!fired && isSetupLock && String(flags).includes('wx')) { fire(); }
      return real.call(fs, target, flags, ...rest);
    };`,
  // Stops the child immediately before it writes the host file it is installing into, which is the
  // point a crash would land on: after the restore chain is recorded, before the file is replaced. The
  // predicate accepts the target and a temporary beside it, because the replacement is written through
  // a sibling temporary and renamed - instrumenting one exact path would make the test depend on that
  // mechanism instead of on the moment the host file is replaced.
  'host-write': `
    const real = fs.writeFileSync;
    const hostTarget = process.env.MEMKEEL_BARRIER_TARGET;
    fs.writeFileSync = function (to, ...rest) {
      const name = String(to);
      if (!fired && (name === hostTarget || name.startsWith(hostTarget + '.'))) { fire(); }
      return real.call(fs, to, ...rest);
    };`,
  // Kills the child at that same point, which is what a crash does: no `catch`, no `finally`, no
  // commit. SIGKILL rather than a failed write, because a failed write lets the process clean up
  // after itself and a read-only bit does not stop the write at all when the tests run as root.
  'crash-host-write': `
    const real = fs.writeFileSync;
    const hostTarget = process.env.MEMKEEL_BARRIER_TARGET;
    fs.writeFileSync = function (to, ...rest) {
      const name = String(to);
      if (!fired && (name === hostTarget || name.startsWith(hostTarget + '.'))) process.kill(process.pid, 'SIGKILL');
      return real.call(fs, to, ...rest);
    };`,
  // Kills the child while the receipt is being rewritten *after* the host file already carries the
  // binding: the state an interrupted upgrade leaves, where the file is new and the record is not.
  // The guard keeps it from firing on the write-ahead receipt of a first install.
  'crash-before-commit': `
    const real = fs.renameSync;
    fs.renameSync = function (from, to, ...rest) {
      const host = process.env.MEMKEEL_BARRIER_HOST;
      if (!fired && String(to) === process.env.MEMKEEL_BARRIER_TARGET && fs.existsSync(host) && fs.readFileSync(host, 'utf8').includes('agent_memory')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return real.call(fs, from, to, ...rest);
    };`,
  // Kills the child while the receipt is being rewritten *after* a restore has already put the host file
  // back, which is the uninstall half of the same window.
  'crash-after-restore': `
    const real = fs.renameSync;
    fs.renameSync = function (from, to, ...rest) {
      const host = process.env.MEMKEEL_BARRIER_HOST;
      if (!fired && String(to) === process.env.MEMKEEL_BARRIER_TARGET && fs.existsSync(host) && !fs.readFileSync(host, 'utf8').includes('agent_memory')) {
        process.kill(process.pid, 'SIGKILL');
      }
      return real.call(fs, from, to, ...rest);
    };`,
};
function barrierPreload(root, kind) {
  const file = path.join(root, `barrier-${kind}.mjs`);
  fs.writeFileSync(file, `
import fs from 'node:fs';
import path from 'node:path';
const signal = process.env.MEMKEEL_BARRIER_SIGNAL;
const release = process.env.MEMKEEL_BARRIER_RELEASE;
let hits = 0;
let fired = false;
function fire() {
  hits += 1;
  // Which occurrence of the hooked call to stop at, so a file that is bound twice in one run can be
  // interrupted at the second transform rather than the first.
  if (hits < Number(process.env.MEMKEEL_BARRIER_AT ?? 1)) return;
  fired = true;
  fs.writeFileSync(signal, 'reached');
  const deadline = Date.now() + 60000;
  while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
${BARRIERS[kind]}
`);
  return { url: pathToFileURL(file).href, signal: path.join(root, `${kind}-reached`), release: path.join(root, `${kind}-release`) };
}
/** Start a run under a barrier, so the test can choose the moment it proceeds. */
function spawnBarriered(args, env, home, barrier, extraEnv = {}) {
  const state = { code: null, stderr: '' };
  // NODE_OPTIONS rather than a command-line flag: `memory.mjs setup` runs `setup.mjs` as a child
  // process, so a flag passed on the command line would instrument the wrapper instead of the process
  // that actually reads and writes the host files. The environment is what reaches that child.
  const options = `${env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ` : ''}--import=${barrier.url}`;
  const child = spawn(process.execPath, [cli, ...args, '--home', home], {
    env: { ...env, NODE_OPTIONS: options, MEMKEEL_BARRIER_SIGNAL: barrier.signal, MEMKEEL_BARRIER_RELEASE: barrier.release, ...extraEnv },
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => { state.stderr += chunk; });
  child.on('close', (code) => { state.code = code; });
  return state;
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

test('rebinding dsh leaves one hooks block, one MCP item, and no stale home', (t) => {
  const { root, home, env } = fixture(t);
  const dsh = path.join(root, 'dsh');
  const profile = path.join(dsh, 'profiles', 'headless', 'cordis.patch.yml');
  fs.mkdirSync(path.dirname(profile), { recursive: true });
  fs.writeFileSync(profile, '[]\n');
  const dshEnv = { ...env, DSH_HOME: dsh };
  const runWith = (targetHome, ...args) => spawnSync(process.execPath, [cli, ...args, '--home', targetHome], { env: dshEnv, encoding: 'utf8', windowsHide: true });
  // The home is written into the file as a JSON-escaped scalar, so matching on the directory name is
  // what distinguishes the two homes without depending on how the path is quoted.
  const oldName = path.basename(home);
  const newName = 'second-home';

  assert.equal(runWith(home, 'setup', '--hosts', 'dsh').status, 0);
  const second = path.join(root, 'second-home');
  assert.equal(runWith(second, 'init').status, 0);
  // `--force` because the binding already names the first home, which is exactly what an upgrade or a
  // rebind looks like: the MCP item differs, so that transform rewrites it.
  assert.equal(runWith(second, 'setup', '--hosts', 'dsh', '--force').status, 0);

  const text = fs.readFileSync(profile, 'utf8');
  const count = (needle) => text.split(needle).length - 1;
  // The hooks block is delimited by comments at column 0, and the item inside it also starts at column
  // 0. Treating the next "- " line as the end of the MCP item therefore cut the START marker out of the
  // file, after which the hooks transform appended a second block: the old hook item stayed behind
  // pointing at the previous home, and every later run refused the host as ambiguous.
  assert.equal(count('# AGENT-MEMORY-HOOKS:START'), 1, 'the hooks block must not be duplicated');
  assert.equal(count('# AGENT-MEMORY-HOOKS:END'), 1, 'and its markers must still be paired');
  assert.equal(count('id: mcp-agent-memory'), 1, 'the MCP item must not be duplicated');
  assert.equal(count('id: agent-memory-hooks'), 1, 'and neither must the hook item');
  assert.equal(text.includes(newName), true, 'the file must name the new home');
  assert.equal(text.includes(oldName), false, 'and it must not still name the previous one');

  // The consequence that matters: the host was unusable for every later run.
  const again = runWith(second, 'setup', '--hosts', 'dsh', '--check');
  assert.equal(again.status, 0, `a check after a rebind must be accepted: ${refusal(again)}`);
});

test('an install killed before it writes the host file still leaves its restore chain recorded', async (t) => {
  const { root, host, home, env } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);

  // A real crash at the exact point an interruption would land: after the restore chain is recorded
  // and before the host file is replaced. SIGKILL, so no `catch` and no `finally` in the child can
  // tidy up - a read-only bit fails the write and lets the process clean up after itself, which is a
  // different thing, and it does not fail at all when the tests run as root.
  const barrier = barrierPreload(root, 'crash-host-write');
  const state = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy'], env, home, barrier, { MEMKEEL_BARRIER_TARGET: config });

  assert.notEqual(await settled(state), 0, 'a killed install must not report success');
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'the host file must be untouched');

  const row = receiptOf(home).files[config];
  assert.ok(row, 'the restore chain must be recorded before the file it describes');
  assert.equal(row.before, original, 'and it must hold the bytes that were there before the install');
  assert.equal(readInstallReceipt(home).malformed, null, 'the recorded chain must be usable after the crash');
});

test('an upgrade interrupted before it lands the file can still be retried and uninstalled', async (t) => {
  const { root, host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy').status, 0);

  // Model a valid older install: the host file holds the previous version's binding, and the record
  // describes exactly those bytes as the ones it wrote. The record has to keep describing that state
  // while an upgrade is in flight, or the next run has nothing to recognise the file by.
  const receiptFile = path.join(home, 'state', 'setup-receipt.json');
  const older = receiptOf(home).files[config].after.replace('mcp-server.mjs', 'old-mcp-server.mjs');
  fs.writeFileSync(config, older);
  const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  record.files[config].after = older;
  fs.writeFileSync(receiptFile, JSON.stringify(record, null, 2));

  // The upgrade records what it intends and is killed before it lands the file: the disk still holds
  // the older version. Recording the intent as the installed state is what leaves the file matching
  // neither the old nor the new state, and every later run - and the uninstall - then refuses it.
  const barrier = barrierPreload(root, 'crash-host-write');
  const killed = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--force'], env, home, barrier, { MEMKEEL_BARRIER_TARGET: config });
  assert.notEqual(await settled(killed), 0, 'the killed upgrade must not report success');
  assert.equal(fs.readFileSync(config, 'utf8'), older, 'and it must not have written the host file');
  assert.equal(readInstallReceipt(home).malformed, null, 'the record must still be usable after the crash');
  clearStaleLock(home);

  const retry = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--force');
  assert.equal(retry.status, 0, `the retry must be accepted, not refused: ${refusal(retry)}`);
  const after = fs.readFileSync(config, 'utf8');
  assert.match(after, /mcp-server\.mjs/);
  assert.doesNotMatch(after, /old-mcp-server\.mjs/, 'the retry must install the current binding');

  const uninstall = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall');
  assert.equal(uninstall.status, 0, `the uninstall must be accepted, not refused: ${refusal(uninstall)}`);
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'and it must restore the pre-install bytes');
});

test('a first install interrupted before it writes the file is retried without a false refusal', async (t) => {
  const { root, host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);

  const barrier = barrierPreload(root, 'crash-host-write');
  const killed = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy'], env, home, barrier, { MEMKEEL_BARRIER_TARGET: config });
  assert.notEqual(await settled(killed), 0, 'the killed install must not report success');
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'and it must not have written the host file');
  const interrupted = readInstallReceipt(home);
  assert.equal(interrupted.malformed, null, 'the half-started transaction must be readable');
  clearStaleLock(home);

  const retry = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy');
  assert.equal(retry.status, 0, `the retry must be accepted: ${refusal(retry)}`);
  assert.match(fs.readFileSync(config, 'utf8'), /mcp_servers\.agent_memory/);
  const committed = readInstallReceipt(home).files[config];
  assert.equal(committed.pending ?? null, null, 'a completed install must not leave a transaction open');
  assert.equal(committed.after, fs.readFileSync(config, 'utf8'), 'and it must record what it actually wrote');
});

test('a run killed after the file was written but before the record commits heals on the next run', async (t) => {
  const { root, host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  const receiptFile = path.join(home, 'state', 'setup-receipt.json');

  // Killed while the record is being rewritten *after* the host file already has the binding, which is
  // the other half of the window: the file is new and the record is behind it.
  const barrier = barrierPreload(root, 'crash-before-commit');
  const killed = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy'], env, home, barrier, { MEMKEEL_BARRIER_TARGET: receiptFile, MEMKEEL_BARRIER_HOST: config });
  assert.notEqual(await settled(killed), 0, 'the killed run must not report success');
  assert.match(fs.readFileSync(config, 'utf8'), /mcp_servers\.agent_memory/, 'the host file was written before the kill');
  assert.equal(readInstallReceipt(home).malformed, null, 'the interrupted record must be readable');
  clearStaleLock(home);

  // The next run reconciles: it recognises the file as the state the interrupted run intended, makes
  // that the recorded state, and reports nothing left to do.
  const retry = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy');
  assert.equal(retry.status, 0, `the retry must be accepted: ${refusal(retry)}`);
  assert.equal(JSON.parse(retry.stdout).changed, 0, 'the retry has nothing left to change');
  const row = readInstallReceipt(home).files[config];
  assert.equal(row.pending ?? null, null, 'the interrupted transaction must be closed');
  assert.equal(row.after, fs.readFileSync(config, 'utf8'), 'and the record must match what is on disk');

  const uninstall = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall');
  assert.equal(uninstall.status, 0, `the uninstall must be accepted: ${refusal(uninstall)}`);
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'and it must restore the pre-install bytes');
});

test('an uninstall killed between restoring a file and recording it can simply be repeated', async (t) => {
  const { root, host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy').status, 0);
  const receiptFile = path.join(home, 'state', 'setup-receipt.json');

  const barrier = barrierPreload(root, 'crash-after-restore');
  const killed = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall'], env, home, barrier, { MEMKEEL_BARRIER_TARGET: receiptFile, MEMKEEL_BARRIER_HOST: config });
  assert.notEqual(await settled(killed), 0, 'the killed uninstall must not report success');
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'the host file had already been restored');
  assert.ok(receiptOf(home).files[config], 'and the record had not been updated yet');
  clearStaleLock(home);

  // The restored file still matches the bytes the record says were there before the install, so the
  // repeat restores the same bytes and drops the row: an interrupted uninstall needs no decision.
  const again = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall');
  assert.equal(again.status, 0, `the repeat must be accepted: ${refusal(again)}`);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(receiptOf(home).files[config], undefined, 'and the row must be gone afterwards');
});

test('a file that matches no known state while a write was in flight says so', (t) => {
  const { host, home, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  fs.writeFileSync(config, 'model = "demo"\n');
  assert.equal(run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy').status, 0);

  // An interrupted run left a transaction open and something else has changed the file since, so it
  // matches neither the state that was recorded nor the bytes that run intended. Nothing here can be
  // settled automatically - a first install that never reached its file could be dropped, and a file
  // matching the intended bytes could be committed, but this is neither - so the refusal has to say
  // what was expected rather than reading like an ordinary concurrent edit.
  const receiptFile = path.join(home, 'state', 'setup-receipt.json');
  const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  record.files[config].pending = { after: 'model = "demo"\n# intended\n', at: new Date().toISOString() };
  fs.writeFileSync(receiptFile, JSON.stringify(record, null, 2));
  fs.writeFileSync(config, 'model = "demo"\n# somebody else\n');

  const result = run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy');
  assert.equal(result.status, 1, 'a file that matches no known state must be refused');
  assert.match(refusal(result), /was in flight/, 'the refusal must say a write was interrupted');
  assert.match(refusal(result), /changed since setup/);
  assert.equal(fs.readFileSync(config, 'utf8'), 'model = "demo"\n# somebody else\n', 'and nothing must be written');
  assert.equal(readInstallReceipt(home).malformed, null, 'the record must stay usable for the recovery');
});

test('an edit that lands before the lock is taken survives the install', async (t) => {
  const { root, host, home, env } = fixture(t);
  const config = path.join(host, 'config.toml');
  fs.writeFileSync(config, 'model = "demo"\n');

  const barrier = barrierPreload(root, 'lock');
  const state = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy'], env, home, barrier);

  // The child is stopped immediately before its first attempt to take the setup lock, which is the
  // last moment an edit can land without the child having seen it. Computing the new content from a
  // read taken *before* the lock is what loses this edit: the run overwrites the file with content
  // derived from bytes it no longer matches. The transform has to run inside the lock, on the bytes
  // that are on disk once the lock is held.
  await waitForFile(barrier.signal);
  fs.appendFileSync(config, '# concurrent edit must survive\n');
  fs.writeFileSync(barrier.release, '');

  assert.equal(await settled(state), 0, state.stderr);
  const after = fs.readFileSync(config, 'utf8');
  assert.match(after, /# concurrent edit must survive/, 'an edit that landed before the lock must not be overwritten');
  assert.match(after, /mcp_servers\.agent_memory/, 'and the binding must still be installed');
});

test('a setup waits for the setup lock instead of writing a host file under a live holder', async (t) => {
  const { root, host, home, env } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  const barrier = barrierPreload(root, 'lock');
  const state = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy'], env, home, barrier);

  // The handshake is what makes this a test of the boundary rather than of this machine's speed: the
  // child has stopped at the lock, and it is released only while the lock is held by this process.
  await waitForFile(barrier.signal);
  withLock(path.join(home, 'state', 'setup-lock'), () => {
    fs.writeFileSync(barrier.release, '');
    sleepSync(600);
    assert.equal(fs.readFileSync(config, 'utf8'), original, 'a host file must not be written while another holder has the setup lock');
    assert.equal(state.code, null, 'the blocked run must still be waiting for the lock, not already finished');
  });

  assert.equal(await settled(state), 0, state.stderr);
  assert.match(fs.readFileSync(config, 'utf8'), /mcp_servers\.agent_memory/);
  assert.ok(receiptOf(home).files[config], 'and it must record the restore chain once it can run');
});

test('an uninstall waits for the setup lock instead of restoring a host file under a live holder', async (t) => {
  const { root, host, home, env, run } = fixture(t);
  const config = path.join(host, 'config.toml');
  const original = 'model = "demo"\n';
  fs.writeFileSync(config, original);
  assert.equal(run('setup', '--hosts', 'codex', '--no-hooks', '--no-policy').status, 0);
  const installed = fs.readFileSync(config, 'utf8');

  const barrier = barrierPreload(root, 'lock');
  const state = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks', '--no-policy', '--uninstall'], env, home, barrier);

  // The same rule on the way back out. A restore that runs under someone else's lock can drop the
  // receipt entry for a file a competing install is recording at that moment, which leaves the file
  // installed with nothing recording how to restore it.
  await waitForFile(barrier.signal);
  withLock(path.join(home, 'state', 'setup-lock'), () => {
    fs.writeFileSync(barrier.release, '');
    sleepSync(600);
    assert.equal(fs.readFileSync(config, 'utf8'), installed, 'a host file must not be restored while another holder has the setup lock');
    assert.equal(state.code, null, 'the uninstall must be waiting for the lock, not already finished');
  });

  assert.equal(await settled(state), 0, state.stderr);
  assert.equal(fs.readFileSync(config, 'utf8'), original, 'the uninstall must restore the pre-install bytes once it holds the lock');
});

test('an edit to the policy file that lands before its lock survives too', async (t) => {
  const { root, host, home, env } = fixture(t);
  const policyFile = path.join(host, 'AGENTS.md');
  fs.writeFileSync(policyFile, '# House rules\n');

  // The policy block is the second file codex owns, so this stops at the second lock: the MCP
  // binding is written, the policy transform has not run. The transforms are not special cases of one
  // another - this one appends a Markdown block instead of editing TOML or JSON - so the read inside
  // the lock is checked here on a different transform rather than assumed from the first one.
  const barrier = barrierPreload(root, 'lock');
  const state = spawnBarriered(['setup', '--hosts', 'codex', '--no-hooks'], env, home, barrier, { MEMKEEL_BARRIER_AT: '2' });

  await waitForFile(barrier.signal);
  fs.appendFileSync(policyFile, '\n<!-- a concurrent edit -->\n');
  fs.writeFileSync(barrier.release, '');

  assert.equal(await settled(state), 0, state.stderr);
  const after = fs.readFileSync(policyFile, 'utf8');
  assert.match(after, /a concurrent edit/, 'an edit that landed before the policy lock must not be overwritten');
  assert.match(after, /AGENT-POLICY:START/, 'and the policy block must still be installed');
  assert.match(after, /# House rules/, 'and the file it was appended to must be preserved');
});

test('a ZCode file bound twice in one run never has a mid-run edit overwritten', async (t) => {
  const { root, home, env } = fixture(t);
  const host = path.join(root, 'zcode');
  fs.mkdirSync(path.join(host, 'cli'), { recursive: true });
  const config = path.join(host, 'cli', 'config.json');
  fs.writeFileSync(config, JSON.stringify({ other: 42 }, null, 2) + '\n');

  // ZCode puts its MCP server and its hooks in the same file, so the second transform has to work
  // from what the first one committed. Stopping the run at the second lock is exactly that boundary:
  // the MCP binding is on disk, the hooks transform has not run yet.
  //
  // This one pins the shared-file boundary rather than the order of read and lock: the guard refuses
  // a mid-run edit here even before that was fixed, because the row for the file exists by then. What
  // it does establish is that the first transform is committed before the second one reads - the
  // transforms run one at a time, each seeing the previous one's bytes - and that a refusal leaves the
  // edit and the unrelated host configuration exactly as they were.
  const barrier = barrierPreload(root, 'lock');
  const state = spawnBarriered(['setup', '--hosts', 'zcode', '--no-policy'], { ...env, ZCODE_HOME: host }, home, barrier, { MEMKEEL_BARRIER_AT: '2' });

  await waitForFile(barrier.signal);
  const mid = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.ok(mid.mcp?.servers?.agent_memory, 'the first transform must have committed the MCP binding');
  mid.userNote = 'must survive';
  fs.writeFileSync(config, JSON.stringify(mid, null, 2) + '\n');
  fs.writeFileSync(barrier.release, '');

  // The hooks transform now finds a file that is neither the state it recorded writing nor the state
  // it recorded replacing, so it refuses the host rather than write over the edit. Losing the edit
  // while reporting success - which is what computing the content before the lock did - is the
  // failure this pins down, so the exit code is checked as well as the bytes: refusing is the
  // intended outcome here, silently proceeding is not.
  assert.notEqual(await settled(state), 0, 'a file edited mid-run must be refused, not overwritten');
  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(after.userNote, 'must survive', 'the edit must still be there');
  assert.ok(after.mcp?.servers?.agent_memory, 'and the first transform\'s binding must not be rolled back');
  assert.equal(after.other, 42, 'and unrelated host configuration must be preserved');
});