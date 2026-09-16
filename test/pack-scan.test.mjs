// Coverage for the packaged-artifact gate.
//
// The declaration check is unit-tested because it is the part that catches a file the
// manifest does not admit to, and it is exercised end to end against the real tarball so
// that `npm pack` behaviour (not a dry run) is what the gate actually sees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeclared, undeclaredFiles } from '../scripts/pack-scan.mjs';

const script = fileURLToPath(new URL('../scripts/pack-scan.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));

const FILES = ['bin/', 'lib/', 'dashboard/static/', 'config.example.json', 'CHANGELOG.md'];

test('a path under a declared directory is declared', () => {
  assert.equal(isDeclared('lib/core.mjs', FILES), true);
  assert.equal(isDeclared('dashboard/static/assets/index.js', FILES), true);
  assert.equal(isDeclared('bin/memkeel.mjs', FILES), true);
});

test('a declared individual file is declared, and a sibling is not', () => {
  assert.equal(isDeclared('config.example.json', FILES), true);
  assert.equal(isDeclared('config.json', FILES), false);
  assert.equal(isDeclared('docs/CHANGELOG.md', FILES), false);
});

test('a directory whose name merely starts the same way is not declared', () => {
  // `libprivate/` must not be accepted because `lib/` is declared.
  assert.equal(isDeclared('libprivate/secret.mjs', FILES), false);
  assert.equal(isDeclared('binaries/tool.exe', FILES), false);
});

test('npm always-included files are accepted at the top level only', () => {
  assert.equal(isDeclared('package.json', []), true);
  assert.equal(isDeclared('README.md', []), true);
  assert.equal(isDeclared('LICENSE', []), true);
  assert.equal(isDeclared('nested/LICENSE', []), false);
  assert.equal(isDeclared('nested/package.json', []), false);
});

test('undeclaredFiles reports only the paths the manifest does not admit to', () => {
  assert.deepEqual(
    undeclaredFiles(['lib/core.mjs', 'README.md', 'state/index.json', 'notes.txt'], FILES),
    ['state/index.json', 'notes.txt'],
  );
});

test('the real tarball declares every shipped file and scans clean', () => {
  const env = { ...process.env };
  delete env.MEMKEEL_LEAK_TERMS_FILE;
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8', windowsHide: true, env });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  assert.match(result.stdout, /every shipped file is declared in package\.json "files"/);
  assert.match(result.stdout, /leak-scan: clean \(\d+ files scanned in the artifact\)/);
  assert.match(result.stdout, /pack-scan: OK/);
});
