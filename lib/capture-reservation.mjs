import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './transport.mjs';

// Caller holds the canonical state writer lock. Both synchronous and asynchronous
// capture reserve the same immutable id/digest before publishing any other artifact.
export function reserveCapture(config, eventId, digest) {
  const state = path.join(config.policyRoot, 'state');
  const file = path.join(state, 'capture-reservations.json');
  const reservations = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const queuedFile = path.join(state, 'capture-queue', eventId + '.json');
  const queued = fs.existsSync(queuedFile) ? JSON.parse(fs.readFileSync(queuedFile, 'utf8')) : null;
  const plansFile = path.join(state, 'captures.json');
  const plan = fs.existsSync(plansFile) ? JSON.parse(fs.readFileSync(plansFile, 'utf8'))[eventId] : null;
  if ([reservations[eventId], queued?.digest, plan?.digest].some((value) => value && value !== digest)) throw new Error('Capture id reused with different evidence or event');
  if (!reservations[eventId]) { reservations[eventId] = digest; atomicJson(file, reservations); }
}
