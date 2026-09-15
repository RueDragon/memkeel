import fs from 'node:fs';
import { inside } from './transport.mjs';

export function habitBlocks(text) {
  return [...text.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n```/g)].map((match) => JSON.parse(match[1])).filter((block) => Array.isArray(block.rules));
}
// Manual habits live before the AUTO-MANAGED marker; everything after it is a
// generated projection of confirmed decisions. Collision detection must compare a
// candidate against the *manual* baseline only, otherwise a projection re-confirms
// its own rule and looks like a hand-written collision.
export function readManualHabits(text) {
  const marker = String(text).indexOf('<!-- AUTO-MANAGED:START -->');
  const manual = marker >= 0 ? String(text).slice(0, marker) : String(text);
  return readHabits(manual);
}
export function readHabits(text) {
  const rules = new Map();
  for (const block of habitBlocks(text)) for (const rule of block.rules) rules.set(rule.id, rule);
  return [...rules.values()];
}
export function validatePreference(rule, config) {
  if (!/^[a-z0-9-]+$/.test(rule.id ?? '') || rule.status !== 'candidate' || typeof rule.text !== 'string' || !rule.text.trim()) throw new Error('Preference needs id, candidate status and text');
  if (!['global', 'task', ...config.topics.map((topic) => topic.workspace)].includes(rule.scope)) throw new Error('Preference needs an explicit known scope');
  if (rule.triggers && (!Array.isArray(rule.triggers) || rule.triggers.some((word) => typeof word !== 'string' || !word.trim()))) throw new Error('Invalid preference triggers');
  if (rule.scope === 'task' && !rule.triggers?.length) throw new Error('Task preferences require triggers');
  if (rule.expires && (!/^\d{4}-\d\d-\d\d$/.test(rule.expires) || Number.isNaN(Date.parse(rule.expires)))) throw new Error('Invalid preference expiry');
}
export function preferenceProjection(events, baseline = []) {
  const candidates = new Map();
  const decisions = new Map();
  const active = new Map();
  for (const event of events) {
    for (const rule of event.preferences ?? []) candidates.set(`${event.event_id}/${rule.id}`, { ...rule, source_event: event.event_id, topic: event.topic });
    for (const decision of event.habit_decisions ?? []) {
      const key = `${decision.candidate_event}/${decision.preference_id}`;
      const candidate = candidates.get(key);
      if (!candidate || candidate.topic !== event.topic) throw new Error('Habit decision refers to an unknown or cross-topic candidate');
      const prior = decisions.get(key);
      if (prior && decision.supersedes !== prior.event_id) throw new Error('Habit decision must explicitly supersede its previous decision');
      if (baseline.some((rule) => rule.id === candidate.id)) throw new Error('Candidate collides with a baseline habit; do not silently overwrite manual rules');
      const other = active.get(candidate.id);
      if (other && other.candidateKey !== key) throw new Error('Confirmed habit id already belongs to another candidate');
      decisions.set(key, { ...decision, event_id: event.event_id });
      // Three levels with a hard boundary: an automatic pass may reach
      // probationary (surfaced and rankable, but not binding), while confirmed
      // still requires an explicit decision carrying the user's own quote.
      if (decision.status === 'confirmed' || decision.status === 'probationary') {
        active.set(candidate.id, { candidateKey: key, rule: { ...candidate, status: decision.status, evidence: decision.evidence,
          ...(decision.status === 'confirmed' ? { confirmation_event: event.event_id } : { probation_event: event.event_id }) } });
      } else active.delete(candidate.id);
    }
  }
  return { rules: [...active.values()].map((value) => value.rule), candidates: [...candidates.entries()].map(([key, candidate]) => ({ ...candidate, status: decisions.get(key)?.status ?? 'candidate', decision_event: decisions.get(key)?.event_id })), decisions };
}
// Automatic promotion may only ever reach probationary. A confirmed rule requires
// an explicit user quote that actually exists in the evidence, so no unattended
// pass can turn an inferred preference into a binding instruction.
export const HABIT_LEVELS = Object.freeze(['candidate', 'probationary', 'confirmed', 'rejected']);

export function validateDecision(decision, event, config) {
  if (!decision.candidate_event || !decision.preference_id || !['confirmed', 'rejected', 'probationary'].includes(decision.status)) throw new Error('Invalid habit decision');
  if (decision.status !== 'confirmed') {
    if (typeof decision.evidence !== 'string' || !event.evidence.includes(decision.evidence)) throw new Error('Habit decision requires linked evidence');
    if (typeof decision.user_quote === 'string' && decision.user_quote.trim() && !fs.readFileSync(inside(config.vaultRoot, decision.evidence.split('#')[0]), 'utf8').includes(decision.user_quote)) {
      throw new Error('User confirmation quote is absent from evidence');
    }
    return;
  }
  if (typeof decision.user_quote !== 'string' || decision.user_quote.trim().length < 4 || typeof decision.evidence !== 'string' || !event.evidence.includes(decision.evidence)) throw new Error('Habit decision requires a quoted explicit user request and linked evidence');
  const source = fs.readFileSync(inside(config.vaultRoot, decision.evidence.split('#')[0]), 'utf8');
  if (!source.includes(decision.user_quote)) throw new Error('User confirmation quote is absent from evidence');
}
