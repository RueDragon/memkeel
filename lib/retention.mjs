import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, withLock } from './transport.mjs';

// Retention ledger (soft drop).
//
// A nightly pass may judge an automatic conversation checkpoint worthless: it
// recorded a one-line aside, a passing question, or a reply with nothing durable
// in it. Deleting the event itself is not an option: events are immutable and
// consumptionStatus() treats a consumed event that disappeared as store
// corruption ("Consumed event missing or changed"), which takes the whole memory
// store offline. The judgment is therefore kept beside the journal, in its own
// state file, and applied where events are rendered or recalled:
//   - the daily digest projection,
//   - the experience/context recall that reaches prompts and bootstrap.
// The event stays auditable, a later pass can flip the decision back, and
// consolidation cannot resurrect what it deliberately skips.
//
// Guardrail: only automatic conversation checkpoints are eligible. An event that
// carries a conclusion, action, mistake, preference, habit decision or
// verification is never droppable, however conversational its title looks.

const DECISIONS = ['drop', 'keep'];
/** Keys that make an event substantive and therefore immortal. */
const SUBSTANCE_KEYS = ['facts', 'experiences', 'actions', 'mistakes', 'preferences', 'habit_decisions', 'verification'];

export function retentionFile(config) {
  return path.join(config.policyRoot, 'state', 'retention.json');
}

export function loadRetention(config) {
  const file = retentionFile(config);
  if (!fs.existsSync(file)) return { version: 1, decisions: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Invalid retention state (${file}): ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.decisions !== 'object' || parsed.decisions === null) {
    throw new Error(`Invalid retention state (${file})`);
  }
  return { version: parsed.version ?? 1, decisions: parsed.decisions };
}

/** Event ids whose decision is "drop"; a Set for cheap filtering. */
export function droppedEventIds(config) {
  const { decisions } = loadRetention(config);
  return new Set(Object.entries(decisions).filter(([, row]) => row?.decision === 'drop').map(([id]) => id));
}

/** Why an event may not be dropped, or undefined when it is eligible. */
export function ineligibleReason(event) {
  const substantive = SUBSTANCE_KEYS.filter((key) => (event[key] ?? []).length);
  if (substantive.length) return `carries ${substantive.join(', ')}`;
  if (!(event.contexts ?? []).length) return 'has no conversation context';
  return undefined;
}

/**
 * Apply one retention pass. `events` is the validated event list (passed in by the
 * caller so this module never imports core.mjs and creates an import cycle).
 * Every drop must name a known event, give a reason, and pass the guardrail.
 */
export function applyRetention(config, input, events, { by = 'unknown', now = new Date().toISOString() } = {}) {
  const rows = Array.isArray(input) ? input : input?.decisions;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Retention requires a non-empty decisions array');
  if (rows.length > 500) throw new Error('Retention accepts at most 500 decisions per pass');
  const known = new Map(events.map((event) => [event.event_id, event]));
  const clean = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Each retention decision must be an object');
    const { event_id: eventId, decision, reason } = row;
    if (typeof eventId !== 'string' || !eventId) throw new Error('Retention decision requires event_id');
    if (!DECISIONS.includes(decision)) throw new Error(`Retention decision for ${eventId} must be drop or keep`);
    if (typeof reason !== 'string' || !reason.trim()) throw new Error(`Retention decision for ${eventId} requires a reason`);
    const event = known.get(eventId);
    if (!event) throw new Error(`Unknown event: ${eventId}`);
    if (decision === 'drop') {
      const why = ineligibleReason(event);
      if (why) throw new Error(`Refusing to drop ${eventId}: it ${why}; only automatic conversation checkpoints are eligible`);
    }
    clean.push({ event_id: eventId, decision, reason: reason.trim().slice(0, 400) });
  }
  const file = retentionFile(config);
  return withLock(path.join(config.policyRoot, 'state'), () => {
    const state = loadRetention(config);
    for (const row of clean) state.decisions[row.event_id] = { decision: row.decision, reason: row.reason, at: now, by };
    atomicJson(file, { version: 1, updatedAt: now, decisions: state.decisions });
    const dropped = Object.values(state.decisions).filter((row) => row.decision === 'drop').length;
    return { applied: clean.length, dropped, kept: Object.values(state.decisions).filter((row) => row.decision === 'keep').length, droppedIds: clean.filter((row) => row.decision === 'drop').map((row) => row.event_id) };
  });
}

/** Candidates a nightly pass should judge: automatic checkpoints still undecided. */
export function retentionCandidates(config, events) {
  const { decisions } = loadRetention(config);
  return events
    .filter((event) => decisions[event.event_id] === undefined && ineligibleReason(event) === undefined)
    .map((event) => ({ event_id: event.event_id, at: event.occurred_at, workspace: event.workspace, topic: event.topic, agent: event.agent,
      task: event.contexts?.[0]?.task ?? '', text: event.contexts?.[0]?.text ?? '' }));
}
