// QA-02, the half that needs no installed host: every host is exercised inside a throwaway home.
//
// The plan is explicit that a simulated result may not stand in for real integration, so this file
// is careful about what it does and does not claim. It proves the *binding contract* per host —
// what setup writes, that repeating it changes nothing, that an edit it did not make is refused,
// and that uninstall restores the original bytes — with every host directory, the user profile and
// the memory home redirected into a temporary tree. What it cannot prove is that a real Codex,
// Claude Code, ZCode or dsh process reads those files and behaves; that needs the hosts installed,
// and it is listed as remaining rather than claimed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));
const RUNNER = 'hook-runner.mjs';

/**
 * Every way a host can be pointed at a directory, so no test can reach the real user profile.
 *
 * Both HOME and USERPROFILE are redirected because `os.homedir()` reads whichever the platform
 * uses, and Claude keeps its MCP file in the user home rather than in its config directory.
 */
function isolated(t, { memoryHome = 'memory home' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-hosts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userHome = path.join(root, 'user-home');
  fs.mkdirSync(userHome, { recursive: true });
  const home = path.join(root, memoryHome);
  const store = path.join(root, 'store');
  const dirs = {
    codex: path.join(root, 'codex'),
    claude: path.join(root, 'claude'),
    zcode: path.join(root, 'zcode'),
    dsh: path.join(root, 'dsh'),
  };
  fs.mkdirSync(dirs.codex);
  fs.mkdirSync(dirs.claude);
  fs.mkdirSync(path.join(dirs.zcode, 'cli'), { recursive: true });

  const env = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    MEMKEEL_HOME: path.join(root, 'wrong-home'),
    CODEX_HOME: dirs.codex,
    CLAUDE_CONFIG_DIR: dirs.claude,
    ZCODE_HOME: dirs.zcode,
    DSH_HOME: dirs.dsh,
  };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--home', home], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(run('init', '--store', store).status, 0);
  return { root, userHome, home, store, dirs, env, run };
}

/** Relative path -> exact bytes, for "did anything change" assertions. */
function snapshot(root) {
  const out = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full).replaceAll('\\', '/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(root);
  return out;
}

/**
 * Only the files belonging to the hosts: their own directories and the user profile.
 *
 * The memory home is deliberately excluded. setup rewrites `state/setup.json` with a fresh
 * timestamp, adds a backup directory and updates the receipt on every apply, so comparing it would
 * report a change on every run and hide the thing under test - whether a *host's* configuration was
 * rewritten.
 */
function hostSnapshot(f) {
  const out = {};
  for (const [label, dir] of [...Object.entries(f.dirs), ['user-home', f.userHome]]) {
    for (const [relative, bytes] of Object.entries(snapshot(dir))) out[`${label}/${relative}`] = bytes;
  }
  return out;
}

function addDshProfiles(dirs, profiles) {
  for (const profile of profiles) {
    const file = path.join(dirs.dsh, 'profiles', profile, 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[]\n');
  }
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** How each host looks before setup touches it, so a restore has something to compare against. */
const HOSTS = [
  ['codex', (f) => fs.writeFileSync(path.join(f.dirs.codex, 'config.toml'), 'model = "demo"\n')],
  ['claude', (f) => fs.writeFileSync(path.join(f.dirs.claude, 'settings.json'), '{\n  "permissions": {}\n}\n')],
  ['zcode', (f) => {
    fs.writeFileSync(path.join(f.dirs.zcode, 'cli', 'config.json'), '{\n  "memory": { "use": true },\n  "features": { "memory": true }\n}\n');
    fs.mkdirSync(path.join(f.dirs.zcode, 'v2'), { recursive: true });
    fs.writeFileSync(path.join(f.dirs.zcode, 'v2', 'setting.json'), '{"memoryEnabled":true}\n');
  }],
  ['dsh', (f) => addDshProfiles(f.dirs, ['headless', 'web', 'desktop'])],
];

for (const [host, seed] of HOSTS) {
  test(`${host}: dry-run writes nothing, install binds, a re-run changes nothing, uninstall restores the bytes`, (t) => {
    const f = isolated(t);
    seed(f);

    const before = snapshot(f.root);
    const hostsBefore = hostSnapshot(f);
    const dry = f.run('setup', '--hosts', host, '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(snapshot(f.root), before, `${host}: --dry-run wrote to disk`);

    const install = f.run('setup', '--hosts', host);
    assert.equal(install.status, 0, install.stderr);
    assert.equal(JSON.parse(install.stdout).intent.kind, 'first-install', host);
    const installed = hostSnapshot(f);
    assert.notDeepEqual(installed, hostsBefore, `${host}: install changed nothing`);

    // The binding has to name the memory home it was made for, or it would read another store.
    const text = Object.values(installed).join('\n');
    assert.ok(text.includes(path.basename(f.home)), `${host}: no binding path mentions the memory home`);

    // Repeating must be a no-op: no second hook entry, no rewritten file.
    const again = f.run('setup', '--hosts', host);
    assert.equal(again.status, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).changed, 0, `${host}: a re-run changed files`);
    assert.deepEqual(hostSnapshot(f), installed, `${host}: a re-run rewrote a host file`);

    const uninstall = f.run('setup', '--hosts', host, '--uninstall');
    assert.equal(uninstall.status, 0, uninstall.stderr);
    assert.equal(JSON.parse(uninstall.stdout).intent.kind, 'uninstall', host);
    assert.deepEqual(hostSnapshot(f), hostsBefore, `${host}: uninstall did not restore the original bytes`);
    // And the receipt no longer claims anything, so a second uninstall refuses rather than guessing.
    assert.equal(Object.keys(read(path.join(f.home, 'state', 'setup-receipt.json')).files).length, 0, `${host}: the receipt still claims files`);
  });
}

test('codex: the hook list holds exactly one entry of ours per event, however often setup runs', (t) => {
  const f = isolated(t);
  fs.writeFileSync(path.join(f.dirs.codex, 'config.toml'), 'model = "demo"\n');
  assert.equal(f.run('setup', '--hosts', 'codex').status, 0);
  assert.equal(f.run('setup', '--hosts', 'codex').status, 0);
  assert.equal(f.run('setup', '--hosts', 'codex').status, 0);

  const hooks = read(path.join(f.dirs.codex, 'hooks.json')).hooks;
  const events = Object.keys(hooks);
  assert.ok(events.length >= 6, `expected the documented events, got ${JSON.stringify(events)}`);
  for (const event of events) {
    const ours = hooks[event].flatMap((group) => group.hooks ?? []).filter((hook) => String(hook.command ?? '').includes(RUNNER));
    assert.equal(ours.length, 1, `codex ${event}: ${ours.length} of our hooks`);
  }
});

test('codex: a hand edit is refused, and --force does not discard it', (t) => {
  const f = isolated(t);
  const config = path.join(f.dirs.codex, 'config.toml');
  fs.writeFileSync(config, 'model = "demo"\n');
  assert.equal(f.run('setup', '--hosts', 'codex').status, 0);
  fs.appendFileSync(config, '\n# a later hand edit\n');
  const edited = fs.readFileSync(config, 'utf8');

  assert.equal(f.run('setup', '--hosts', 'codex').status, 1);
  assert.equal(f.run('setup', '--hosts', 'codex', '--force').status, 1);
  assert.equal(fs.readFileSync(config, 'utf8'), edited, 'the hand edit was overwritten');
});

test('codex: an existing binding that points elsewhere is refused, then replaceable with --force', (t) => {
  const f = isolated(t);
  fs.writeFileSync(path.join(f.dirs.codex, 'config.toml'), '[mcp_servers.agent_memory]\ncommand = "somewhere-else"\n');
  const refused = f.run('setup', '--hosts', 'codex');
  assert.equal(refused.status, 1);
  assert.match(JSON.stringify(JSON.parse(refused.stdout).report), /differs|--force/);
  assert.equal(f.run('setup', '--hosts', 'codex', '--force').status, 0);
});

test('claude: the config directory is redirected, and its MCP file stays in the user home', (t) => {
  const f = isolated(t);
  fs.writeFileSync(path.join(f.dirs.claude, 'settings.json'), '{\n  "permissions": {}\n}\n');
  assert.equal(f.run('setup', '--hosts', 'claude').status, 0);

  // Claude splits the two: hooks and the policy file follow CLAUDE_CONFIG_DIR, the MCP server
  // lives in ~/.claude.json. Binding the wrong one would leave the host unbindable.
  assert.ok(fs.existsSync(path.join(f.dirs.claude, 'settings.json')));
  assert.ok(fs.existsSync(path.join(f.dirs.claude, 'CLAUDE.md')));
  assert.equal(fs.existsSync(path.join(f.userHome, '.claude.json')), true, 'the MCP file did not land in the user home');
  // Structural, not textual: the JSON escapes backslashes, so a substring match on the raw path
  // would fail while the binding was in fact correct.
  const installed = read(path.join(f.userHome, '.claude.json'));
  assert.deepEqual(installed.mcpServers.agent_memory.args.slice(-2), ['--home', f.home]);
  assert.equal(installed.mcpServers.agent_memory.type, 'stdio');
  // The policy is imported, not inlined, so the shared source stays the single origin.
  assert.match(fs.readFileSync(path.join(f.dirs.claude, 'CLAUDE.md'), 'utf8'), /@.*bootstrap\.md/);
  // Nothing leaked into the real profile: every file lives under the temporary tree.
  assert.ok(f.root.startsWith(os.tmpdir()));
});

test('dsh: every installed profile is bound, and the ones that are absent are left alone', (t) => {
  const f = isolated(t);
  addDshProfiles(f.dirs, ['headless', 'web']);
  const before = hostSnapshot(f);
  assert.equal(f.run('setup', '--hosts', 'dsh').status, 0);

  for (const profile of ['headless', 'web']) {
    const text = fs.readFileSync(path.join(f.dirs.dsh, 'profiles', profile, 'cordis.patch.yml'), 'utf8');
    assert.match(text, /mcp-agent-memory/, `${profile}: no MCP block`);
    assert.match(text, /AGENT-MEMORY-HOOKS:START/, `${profile}: no hook block`);
    assert.ok(text.includes(path.basename(f.home)), `${profile}: no memory home in the binding`);
  }
  // dsh keeps one hooks file in the memory home as well, for the events the plugin forwards.
  assert.ok(fs.existsSync(path.join(f.home, 'dsh-hooks.json')));
  // A profile that does not exist must not be created: opening a profile the user never made would
  // silently enable it.
  assert.equal(fs.existsSync(path.join(f.dirs.dsh, 'profiles', 'desktop')), false);
  assert.ok(fs.existsSync(path.join(f.dirs.dsh, 'AGENTS.md')));

  assert.equal(f.run('setup', '--hosts', 'dsh', '--uninstall').status, 0);
  assert.deepEqual(hostSnapshot(f), before, 'dsh: uninstall did not restore the original bytes');
});

test('zcode: the native memory switch is off while bound, and uninstall restores the original file', (t) => {
  const f = isolated(t);
  const config = path.join(f.dirs.zcode, 'cli', 'config.json');
  const legacy = path.join(f.dirs.zcode, 'v2', 'setting.json');
  fs.writeFileSync(config, '{\n  "memory": { "use": true },\n  "features": { "memory": true }\n}\n');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, '{"memoryEnabled":true}\n');

  assert.equal(f.run('setup', '--hosts', 'zcode').status, 0);
  const installed = read(config);
  assert.equal(installed.memory.use, false, 'the host memory feature duplicates context and must be off');
  assert.equal(installed.features.memory, false);
  // ZCode's declaration is a process + args, not a shell string, so nothing can be re-split later.
  assert.deepEqual(installed.mcp.servers.agent_memory.args.slice(-2), ['--home', f.home]);
  assert.equal(installed.mcp.servers.agent_memory.type, 'stdio');
  assert.equal(read(legacy).memoryEnabled, false);

  assert.equal(f.run('setup', '--hosts', 'zcode', '--uninstall').status, 0);
  assert.equal(read(config).memory.use, true, 'uninstall restores the host preference');
  // Restoring the recorded bytes puts the legacy switch back to what it was *before* the install,
  // which is the whole point of restoring bytes rather than replaying our own edit: the host's own
  // feature is returned to the user's own setting, not to whatever we preferred.
  assert.equal(read(legacy).memoryEnabled, true);
});

test('a memory home with spaces, quotes and shell metacharacters still yields a launcher that runs', (t) => {
  // The binding embeds this path in a command string for Codex and Claude, so a path that breaks
  // quoting would silently break every hook at runtime - the failure this test exists to catch.
  const f = isolated(t, { memoryHome: "memory 'home' & more" });
  fs.writeFileSync(path.join(f.dirs.codex, 'config.toml'), 'model = "demo"\n');
  assert.equal(f.run('setup', '--hosts', 'codex').status, 0);

  const hooks = read(path.join(f.dirs.codex, 'hooks.json')).hooks;
  const command = hooks.SessionStart[0].hooks[0].command;
  assert.ok(command.includes(RUNNER), command);

  // Run it exactly as the host would: through a shell, with the payload on standard input.
  const payload = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'hostile-path-1', cwd: f.store, source: 'startup' });
  const result = spawnSync(command, { shell: true, input: payload, encoding: 'utf8', windowsHide: true, env: f.env });
  assert.equal(result.status, 0, `the generated command failed: ${result.stderr}`);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /agent-memory-hook/);
});
