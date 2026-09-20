// Coverage for the runtime-directory sync.
//
// The pure helpers are unit-tested because they decide what "in sync" means, and the command
// itself is exercised as a subprocess against a real tarball so that the swap, the refusal
// paths and the rollback are what the script actually does rather than what the helpers
// imply. The tarball is packed once for the whole file — packing is the slow part and every
// case below only needs to unpack it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compareTrees, copyTree, listTree, sha256File } from '../scripts/sync-app.mjs';

const script = fileURLToPath(new URL('../scripts/sync-app.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

let temp;
let tarball;
let shipped;

function run(args, options = {}) {
  const env = { ...process.env };
  delete env.MEMKEEL_APP_DIR;
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true, env, ...options });
}

/** Rollback directories the script left beside a target. */
function rollbacks(target) {
  const prefix = `${path.basename(target)}.rollback-`;
  return fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith(prefix)).sort();
}

before(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-sync-test-'));
  const packed = spawnSync('npm', ['pack', '--pack-destination', temp, '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout)[0];
  tarball = path.join(temp, report.filename);
  shipped = report.files.map((entry) => entry.path).sort();
});

after(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});

test('listTree returns sorted POSIX-relative paths', () => {
  const dir = path.join(temp, 'tree');
  fs.mkdirSync(path.join(dir, 'nested', 'deeper'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  fs.writeFileSync(path.join(dir, 'nested', 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'nested', 'deeper', 'c.txt'), 'c');
  assert.deepEqual(listTree(dir), ['b.txt', 'nested/a.txt', 'nested/deeper/c.txt']);
});

test('compareTrees separates differing, missing and extra files', () => {
  const expected = path.join(temp, 'expected');
  const actual = path.join(temp, 'actual');
  fs.mkdirSync(expected, { recursive: true });
  fs.mkdirSync(actual, { recursive: true });
  fs.writeFileSync(path.join(expected, 'same.txt'), 'same');
  fs.writeFileSync(path.join(actual, 'same.txt'), 'same');
  fs.writeFileSync(path.join(expected, 'changed.txt'), 'new');
  fs.writeFileSync(path.join(actual, 'changed.txt'), 'old');
  fs.writeFileSync(path.join(expected, 'absent.txt'), 'gone');
  fs.writeFileSync(path.join(actual, 'stray.txt'), 'stray');

  const diff = compareTrees(expected, actual);
  assert.deepEqual(diff.differing, ['changed.txt']);
  assert.deepEqual(diff.missing, ['absent.txt']);
  assert.deepEqual(diff.extra, ['stray.txt']);
  assert.equal(diff.identical, 1);
});

test('copyTree copies nested files and replaces an existing one', () => {
  const from = path.join(temp, 'copy-from');
  const to = path.join(temp, 'copy-to');
  fs.mkdirSync(path.join(from, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(from, 'nested', 'file.txt'), 'source');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'nested-file.txt'), 'stale');
  copyTree(from, to);
  assert.equal(fs.readFileSync(path.join(to, 'nested', 'file.txt'), 'utf8'), 'source');
  assert.deepEqual(compareTrees(from, to).differing, []);
});

test('--help prints usage and succeeds', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: node scripts\/sync-app\.mjs --into DIR/);
});

test('an unknown argument is refused rather than ignored', () => {
  const result = run(['--into', path.join(temp, 'unused'), '--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown argument: --bogus/);
});

test('a missing target is refused', () => {
  const result = run(['--from', tarball]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no target directory/);
});

test('sync builds a runtime directory that matches the artifact file for file', () => {
  const target = path.join(temp, 'app');
  const result = run(['--into', target, '--from', tarball]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^wrote: /);
  assert.deepEqual(listTree(target), shipped);
  // The first sync has nothing to roll back to, so it must not invent a rollback directory.
  assert.deepEqual(rollbacks(target), []);
});

test('--check confirms the copy is in sync and writes nothing', () => {
  const target = path.join(temp, 'app');
  const before = listTree(target);
  const result = run(['--check', '--into', target, '--from', tarball]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /in sync:/);
  assert.deepEqual(listTree(target), before);
  assert.deepEqual(rollbacks(target), []);
});

test('--check fails on drift and names the file that drifted', () => {
  const target = path.join(temp, 'app');
  fs.writeFileSync(path.join(target, 'lib', 'core.mjs'), 'x');
  const result = run(['--check', '--into', target, '--from', tarball]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OUT OF SYNC:/);
  assert.match(result.stderr, /differs: lib\/core\.mjs/);
  // A check that reported drift must not have repaired it.
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'core.mjs'), 'utf8'), 'x');
});

test('a second sync repairs drift, keeps the drifted copy and prunes older rollbacks', () => {
  const target = path.join(temp, 'app');
  const result = run(['--into', target, '--from', tarball]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollback: /);

  const kept = rollbacks(target);
  assert.equal(kept.length, 1);
  // The rollback holds what was there before this sync, which is the tampered file.
  assert.equal(fs.readFileSync(path.join(target, '..', kept[0], 'lib', 'core.mjs'), 'utf8'), 'x');
  assert.equal(run(['--check', '--into', target, '--from', tarball]).status, 0);

  fs.writeFileSync(path.join(target, 'lib', 'core.mjs'), 'y');
  assert.equal(run(['--into', target, '--from', tarball]).status, 0);
  assert.equal(rollbacks(target).length, 1);
});

test('a target that is not a memkeel copy is refused unless forced', () => {
  const foreign = path.join(temp, 'foreign');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'package.json'), JSON.stringify({ name: 'something-else' }));
  const refused = run(['--into', foreign, '--from', tarball]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to replace/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(foreign, 'package.json'), 'utf8')).name, 'something-else');

  const forced = run(['--into', foreign, '--from', tarball, '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(foreign, 'package.json'), 'utf8')).name, 'memkeel');
});

test('a non-empty directory with no manifest is refused unless forced', () => {
  const stray = path.join(temp, 'stray');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(stray, 'notes.txt'), 'mine');
  const refused = run(['--into', stray, '--from', tarball]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /no package\.json and is not empty/);
  assert.equal(fs.existsSync(path.join(stray, 'notes.txt')), true);
});

test('the checkout itself is never a target', () => {
  const result = run(['--into', root, '--from', tarball]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to sync into the checkout itself/);
  assert.equal(fs.existsSync(path.join(root, 'package.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'memory.mjs')), true);
});

test('a synced directory is byte-identical to the artifact it came from', () => {
  const target = path.join(temp, 'app');
  const extracted = path.join(temp, 'extracted');
  fs.mkdirSync(extracted, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', extracted], { encoding: 'utf8', windowsHide: true });
  assert.equal(untar.status, 0, untar.stderr);
  const diff = compareTrees(path.join(extracted, 'package'), target);
  assert.deepEqual(diff.differing, []);
  assert.deepEqual(diff.missing, []);
  assert.deepEqual(diff.extra, []);
  assert.equal(diff.identical, shipped.length);
  assert.equal(sha256File(path.join(target, 'memory.mjs')), sha256File(path.join(extracted, 'package', 'memory.mjs')));
});
