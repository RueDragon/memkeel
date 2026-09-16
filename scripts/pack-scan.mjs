#!/usr/bin/env node
// Packaged-artifact gate.
//
// The source tree being clean says nothing about what `npm pack` actually ships. `files`
// in package.json, npm's always-included defaults and the ignore rules together decide
// the real contents, so the only trustworthy check runs on the real tarball: pack it,
// unpack it, verify the file list against what was declared, and scan the unpacked text
// with the same rules the source gate uses.
//
// This is the "package" scope. It is deliberately separate from:
//   - source scope:    npm run leak-scan   (the working tree)
//   - history scope:   not automated here; reviewing rewritten or dangling objects is a
//                      separate, explicitly scoped task.
//
// Nothing is written inside the repository: the tarball and the unpacked tree live in a
// temporary directory that is removed on every exit path.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describeCoverage, loadPrivateTerms, scanTree } from './leak-scan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// npm publishes these regardless of `files`.
const ALWAYS_INCLUDED = new Set(['package.json', 'README.md', 'README', 'LICENSE', 'LICENSE.md', 'LICENCE', 'LICENCE.md']);

/**
 * A packed path is declared when it is an always-included name or lives under a `files`
 * entry. An undeclared file means the artifact ships something the manifest does not
 * admit to, which is exactly how private fixtures reach a public tarball.
 */
export function isDeclared(file, entries) {
  if (ALWAYS_INCLUDED.has(file)) return true;
  // An always-included name only counts at the top level; `docs/LICENSE` is not a licence npm added.
  if (!file.includes('/') && ALWAYS_INCLUDED.has(path.basename(file))) return true;
  return entries.some((entry) => {
    const clean = entry.replace(/\/+$/, '');
    return file === clean || file.startsWith(`${clean}/`);
  });
}

/** Files the tarball shipped that `package.json` does not declare. */
export function undeclaredFiles(paths, entries) {
  return paths.filter((file) => !isDeclared(file, entries));
}

function fail(message) {
  console.error(`pack-scan: ${message}`);
  process.exit(1);
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = Array.isArray(pkg.files) ? pkg.files : [];

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-pack-'));
  try {
    const packed = spawnSync('npm', ['pack', '--pack-destination', temp, '--json'], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    });
    if (packed.status !== 0) fail(`npm pack failed: ${(packed.stderr || packed.stdout || '').trim()}`);

    let report;
    try {
      report = JSON.parse(packed.stdout)[0];
    } catch {
      fail(`could not read the npm pack report: ${packed.stdout.trim().slice(0, 400)}`);
    }
    const tarball = path.join(temp, report.filename);

    const extractDir = path.join(temp, 'unpacked');
    fs.mkdirSync(extractDir, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', extractDir], { encoding: 'utf8', windowsHide: true });
    if (untar.status !== 0) fail(`could not unpack ${report.filename}: ${(untar.stderr || '').trim()}`);

    const packageDir = path.join(extractDir, 'package');
    if (!fs.existsSync(packageDir)) fail('the tarball has no package/ directory');

    // 1. File list: every shipped path must be declared.
    const shipped = (report.files ?? []).map((entry) => entry.path);
    const unexpected = undeclaredFiles(shipped, declared);

    // 2. Text content: the same rules as the source gate, plus the external private terms.
    const privateTerms = loadPrivateTerms(process.env.MEMKEEL_LEAK_TERMS_FILE);
    const result = scanTree(packageDir, { privateTerms });
    const coverage = describeCoverage(result);

    console.log(`pack-scan: ${report.filename} - ${shipped.length} file(s), ${report.size} B packed, ${report.unpackedSize} B unpacked`);
    if (unexpected.length) {
      console.error(`pack-scan: ${unexpected.length} shipped file(s) are not declared in package.json "files":`);
      for (const file of unexpected) console.error(`  ${file}`);
    } else {
      console.log('pack-scan: every shipped file is declared in package.json "files"');
    }
    for (const hit of result.hits) console.error(`${hit.file}:${hit.line}: [${hit.id}]`);
    if (result.hits.length) console.error(`pack-scan: ${result.hits.length} hit(s) inside the packaged artifact.`);
    else console.log(`leak-scan: clean (${result.scanned} files scanned in the artifact)`);
    if (coverage) console.log(`leak-scan: coverage: ${coverage} - files that were not inspected are not covered by this result.`);

    if (unexpected.length || result.hits.length) process.exitCode = 1;
    else console.log('pack-scan: OK');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
