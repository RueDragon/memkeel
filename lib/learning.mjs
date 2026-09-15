import { preferenceProjection, HABIT_LEVELS } from './preferences.mjs';

// Automatic habit learning, bounded by construction. A candidate preference that
// keeps being surfaced and keeps being useful may rise to `probationary`, where it
// is visible and rankable but still not a binding instruction. Nothing here can
// reach `confirmed`: that transition requires validateDecision's explicit user
// quote, and this module never fabricates one. Rejection and the confirm frontier
// remain human-controlled.

export const DEFAULT_PROMOTION = Object.freeze({
  // How many qualifying reads of a candidate are needed before probation.
  minReads: 2,
  // A candidate must also be old enough that this is not a single hot session.
  minAgeDays: 1,
  // Cap how many promotions one pass may perform, so a burst cannot mass-promote.
  maxPerPass: 3,
});

export function promotionConfig(config = {}) {
  const configured = config.promotion && typeof config.promotion === 'object' ? config.promotion : {};
  return { ...DEFAULT_PROMOTION, ...configured };
}

const DAY_MS = 86400000;

// Decides which candidates are eligible to become probationary. Pure: it returns a
// plan, it does not write. Eligibility requires both repeated reads and a minimum
// age, so a preference mentioned twice in one session does not become a rule.
export function planPromotions({ events, baseline = [], accessLog, now = new Date(), config = {} }) {
  const rules = promotionConfig(config);
  const projection = preferenceProjection(events, baseline);
  const reads = accessLog?.countsSince?.() ?? new Map();
  const decisions = new Map();
  for (const row of projection.candidates) {
    const key = `facts\u0000${row.id}`;
    const readCount = reads.get(key) ?? reads.get(`preferences\u0000${row.id}`) ?? 0;
    decisions.set(row.id, { candidate: row, readCount });
  }
  const eligible = [];
  for (const { candidate, readCount } of decisions.values()) {
    if (candidate.status !== 'candidate') continue;
    if (readCount < rules.minReads) continue;
    const sourceEvent = events.find((event) => event.event_id === candidate.source_event);
    const ageDays = sourceEvent ? (new Date(now).getTime() - Date.parse(sourceEvent.occurred_at ?? sourceEvent.recorded_at)) / DAY_MS : 0;
    if (!Number.isFinite(ageDays) || ageDays < rules.minAgeDays) continue;
    eligible.push({ id: candidate.id, candidateEvent: candidate.source_event, topic: candidate.topic, readCount, ageDays: Math.round(ageDays) });
  }
  return eligible.sort((a, b) => b.readCount - a.readCount).slice(0, rules.maxPerPass);
}

// Builds the event payload that promotes a candidate to probationary. The event is
// a normal habit_decision, so it goes through the same immutable journal and can be
// superseded later; the automatic path is auditable exactly like a manual one.
export function promotionEvent(promotion, { agent = 'codex', occurredAt = null, evidence }) {
  return {
    event_id: `habit-probation-${promotion.candidateEvent}-${promotion.id}`,
    workspace: promotion.topic.split('/')[0],
    topic: promotion.topic,
    agent,
    ...(occurredAt ? { occurred_at: occurredAt } : {}),
    evidence: [evidence],
    habit_decisions: [{
      candidate_event: promotion.candidateEvent,
      preference_id: promotion.id,
      status: 'probationary',
      evidence,
    }],
  };
}

export function isHabitLevel(value) {
  return HABIT_LEVELS.includes(value);
}
