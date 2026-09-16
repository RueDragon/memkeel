// Coverage for the release gate's decisions (REL-01).
//
// The gate itself runs `npm pack` and an install, which is too slow and too side-effecting for the unit
// suite. What is tested here is the judgement it applies to the facts it gathers: which files must be in
// the package, which must not, whether the version and the changelog agree, and — the one that matters
// most — whether any shipped module imports a `.ts` file at runtime, which is the failure this gate was
// written after finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_FORBIDDEN, PACKAGE_REQUIRED, findRuntimeTypeScriptImports, inspectPackage, versionConsistency,
} from '../scripts/release-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a package missing a required document is rejected, and the missing file is named', () => {
  const complete = [...PACKAGE_REQUIRED];
  assert.equal(inspectPackage(complete).ok, true);
  for (const dropped of ['LICENSE', 'README.md', 'CHANGELOG.md', 'bin/memkeel.mjs', 'dashboard/static/index.html']) {
    const crippled = complete.filter((file) => file !== dropped);
    const result = inspectPackage(crippled);
    assert.equal(result.ok, false, `dropping ${dropped} must fail the check`);
    assert.deepEqual(result.missing, [dropped]);
  }
  // `LICENSE` and `README.md` are the ones npm adds on its own rather than listing in `files`; asserting
  // them here is the whole point, because a publisher default that stops applying is silent.
  assert.ok(PACKAGE_REQUIRED.includes('LICENSE'));
  assert.ok(PACKAGE_REQUIRED.includes('README.md'));
});

test('the things that must never ship are rejected', () => {
  for (const file of ['test/core.test.mjs', '.github/workflows/ci.yml', 'dashboard/app/src/App.jsx', 'node_modules/foo/index.js', '.env', 'lib/.env.local']) {
    const result = inspectPackage([...PACKAGE_REQUIRED, file]);
    assert.equal(result.ok, false, `${file} must not be shippable`);
    assert.ok(result.forbidden.some((row) => row.file === file), `${file} must be named`);
    assert.ok(result.forbidden.every((row) => row.why.length > 0), 'a rejection must say why');
  }
  assert.equal(PACKAGE_FORBIDDEN.length, 5);
});

test('the version must appear as a changelog heading', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-09-15\n\n## [0.9.0]\n';
  assert.equal(versionConsistency('1.0.0', changelog).ok, true);
  assert.deepEqual(versionConsistency('1.0.0', changelog).released, ['Unreleased', '1.0.0', '0.9.0']);
  const missing = versionConsistency('1.1.0', changelog);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /no "## \[1\.1\.0\]" section/);
  assert.equal(versionConsistency('2.0.0', '# no headings here\n').ok, false);
});

test('a shipped module importing a .ts file at runtime is detected', () => {
  const hits = findRuntimeTypeScriptImports([
    { path: 'lib/core.mjs', text: "import { a } from '../vendor/thing/part.ts';\n" },
    { path: 'memory.mjs', text: "// import { b } from './x.ts';\nimport { c } from './lib/core.mjs';\n" },
    { path: 'bin/memkeel.mjs', text: "await import('../lib/y.ts');\n" },
    { path: 'lib/clean.mjs', text: "import fs from 'node:fs';\nexport { z } from './lib/z.mjs';\n" },
  ]);
  assert.deepEqual(hits.map((hit) => hit.file), ['lib/core.mjs', 'bin/memkeel.mjs']);
  assert.deepEqual(hits.map((hit) => hit.specifier), ['../vendor/thing/part.ts', '../lib/y.ts']);
  // A commented-out import is not a runtime import, and a `.mjs` import is obviously fine.
  assert.equal(hits.some((hit) => hit.file === 'memory.mjs'), false);
  assert.equal(hits.some((hit) => hit.file === 'lib/clean.mjs'), false);
  assert.deepEqual(findRuntimeTypeScriptImports([]), []);
});

test('the shipped modules of this working tree are reported as they are, not as they should be', () => {
  // This asserts the detector works on real files rather than claiming the blocker is fixed. It is the
  // release gate's job to fail while a `.ts` import is present; this test's job is to make sure the
  // detector would notice if one came back.
  const modules = ['memory.mjs', 'mcp-server.mjs', 'setup.mjs', 'bin/memkeel.mjs']
    .filter((file) => fs.existsSync(path.join(ROOT, file)))
    .map((file) => ({ path: file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  const scanningCore = [{ path: 'lib/core.mjs', text: fs.readFileSync(path.join(ROOT, 'lib/core.mjs'), 'utf8') }];
  assert.ok(modules.length >= 3, 'the entry modules must exist to be scanned');
  // The known blocker lives in lib/core.mjs; if it is ever fixed this assertion flips, which is the
  // signal to delete the blocker section in RELEASE.md and the `blocker` field in the gate's output.
  const known = findRuntimeTypeScriptImports(scanningCore);
  assert.equal(known.length, 1);
  assert.match(known[0].specifier, /session-start\.ts$/);
});
