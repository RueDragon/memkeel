#!/usr/bin/env node
// Runtime-directory sync.
//
// The directory the hooks and the MCP server actually execute is a copy of the published
// artifact, not the checkout. `npm pack` decides that copy's file list, so the two drift the
// moment someone edits the checkout and does not copy the change across — and the drift is
// invisible from both sides: the checkout is clean, the runtime directory is complete, and
// the only symptom is a hook that behaves like last week's code.
//
// This script makes "the runtime directory is exactly the published artifact" a command
// instead of a habit. `--check` reports drift and writes nothing, the way
// `scripts/build-vendor.mjs --check` reports an out-of-sync vendored module; without it the
// target is rebuilt from the real tarball, read back for verification, and the previous copy
// is kept as a rollback directory.
//
// Two deliberate limits: it writes nothing inside the repository, and it hardcodes no
// machine's path — the target comes from `--into` or `MEMKEEL_APP_DIR`, so the repository
// stays publishable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectPackage } from './release-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_NAME = 'memkeel';
const USAGE = [
  'Usage: node scripts/sync-app.mjs --into DIR [--check] [--from TARBALL] [--force]',
  '',
  '  --into DIR      the runtime directory to rebuild (or MEMKEEL_APP_DIR)',
  '  --check         report drift against the artifact; writes nothing, exits 1 on drift',
  '  --from TARBALL  sync from an existing .tgz instead of packing the checkout',
  '  --force         replace a target that is not an existing memkeel copy',
].join('\n');

/** Sorted POSIX-relative paths of every file under a directory. */
export function listTree(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) found.push(path.relative(dir, full).replaceAll('\\', '/'));
    }
  };
  walk(dir);
  return found.sort();
}

/** SHA-256 of a file, lowercase hex. */
export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * Compare an artifact tree with the directory that is supposed to hold it.
 * @param expectedDir The unpacked artifact.
 * @param actualDir The runtime directory.
 * @returns `missing` (in the artifact, absent here), `extra` (here, not in the artifact),
 *   `differing` (present in both with different bytes) and the count of matching files.
 */
export function compareTrees(expectedDir, actualDir) {
  const expected = listTree(expectedDir);
  const actual = listTree(actualDir);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((file) => !actualSet.has(file));
  const extra = actual.filter((file) => !expectedSet.has(file));
  const differing = expected.filter((file) => actualSet.has(file)
    && sha256File(path.join(expectedDir, file)) !== sha256File(path.join(actualDir, file)));
  return { missing, extra, differing, identical: expected.length - missing.length - differing.length };
}

/** Recursive copy of files and directories; an existing target file is replaced. */
export function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

/**
 * Pack the checkout, or accept a tarball that was packed earlier, and unpack it.
 * @param options.from An existing `.tgz`; when absent the checkout is packed.
 * @returns The temporary directory to remove, the tarball, the unpacked `package/` tree and
 *   the shipped file list.
 */
export function buildArtifact({ from } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-sync-'));
  let tarball = from ? path.resolve(from) : null;
  if (!tarball) {
    const packed = spawnSync('npm', ['pack', '--pack-destination', temp, '--json'], {
      cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32',
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${(packed.stderr || packed.stdout || '').trim()}`);
    let report;
    try {
      report = JSON.parse(packed.stdout)[0];
    } catch {
      throw new Error(`could not read the npm pack report: ${packed.stdout.trim().slice(0, 400)}`);
    }
    tarball = path.join(temp, report.filename);
  }
  if (!fs.existsSync(tarball)) throw new Error(`no such tarball: ${tarball}`);

  const unpacked = path.join(temp, 'unpacked');
  fs.mkdirSync(unpacked, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', tarball, '-C', unpacked], { encoding: 'utf8', windowsHide: true });
  if (untar.status !== 0) throw new Error(`could not unpack ${path.basename(tarball)}: ${(untar.stderr || '').trim()}`);
  const packageDir = path.join(unpacked, 'package');
  if (!fs.existsSync(packageDir)) throw new Error('the tarball has no package/ directory');
  return { temp, tarball, packageDir, filename: path.basename(tarball), files: listTree(packageDir) };
}

function parseArgs(argv) {
  const options = { into: process.env.MEMKEEL_APP_DIR ?? null, check: false, from: null, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--into') options.into = argv[index += 1];
    else if (arg === '--from') options.from = argv[index += 1];
    else if (arg === '--check') options.check = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); return null; }
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (!options.into) throw new Error(`no target directory: pass --into DIR or set MEMKEEL_APP_DIR\n${USAGE}`);
  return options;
}

/**
 * Refuse a target this script has no business replacing: the checkout itself, or a directory
 * that is not an existing memkeel copy. Replacing the wrong directory is not recoverable by
 * a later `--check`, so it fails closed and asks for `--force`.
 */
function assertTarget(target, { force }) {
  const inside = path.relative(ROOT, target);
  if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
    throw new Error(`refusing to sync into the checkout itself: ${target}`);
  }
  if (!fs.existsSync(target)) return { exists: false };
  const manifest = path.join(target, 'package.json');
  if (!fs.existsSync(manifest)) {
    if (fs.readdirSync(target).length && !force) {
      throw new Error(`refusing to replace ${target}: it has no package.json and is not empty (pass --force to replace it anyway)`);
    }
    return { exists: true, name: null };
  }
  const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
  if (name !== PACKAGE_NAME && !force) {
    throw new Error(`refusing to replace ${target}: its package.json names "${name}", not "${PACKAGE_NAME}" (pass --force to replace it anyway)`);
  }
  return { exists: true, name };
}

/** Rollback directories this script wrote next to the target, oldest first. */
function rollbackSiblings(target) {
  const parent = path.dirname(target);
  const prefix = `${path.basename(target)}.rollback-`;
  return fs.readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && /^\d+(-\d+)?$/.test(entry.name.slice(prefix.length)))
    .map((entry) => ({ full: path.join(parent, entry.name) }))
    .filter((row) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(row.full, 'package.json'), 'utf8')).name === PACKAGE_NAME;
      } catch {
        return false;
      }
    })
    // Sorted by time rather than by the name's number: two syncs inside one millisecond would
    // otherwise compare equal and the wrong copy would be pruned.
    .map((row) => ({ ...row, at: fs.statSync(row.full).mtimeMs }))
    .sort((left, right) => left.at - right.at);
}

function report(message) {
  console.error(`sync-app: ${message}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;
  const target = path.resolve(options.into);
  assertTarget(target, options);

  let artifact = null;
  try {
    artifact = buildArtifact({ from: options.from });

    // The artifact has to be a complete package before it is allowed to become the runtime
    // directory: syncing a tarball that lost its CLI would replace a working copy with a
    // broken one, which is worse than the drift this script exists to remove.
    const declared = inspectPackage(artifact.files);
    if (!declared.ok) {
      const reasons = [];
      if (declared.missing.length) reasons.push(`missing ${declared.missing.join(', ')}`);
      if (declared.forbidden.length) reasons.push(`forbidden ${declared.forbidden.map((row) => row.file).join(', ')}`);
      throw new Error(`the artifact is not a complete package: ${reasons.join('; ')}`);
    }

    if (options.check) {
      if (!fs.existsSync(target)) throw new Error(`OUT OF SYNC: ${target} does not exist — run \`node scripts/sync-app.mjs --into ${options.into}\``);
      const diff = compareTrees(artifact.packageDir, target);
      if (diff.missing.length || diff.extra.length || diff.differing.length) {
        for (const file of diff.differing) report(`  differs: ${file}`);
        for (const file of diff.missing) report(`  missing: ${file}`);
        for (const file of diff.extra) report(`  extra:   ${file}`);
        throw new Error(`OUT OF SYNC: ${target} — ${diff.differing.length} differ, ${diff.missing.length} missing, ${diff.extra.length} extra against ${artifact.filename} — run \`node scripts/sync-app.mjs --into ${options.into}\``);
      }
      console.log(`in sync: ${target} (${diff.identical} file(s) match ${artifact.filename})`);
      return;
    }

    // Write a staging copy beside the target, verify it, and only then swap. A half-written
    // runtime directory is the failure this order exists to prevent.
    const staging = `${target}.staging-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    copyTree(artifact.packageDir, staging);
    const staged = compareTrees(artifact.packageDir, staging);
    if (staged.missing.length || staged.extra.length || staged.differing.length) {
      throw new Error(`the staged copy does not match the artifact (${staged.differing.length} file(s) differ after writing)`);
    }

    const existed = fs.existsSync(target);
    // Two syncs inside the same millisecond must not collide on the rollback name, or the
    // second one would try to rename onto a directory that is already there.
    let rollback = `${target}.rollback-${Date.now()}`;
    for (let suffix = 1; fs.existsSync(rollback); suffix += 1) rollback = `${target}.rollback-${Date.now()}-${suffix}`;
    if (existed) fs.renameSync(target, rollback);
    try {
      fs.renameSync(staging, target);
    } catch (error) {
      if (existed && !fs.existsSync(target)) fs.renameSync(rollback, target);
      throw new Error(`could not replace ${target}: ${error.message}`);
    }

    const written = compareTrees(artifact.packageDir, target);
    if (written.missing.length || written.extra.length || written.differing.length) {
      fs.rmSync(target, { recursive: true, force: true });
      if (existed) fs.renameSync(rollback, target);
      throw new Error('the written directory does not match the artifact; the previous copy was put back');
    }

    // One rollback is the point; a growing pile of them is just disk. Only directories this
    // script named and that hold a memkeel package are removed.
    for (const stale of rollbackSiblings(target).slice(0, -1)) fs.rmSync(stale.full, { recursive: true, force: true });

    console.log(`wrote: ${target} (${written.identical} file(s) from ${artifact.filename})`);
    if (existed) console.log(`rollback: ${rollback}`);
  } finally {
    if (artifact) fs.rmSync(artifact.temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    report(error.message);
    process.exitCode = 1;
  }
}
