import { VaultTransport } from '../transport.mjs';
import { FilesystemTransport } from './filesystem.mjs';
import { selectStorageKind, assertAdapter } from './adapter.mjs';

// Single place every caller asks for a storage backend. Callers pass a normalized
// layout config and never construct a backend directly, so adding a backend later
// (for example SQLite or a remote sync target) is one entry in this factory.
export function createTransport(config) {
  const kind = selectStorageKind(config);
  const adapter = kind === 'filesystem'
    ? new FilesystemTransport(config)
    : kind === 'obsidian-cli'
      ? new VaultTransport(config)
      : undefined;
  if (!adapter) throw new Error(`Unknown storage adapter: ${kind}`);
  return assertAdapter(adapter);
}
