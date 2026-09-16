#!/usr/bin/env node
// Generate runnable ES modules from the vendored TypeScript (REL-01 follow-up).
//
// Why this exists: `lib/core.mjs` imported `vendor/obsidian-mind/session-start.ts` at runtime. Node strips
// TypeScript types for files it runs, but refuses to do so *under `node_modules`*
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the published package failed on every command while
// a git clone worked. Verified 2026-09-16 by `scripts/release-check.mjs`.
//
// The fix is not to hand-convert the vendored files. They are 28 KB of real TypeScript with `export type`,
// `readonly` modifiers and an import of a second `.ts` file; rewriting them by hand would be error-prone
// and would diverge from the upstream copy that THIRD_PARTY.md pins. Instead the `.mjs` files are
// *generated* from the pinned `.ts` sources using Node's own type stripper — the same mechanism that was
// already stripping them in memory when the program ran from a checkout, so the published module behaves
// exactly as the vendored source did.
//
// The generated files are committed, because the published package must contain runnable JavaScript and
// must not depend on a build step at install time. `--check` verifies they are in sync with the `.ts`
// sources, which is what stops a vendored update from silently going stale.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENDOR_DIR = path.join(ROOT, 'vendor', 'obsidian-mind');

/** Every vendored `.ts` that is imported at runtime, in dependency order. */
export const VENDOR_SOURCES = Object.freeze(['regex.ts', 'session-start.ts']);

const GENERATED_BANNER = `// GENERATED FILE — do not edit.
// Type-stripped from the pinned upstream \`%SOURCE%\` by \`scripts/build-vendor.mjs\`.
// The \`.ts\` file next to this one is the vendored source of record (see THIRD_PARTY.md);
// this copy exists so the published package can be imported from anywhere, including
// node_modules, where Node refuses to strip TypeScript types.
`;

/**
 * Rewrite the specifiers of relative imports so a stripped module imports its stripped sibling.
 *
 * Only relative specifiers ending in `.ts` are touched: a bare package specifier is not a file in this
 * directory, and an already-correct `.mjs` specifier must stay as it is.
 */
export function rewriteRelativeTypeScriptSpecifiers(code) {
  return code.replace(/(from\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1$2.mjs$3')
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+)\.ts(['"]\s*\))/g, '$1$2.mjs$3')
    .replace(/(\bbare\s+)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.mjs$2');
}

/** The exact bytes a generated module should contain, from the `.ts` source of record. */
export function renderVendorModule(sourceName) {
  const source = fs.readFileSync(path.join(VENDOR_DIR, sourceName), 'utf8');
  const stripped = stripTypeScriptTypes(source, { mode: 'strip' });
  const rewritten = rewriteRelativeTypeScriptSpecifiers(stripped);
  return `${GENERATED_BANNER.replace('%SOURCE%', sourceName)}\n${rewritten}`;
}

export function vendorTarget(sourceName) {
  return path.join(VENDOR_DIR, sourceName.replace(/\.ts$/, '.mjs'));
}

/** Compare what is on disk with what would be generated. Writes nothing. */
export function checkVendorModules() {
  const rows = [];
  for (const source of VENDOR_SOURCES) {
    const target = vendorTarget(source);
    const expected = renderVendorModule(source);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    rows.push({ source, target: path.relative(ROOT, target).replaceAll('\\', '/'), ok: actual === expected, generated: actual !== null });
  }
  return { ok: rows.every((row) => row.ok), rows };
}

function main() {
  const check = process.argv.includes('--check');
  let failed = false;
  for (const source of VENDOR_SOURCES) {
    const target = vendorTarget(source);
    const expected = renderVendorModule(source);
    const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    const relative = path.relative(ROOT, target).replaceAll('\\', '/');
    if (actual === expected) { console.log(`${check ? 'in sync' : 'unchanged'}: ${relative}`); continue; }
    if (check) { failed = true; console.error(`OUT OF SYNC: ${relative} — run \`node scripts/build-vendor.mjs\``); continue; }
    fs.writeFileSync(target, expected);
    console.log(`wrote: ${relative} (${Buffer.byteLength(expected)} bytes)`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
