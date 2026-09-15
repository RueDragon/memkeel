#!/usr/bin/env node
// Syntax gate: `node --check` every first-party JavaScript module. Third-party
// bundles (vendor/, dashboard/static/) and installed dependencies are skipped
// because they are not ours to fix.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'static', 'vendor']);
// Only extensions Node itself can parse: the dashboard's JSX is compiled by Vite,
// so `node --check` cannot be applied to it.
const EXT = new Set(['.mjs', '.js']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else if (EXT.has(path.extname(entry.name))) {
      yield path.join(dir, entry.name);
    }
  }
}

const files = [...walk(root)].sort();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push({ file: path.relative(root, file), error: (result.stderr || '').trim() });
}
if (failures.length) {
  for (const row of failures) console.error(`FAIL ${row.file}\n${row.error}\n`);
  console.error(`check-syntax: ${failures.length} of ${files.length} files failed`);
  process.exit(1);
}
console.log(`check-syntax: ${files.length} files OK`);
