#!/usr/bin/env node
// Leak gate.
//
// Fails when the working tree contains anything that must never reach a public
// repository: real user-profile paths, private vault names, personal project
// identifiers, private email addresses or credentials.
//
// This file is scanned too. Keep maintainer-specific identifiers outside the repository.
// MEMKEEL_LEAK_TERMS_FILE optionally points to a private JSON array of literal terms.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.zip', '.gz', '.zstd', '.pdf', '.lock']);

const PATTERNS = [
  // Absolute Windows paths into a real profile. Documented and fixture placeholders
  // such as C:/Users/<you>/... or C:/Users/demo/... are allowed on purpose.
  ['windows-user-path', /[A-Za-z]:[\\/]{1,2}Users[\\/](?!<[a-z-]+>|(?:demo|example|you|your-name|user|sample|test|me)\b)[^\\/\s"')]+/g],
  ['qq-email', /\b\d{5,12}@qq\.com\b/gi],
  // A lockfile must resolve every package from the public registry. A mirror, a corporate
  // proxy or a personal registry configured in `resolved` publishes infrastructure that is
  // none of the repository's business — and it also breaks `npm ci` on a machine that
  // cannot reach that host. This rule is deliberately generic: naming a specific employer
  // inside this file would itself publish the name.
  ['lockfile-nonpublic-registry', /"resolved":\s*"(?!https:\/\/registry\.npmjs\.org\/)[^"]+"/g],
  // Nexus and Artifactory serve packages from a /repository/ or /artifactory/ path, which no
  // public registry URL uses.
  ['private-registry-url', /\bhttps?:\/\/[^\s"'`)\]<>]+\/(?:repository|artifactory)\//gi],
  // Host suffixes that are private by definition.
  ['private-host-suffix', /\bhttps?:\/\/[^\s"'`)\]<>]+\.(?:internal|corp|intranet|lan)\b/gi],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['access-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['api-key', /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g],
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(path.join(dir, entry.name));
    } else {
      yield path.join(dir, entry.name);
    }
  }
}

const termsFile = process.env.MEMKEEL_LEAK_TERMS_FILE;
const privateTerms = termsFile ? JSON.parse(fs.readFileSync(termsFile, 'utf8')) : [];
if (!Array.isArray(privateTerms) || privateTerms.some((term) => typeof term !== 'string' || !term.trim())) {
  throw new Error('Private leak terms must be a JSON array of non-empty strings');
}
const hits = [];
let scanned = 0;
for (const file of walk(root)) {
  const rel = path.relative(root, file);
  if (SKIP_EXT.has(path.extname(file).toLowerCase())) continue;
  let content;
  try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
  scanned += 1;
  for (const term of privateTerms) {
    const at = content.toLowerCase().indexOf(term.toLowerCase());
    if (at >= 0) hits.push({ id: 'private-term', file: rel, line: content.slice(0, at).split('\n').length });
  }
  for (const [id, re] of PATTERNS) {
    for (const match of content.matchAll(re)) {
      hits.push({ id, file: rel, line: content.slice(0, match.index).split('\n').length, match: match[0].slice(0, 100) });
    }
  }
}

if (hits.length) {
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: [${hit.id}]`);
  console.error(`\nleak-scan: ${hits.length} hit(s) across ${scanned} files — a public release must be clean.`);
  process.exit(1);
}
console.log(`leak-scan: clean (${scanned} files scanned)`);
