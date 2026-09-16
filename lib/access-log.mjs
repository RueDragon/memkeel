import fs from 'node:fs';
import path from 'node:path';
import { resolveCollection } from './privacy.mjs';
import { atomicJson } from './transport.mjs';

// Access log: the one thing a read is allowed to write. It records which facts and
// learnings were surfaced and when, so weight can be settled later by a repeated
// pass rather than by scattering promotion logic across the read path. Reads never
// mutate durable memory; only this derived, rebuildable log changes.
//
// Bounded by design: entries are appended and the file is compacted to the most
// recent N entries on write, so an active vault cannot grow it without limit.

const MAX_ENTRIES = 5000;

export class AccessLog {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.policyRoot, 'state', 'access-log.json');
  }

  // An entry carries the query that produced it, so this log is conversation text and is gated like
  // every other layer that stores it. The log is rebuildable, but "rebuildable" is not a licence to
  // keep writing text a user asked not to collect.
  collectingFor(workspace) {
    return resolveCollection(this.config, { workspace }).collecting;
  }

  load() {
    if (!fs.existsSync(this.file)) return { version: 1, entries: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(parsed.entries)) return { version: 1, entries: [] };
      return parsed;
    } catch { return { version: 1, entries: [] }; }
  }

  // Records one read. `kind` distinguishes a fact hit from a learning hit so the
  // two can be settled by different rules without sharing a counter.
  record({ at = new Date().toISOString(), kind, workspace, topic, id, query = '' }) {
    const state = this.load();
    if (!this.collectingFor(workspace)) return state.entries.length;
    state.entries.push({ at, kind, workspace: workspace ?? null, topic: topic ?? null, id: String(id), query: String(query).slice(0, 200) });
    if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
    atomicJson(this.file, state);
    return state.entries.length;
  }

  recordMany(rows) {
    const state = this.load();
    const kept = rows.filter((row) => this.collectingFor(row.workspace));
    for (const row of kept) state.entries.push({ at: row.at ?? new Date().toISOString(), kind: row.kind, workspace: row.workspace ?? null, topic: row.topic ?? null, id: String(row.id), query: String(row.query ?? '').slice(0, 200) });
    if (!kept.length) return state.entries.length;
    if (state.entries.length > MAX_ENTRIES) state.entries = state.entries.slice(-MAX_ENTRIES);
    atomicJson(this.file, state);
    return state.entries.length;
  }

  // Counts reads since a given instant so one read is settled once, however many
  // consolidation passes follow it.
  countsSince(since) {
    const state = this.load();
    const counts = new Map();
    for (const entry of state.entries) {
      if (since && entry.at <= since) continue;
      const key = `${entry.kind}\u0000${entry.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  lastAccess() {
    const state = this.load();
    const last = new Map();
    for (const entry of state.entries) {
      const key = `${entry.kind}\u0000${entry.id}`;
      const prior = last.get(key);
      if (!prior || entry.at > prior) last.set(key, entry.at);
    }
    return last;
  }
}
