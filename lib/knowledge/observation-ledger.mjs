import fs from 'node:fs';
import path from 'node:path';
import { sha, atomicJson } from '../transport.mjs';
import { validateStoredObservation } from './observations.mjs';

const payloadHash = (record) => sha(JSON.stringify(record.payload));

export function projectObservations(records) {
  const active = new Map(); const seen = new Map();
  for (const record of records) {
    if (!/^[a-f0-9]{64}$/.test(record.id ?? '') || payloadHash(record) !== record.id) {
      throw new Error('Observation journal integrity failure');
    }
    if (seen.has(record.id)) continue;
    seen.set(record.id, true);
    const p = record.payload;
    if (!p.workspace || !p.topic?.startsWith(`${p.workspace}/`) || !p.key
      || !['propose', 'revise', 'retire'].includes(p.operation)) throw new Error('Invalid observation journal entry');
    const identity = JSON.stringify([p.workspace, p.topic, p.key]);
    const old = active.get(identity);
    if (p.operation === 'propose' && old) throw new Error('Observation already exists');
    if (p.operation !== 'propose' && (!old || p.supersedes !== old.version)) {
      throw new Error('Observation revision does not supersede current version');
    }
    if (p.operation === 'retire') {
      if (!p.reason?.trim()) throw new Error('Retirement reason required');
      active.set(identity, { ...old, version: record.id, status: 'retired', reason: p.reason });
    } else {
      const o = p.observation;
      if (!o || o.workspace !== p.workspace || o.topic !== p.topic || o.status !== 'candidate'
        || o.authority !== 'inference-not-instruction') throw new Error('Invalid candidate authority');
      active.set(identity, { ...o, key: p.key, version: record.id });
      validateStoredObservation(o);
    }
  }
  return [...active.values()];
}

export function loadObservationJournal(directory) {
  if (!fs.existsSync(directory)) return [];
  const names = fs.readdirSync(directory).filter((name) => /^\d{8}-[a-f0-9]{64}\.json$/.test(name)).sort();
  const records = names.map((name, index) => {
    const record = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (name !== `${String(index).padStart(8, '0')}-${record.id}.json`) throw new Error('Journal sequence or filename integrity failure');
    return record;
  });
  projectObservations(records);
  return records;
}

// Callers hold the canonical writer lock. Entries are atomically published;
// existing versions are never edited.
export function appendObservation(directory, payload) {
  const records = loadObservationJournal(directory);
  const record = { id: sha(JSON.stringify(payload)), payload };
  if (records.some((row) => row.id === record.id)) return { record, duplicate: true };
  projectObservations([...records, record]);
  fs.mkdirSync(directory, { recursive: true });
  const name = `${String(records.length).padStart(8, '0')}-${record.id}.json`;
  const file = path.join(directory, name);
  if (fs.existsSync(file)) throw new Error('Journal sequence collision');
  atomicJson(file, record);
  const actual = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  if (actual.id !== record.id || payloadHash(actual) !== record.id) throw new Error('Observation journal readback failure');
  return { record, duplicate: false };
}
