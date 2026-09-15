import fs from 'node:fs';

// Shared adapter contract. Every storage backend implements the same five verbs so
// callers never branch on which backend is in use:
//   read(relative)            -> exact current text
//   create(relative, content) -> create a new note; must refuse duplicates
//   append(relative, content) -> append a block; must be exact or roll back
//   replace(relative, expected, next) -> atomic replacement guarded by an expected value
//   verify(relative)          -> read back and confirm the backend sees the write
//
// Implementations must treat the on-disk bytes as authoritative and must never
// silently accept a partial or mismatched write.

export const REQUIRED_METHODS = ['read', 'create', 'append', 'replace', 'verify'];

export function assertAdapter(adapter) {
  const missing = REQUIRED_METHODS.filter((name) => typeof adapter?.[name] !== 'function');
  if (missing.length) throw new Error(`Storage adapter missing methods: ${missing.join(', ')}`);
  return adapter;
}

// Picks an adapter from configuration. `storage` defaults to obsidian-cli when a CLI
// path is configured (preserving current behavior) and filesystem otherwise.
export function selectStorageKind(config = {}) {
  if (typeof config.storage === 'string' && config.storage.trim()) return config.storage.trim();
  return config.obsidianCli ? 'obsidian-cli' : 'filesystem';
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
