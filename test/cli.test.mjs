// Coverage for the command-line entry point's first-run behaviour.
//
// The container's default command is `doctor`, and on a fresh volume the memory home exists
// but holds no config.json. That used to surface as a raw ENOENT stack trace; these tests pin
// the actionable message and the documented init-then-doctor flow, which is also what the
// Docker section of the README instructs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../memory.mjs', import.meta.url));

function run(args, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, MEMKEEL_HOME: home },
  });
}
function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a memory home without config.json fails with an actionable line, not a stack trace', (t) => {
  const home = tempDir('memkeel-cli-empty-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = run(['doctor'], home);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No memory home at/);
  assert.match(result.stderr, /memkeel init/);
  // A first-run user must not be shown the raw Node failure.
  assert.doesNotMatch(result.stderr, /ENOENT/);
  assert.doesNotMatch(result.stderr, /at ModuleJob\.run/);
  assert.equal(result.stdout.trim(), '');
});

test('help still works with no memory home at all', (t) => {
  const home = tempDir('memkeel-cli-none-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const missing = path.join(home, 'not-created');
  const result = run(['help'], missing);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bootstrap/);
});

test('the documented container flow works: init --store, then doctor', () => {
  const home = tempDir('memkeel-cli-home-');
  const store = tempDir('memkeel-cli-store-');
  try {
    const init = run(['init', '--store', store], home);
    assert.equal(init.status, 0);

    const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(config.vaultRoot, store);
    assert.equal(config.memoryRoot, store);
    assert.equal(config.storage, 'filesystem');

    // The store must land where it was told, not inside the home volume.
    assert.equal(fs.existsSync(path.join(home, 'store')), false);
    assert.equal(fs.existsSync(path.join(store, config.roles.habitsNote)), true);

    const doctor = run(['doctor'], home);
    assert.equal(doctor.status, 0);
    assert.match(doctor.stdout, /"missing":\s*\[\]/);
    assert.match(doctor.stdout, /"healthy":\s*true/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test('init is idempotent: a second run reports the files it already found', () => {
  const home = tempDir('memkeel-cli-idem-');
  const store = tempDir('memkeel-cli-idem-store-');
  try {
    assert.equal(run(['init', '--store', store], home).status, 0);
    const second = run(['init', '--store', store], home);
    assert.equal(second.status, 0);
    const report = JSON.parse(second.stdout);
    assert.deepEqual(report.created, []);
    assert.ok(report.existing.includes(path.join(home, 'config.json')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});
