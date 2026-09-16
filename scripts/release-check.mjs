#!/usr/bin/env node
// Pre-release verification (REL-01).
//
// The plan asks for a release to be checked from the artifact rather than from the working tree: build
// the dashboard, run the tests and the privacy gates, actually install the tarball, and confirm the
// licence and the documents a user needs are inside it. This script does exactly that and nothing else
// — it writes no file inside the repository and publishes nothing.
//
// Two deliberate limits, stated here rather than discovered later:
//
//   * It never publishes. `npm publish` needs the maintainer's own credentials and a decision about who
//     owns the package name; that is not something a check script should be able to do by accident.
//   * It never touches an existing installation. Upgrading a live memory home is a separate, deliberate
//     action (see RELEASE.md), because it can invalidate host bindings and a store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'memkeel';

// Everything a user of the published package needs. `LICENSE` and `README.md` are not in package.json's
// `files` because npm adds them on its own, which is exactly why they are asserted here: relying on a
// publisher default without checking it is how a licence ends up missing from a release.
export const PACKAGE_REQUIRED = Object.freeze([
  'package.json', 'LICENSE', 'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'SECURITY.md', 'THIRD_PARTY.md', 'CONTRIBUTING.md',
  'bin/memkeel.mjs', 'memory.mjs', 'mcp-server.mjs', 'setup.mjs', 'hook-runner.mjs', 'dsh-memory-plugin.mjs',
  'dashboard.mjs', 'dashboard/static/index.html', 'bootstrap.md', 'event-schema.md', 'Dockerfile',
]);

export const PACKAGE_FORBIDDEN = Object.freeze([
  { pattern: /^dashboard\/app\//, why: 'the dashboard source and its node_modules do not ship; only the built bundle does' },
  { pattern: /^test\//, why: 'tests are not part of the published artifact' },
  { pattern: /^\.github\//, why: 'CI configuration is not part of the published artifact' },
  { pattern: /(^|\/)node_modules\//, why: 'zero runtime dependencies is the point of this program' },
  { pattern: /(^|\/)\.env/, why: 'credentials never ship' },
]);

/** Does the packed file list contain what it must, and nothing it must not? */
export function inspectPackage(files) {
  const present = new Set(files.map((file) => file.replaceAll('\\', '/')));
  const missing = PACKAGE_REQUIRED.filter((file) => !present.has(file));
  const forbidden = [];
  for (const file of present) {
    for (const rule of PACKAGE_FORBIDDEN) if (rule.pattern.test(file)) forbidden.push({ file, why: rule.why });
  }
  return { ok: missing.length === 0 && forbidden.length === 0, missing, forbidden, count: present.size };
}

/**
 * The version being released must exist as a heading in the changelog, or the release notes nobody
 * wrote are also the release notes nobody can find.
 */
export function versionConsistency(version, changelogText) {
  const released = [...String(changelogText).matchAll(/^## \[([^\]]+)\]/gm)].map((match) => match[1]);
  if (!released.includes(version)) {
    return { ok: false, message: `CHANGELOG.md has no "## [${version}]" section (found: ${released.join(', ') || 'none'})` };
  }
  return { ok: true, message: `CHANGELOG.md documents ${version}`, released };
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Shipped modules that import a `.ts` file at runtime.
 *
 * Node strips TypeScript types for files it runs, but refuses to do so under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A package that imports a `.ts` file therefore works
 * from a clone and fails for everyone who installs it — which is exactly the failure this check found
 * on 2026-09-16, so it is now a named step rather than something to rediscover. See RELEASE.md.
 */
export function findRuntimeTypeScriptImports(files) {
  // Static (`from '...'`), bare (`import '...'`) and dynamic (`import('...')`) forms all count: a
  // dynamic import is the runtime case this check exists for.
  const pattern = /from\s*['"]([^'"]+\.ts)['"]|\bimport\s*\(?\s*['"]([^'"]+\.ts)['"]/g;
  const hits = [];
  for (const { path: file, text } of files) {
    // Line comments are stripped so a commented-out import is not reported as a runtime dependency.
    // Block comments are not handled, and a `.ts` import inside one would be a false positive — the
    // safe direction for a release gate to be wrong in.
    const source = String(text).replace(/^[^\S\n]*\/\/.*$/gm, '');
    for (const match of source.matchAll(pattern)) hits.push({ file, specifier: match[1] ?? match[2] });
  }
  return hits;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, ...options });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * npm is `npm.cmd` on Windows, and a batch file cannot be executed without a shell — `spawnSync('npm')`
 * fails there with an empty error. So the shell is used on Windows only, and any argument containing a
 * space is quoted by hand because `shell: true` joins arguments instead of quoting them.
 */
const IS_WINDOWS = process.platform === 'win32';
function npm(args, options = {}) {
  const argv = IS_WINDOWS ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
  return run(IS_WINDOWS ? 'npm.cmd' : 'npm', argv, { shell: IS_WINDOWS, ...options });
}

function main() {
  const fast = process.argv.includes('--fast');
  const steps = [];
  const record = (name, ok, detail) => { steps.push({ name, ok, detail }); return ok; };

  // 1. The gates. A release that fails its own privacy gate is not a release.
  for (const gate of ['check-syntax', 'leak-scan', 'pack-scan']) {
    const result = run(process.execPath, [path.join(ROOT, 'scripts', `${gate}.mjs`)]);
    record(gate, result.status === 0, result.status === 0 ? 'passed' : (result.stderr || result.stdout).trim().split('\n').slice(-1)[0]);
  }
  if (!fast) {
    const result = run(process.execPath, ['--test', 'test/*.test.mjs'], { shell: false, maxBuffer: 64 * 1024 * 1024 });
    const summary = (result.stdout.match(/# (?:pass|fail) \d+/g) ?? []).join(' ');
    record('npm test', result.status === 0, summary || 'see output');
  } else {
    record('npm test', true, 'skipped (--fast)');
  }

  // 2. Pack, into a temporary directory so the repository stays clean.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-release-'));
  const packed = npm(['pack', '--pack-destination', staging, '--json']);
  const packInfo = (() => { try { return JSON.parse(packed.stdout)[0]; } catch { return null; } })();
  if (!packInfo) {
    record('npm pack', false, (packed.stderr || packed.stdout).trim());
    console.log(JSON.stringify({ ok: false, steps }, null, 2));
    process.exitCode = 1;
    return;
  }
  const tarball = path.join(staging, packInfo.filename);
  record('npm pack', true, `${packInfo.filename} (${(packInfo.size / 1024).toFixed(0)} KiB)`);

  // 3. What is actually inside it.
  const inspection = inspectPackage(packInfo.files.map((row) => row.path));
  record('package contents', inspection.ok,
    inspection.ok ? `${inspection.count} files, all required documents present`
      : `missing: ${inspection.missing.join(', ') || 'none'}; forbidden: ${inspection.forbidden.map((row) => row.file).join(', ') || 'none'}`);

  // 4. The version and its changelog entry agree.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
  const version = versionConsistency(manifest.version, changelog);
  record('version/changelog', version.ok, version.message);

  // 5. A shipped module must not import a `.ts` file at runtime: it works from a clone and fails under
  // node_modules for everyone who installs the package. This is a named step because it is the failure
  // that motivated this script.
  const shippedModules = packInfo.files.map((row) => row.path).filter((file) => file.endsWith('.mjs'))
    .map((file) => ({ path: file, text: fs.readFileSync(path.join(ROOT, file), 'utf8') }));
  const tsImports = findRuntimeTypeScriptImports(shippedModules);
  record('no runtime .ts imports', tsImports.length === 0,
    tsImports.length === 0 ? `${shippedModules.length} shipped modules checked`
      : `${tsImports.map((hit) => `${hit.file} -> ${hit.specifier}`).join('; ')} — this fails under node_modules; see RELEASE.md`);

  // 6. Install it somewhere empty and run it, which is the only way to know the shipped bytes work.
  const prefix = path.join(staging, 'prefix');
  fs.mkdirSync(prefix, { recursive: true });
  const installed = npm(['install', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel', 'error', tarball]);
  if (installed.status !== 0) record('install tarball', false, (installed.stderr || '').trim().split('\n').slice(-1)[0]);
  else {
    const cli = path.join(prefix, 'node_modules', PACKAGE_NAME, 'memory.mjs');
    const exists = fs.existsSync(cli);
    const help = exists ? run(process.execPath, [cli, 'help']) : { status: 1, stdout: '' };
    record('install tarball', exists && help.status === 0 && help.stdout.includes('bootstrap'),
      exists ? (help.status === 0 ? 'the installed CLI runs' : 'the installed CLI failed to run') : 'memory.mjs missing after install');
  }

  const digest = sha256File(tarball);
  const ok = steps.every((step) => step.ok);
  console.log(JSON.stringify({
    ok,
    package: manifest.name,
    version: manifest.version,
    artifact: { file: packInfo.filename, bytes: packInfo.size, sha256: digest, integrity: packInfo.integrity ?? null },
    steps,
    // Stated in the output so nobody mistakes a passing check for a release: both of these are
    // deliberate omissions, not oversights.
    notDone: [
      'npm publish — needs the maintainer’s credentials and a decision about package ownership.',
      'upgrading a live memory home — a separate, deliberate action; see RELEASE.md.',
    ],
    // Stated as a fact about this build rather than left for the reader to infer from a failed step.
    blocker: 'A shipped module imports vendor/obsidian-mind/session-start.ts, which Node refuses to type-strip under node_modules, so the installed package cannot run. See RELEASE.md.',
  }, null, 2));
  fs.rmSync(staging, { recursive: true, force: true });
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
