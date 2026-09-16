#!/usr/bin/env node
// Leak gate.
//
// Fails when a tree contains anything that must never reach a public repository: real
// user-profile paths, private vault names, personal project identifiers, private email
// addresses, non-public package registries or credentials.
//
// Two layers, deliberately separated:
//
//   1. The generic rules in RULES. They are safe to publish and ship with the project.
//      A rule that named a specific employer, customer or private project would itself
//      publish that name, so rules stay generic.
//   2. A private term list supplied from OUTSIDE the repository through
//      MEMKEEL_LEAK_TERMS_FILE: a JSON array of literal strings. Never commit it.
//
// Diagnostics never print a matched value. A CI log on a public repository is itself
// public, so echoing the hit would publish exactly what this gate exists to keep out.
// Hits are reported as file, line and rule id only.
//
// Coverage is reported honestly. Files this scanner cannot read as text are NOT
// inspected, and the summary always states how many were skipped, so a "clean" result is
// never mistaken for a guarantee about binary files, fonts, archives or screenshots.
//
// This file is scanned by itself. Keep maintainer-specific identifiers outside the
// repository; see CONTRIBUTING.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SELF_DIR, '..');

// Directories that never hold first-party text worth scanning.
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist']);

// Extensions skipped as non-text. This is a *coverage limitation*, not a safety
// conclusion: a screenshot of a private vault or a PDF of an internal page would pass
// this gate. Source maps (.map) are deliberately NOT skipped, because they embed the
// original sources and therefore carry the same paths as the source tree.
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.tiff', '.heic', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.zstd', '.7z', '.rar',
  '.pdf', '.lock', '.sqlite', '.db',
  '.wasm', '.exe', '.dll', '.so', '.dylib', '.node', '.bin', '.class', '.jar',
  '.mp3', '.mp4', '.mov', '.webm', '.wav', '.ogg',
]);

// Rule set: [id, regex]. Ids appear in diagnostics; changing one is a visible change.
export const RULES = [
  // Absolute paths into a real user profile. Documented and fixture placeholders such as
  // C:/Users/<you>/..., C:/Users/demo/... or /home/<name>/ are allowed on purpose, so
  // that a template path is not reported as a leak.
  ['windows-user-path', /[A-Za-z]:[\\/]{1,2}Users[\\/](?!<[a-z-]+>|(?:demo|example|you|your-name|user|sample|test|me)\b)[^\\/\s"')]+/g],
  ['macos-user-path', /\/Users\/(?!<[a-z-]+>|(?:Shared|demo|example|you|your-name|user|sample|test|me)\b)[^/\s"')]+/g],
  ['linux-user-path', /\/home\/(?!<[a-z-]+>|(?:demo|example|you|your-name|user|sample|test|me|runner|node|app|linuxbrew)\b)[^/\s"')]+/g],
  ['qq-email', /\b\d{5,12}@qq\.com\b/gi],
  // A lockfile must resolve every package from the public registry. A mirror, a corporate
  // proxy or a personal registry configured in `resolved` publishes infrastructure that is
  // none of the repository's business - and it also breaks `npm ci` on a machine that
  // cannot reach that host. This rule is deliberately generic: naming a specific employer
  // inside this file would itself publish the name.
  ['lockfile-nonpublic-registry', /"resolved":\s*"(?!https:\/\/registry\.npmjs\.org\/)[^"]+"/g],
  // The same intent for .npmrc: a registry other than the public one, or an inline token.
  ['npmrc-registry', /^[ \t]*registry[ \t]*=[ \t]*(?!https:\/\/registry\.npmjs\.org\/?[ \t]*$)\S+/gm],
  ['npmrc-auth-token', /_authToken[ \t]*=[ \t]*\S+/g],
  // Nexus and Artifactory serve packages from a /repository/ or /artifactory/ path, which no
  // public registry URL uses.
  ['private-registry-url', /\bhttps?:\/\/[^\s"'`)\]<>]+\/(?:repository|artifactory)\//gi],
  // Host suffixes that are private by definition.
  ['private-host-suffix', /\bhttps?:\/\/[^\s"'`)\]<>]+\.(?:internal|corp|intranet|lan)\b/gi],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['access-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['api-key', /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g],
];

/** A bad invocation or unusable input. Distinct from "the tree has leaks". */
export class LeakInputError extends Error {}

/**
 * Read the private term list from a file outside the repository.
 * Throws LeakInputError (never a raw fs/JSON stack) so a misconfigured gate fails with
 * one actionable line and a non-zero exit code.
 */
export function loadPrivateTerms(termsFile) {
  if (!termsFile) return [];
  let raw;
  try {
    raw = fs.readFileSync(termsFile, 'utf8');
  } catch (error) {
    throw new LeakInputError(`Cannot read the private terms file ${termsFile} (${error.code ?? error.message}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new LeakInputError(`The private terms file ${termsFile} is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((term) => typeof term !== 'string' || !term.trim())) {
    throw new LeakInputError(`The private terms file ${termsFile} must be a JSON array of non-empty strings.`);
  }
  return parsed;
}

/**
 * Scan a directory tree.
 *
 * Symlinks are never followed: a link is reported as not inspected instead of being
 * silently resolved, so the scan boundary is always the directory that was asked for and
 * a link cannot pull a file from outside the tree into a "clean" result.
 *
 * @returns {{hits: Array<{id: string, file: string, line: number}>, scanned: number,
 *   skippedExtensions: Map<string, number>, binary: string[], symlinks: string[]}}
 */
export function scanTree(root, { privateTerms = [] } = {}) {
  const hits = [];
  const skippedExtensions = new Map();
  const binary = [];
  const symlinks = [];
  let scanned = 0;

  const walk = (dir, relDir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        symlinks.push(rel);
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs, rel);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) {
        skippedExtensions.set(ext, (skippedExtensions.get(ext) ?? 0) + 1);
        continue;
      }
      let buffer;
      try {
        buffer = fs.readFileSync(abs);
      } catch {
        continue;
      }
      // A NUL byte means this is not the text the rules were written for. Reporting it as
      // unread keeps the coverage statement true instead of scanning mojibake.
      if (buffer.includes(0)) {
        binary.push(rel);
        continue;
      }
      const content = buffer.toString('utf8');
      scanned += 1;
      const lower = content.toLowerCase();
      for (const term of privateTerms) {
        const needle = term.toLowerCase();
        let at = lower.indexOf(needle);
        while (at >= 0) {
          hits.push({ id: 'private-term', file: rel, line: content.slice(0, at).split('\n').length });
          at = lower.indexOf(needle, at + needle.length);
        }
      }
      for (const [id, rule] of RULES) {
        for (const match of content.matchAll(rule)) {
          hits.push({ id, file: rel, line: content.slice(0, match.index).split('\n').length });
        }
      }
    }
  };

  walk(root, '');
  return { hits, scanned, skippedExtensions, binary, symlinks };
}

/** Human-readable coverage limitation, or '' when everything was inspected. */
export function describeCoverage(result) {
  const parts = [];
  const skipped = [...result.skippedExtensions.values()].reduce((sum, count) => sum + count, 0);
  if (skipped) {
    const detail = [...result.skippedExtensions.entries()].sort().map(([ext, count]) => `${ext} x${count}`).join(', ');
    parts.push(`${skipped} non-text file(s) not inspected (${detail})`);
  }
  if (result.binary.length) parts.push(`${result.binary.length} binary file(s) not inspected`);
  if (result.symlinks.length) parts.push(`${result.symlinks.length} symlink(s) not followed`);
  return parts.join('; ');
}

function usage() {
  return 'Usage: node scripts/leak-scan.mjs [--root DIR] [--json]';
}

function main(argv) {
  let root = DEFAULT_ROOT;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new LeakInputError(`--root needs a directory.\n${usage()}`);
      root = path.resolve(value);
      i += 1;
    } else if (arg === '--json') {
      json = true;
    } else {
      throw new LeakInputError(`Unknown argument: ${arg}\n${usage()}`);
    }
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new LeakInputError(`Not a directory to scan: ${root}`);
  }

  const privateTerms = loadPrivateTerms(process.env.MEMKEEL_LEAK_TERMS_FILE);
  const result = scanTree(root, { privateTerms });
  const coverage = describeCoverage(result);

  if (json) {
    console.log(JSON.stringify({
      root,
      scanned: result.scanned,
      hits: result.hits,
      skippedExtensions: Object.fromEntries([...result.skippedExtensions.entries()].sort()),
      binary: result.binary,
      symlinks: result.symlinks,
      privateTerms: privateTerms.length,
    }, null, 2));
  } else {
    for (const hit of result.hits) console.error(`${hit.file}:${hit.line}: [${hit.id}]`);
    if (result.hits.length) {
      console.error(`\nleak-scan: ${result.hits.length} hit(s) across ${result.scanned} files - a public release must be clean.`);
    } else {
      console.log(`leak-scan: clean (${result.scanned} files scanned)`);
    }
    if (coverage) console.log(`leak-scan: coverage: ${coverage} - files that were not inspected are not covered by this result.`);
  }
  if (result.hits.length) process.exitCode = 1;
}

// Only run as a CLI; pack-scan.mjs imports scanTree and must not trigger a scan of the
// repository as a side effect of the import.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof LeakInputError) {
      console.error(`leak-scan: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
