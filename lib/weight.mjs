// Weight settlement: a fact or learning that keeps being surfaced gains weight,
// and one that stops being surfaced loses it over time. This is the "confidence
// rises with repeated use" layer, but it is deliberately narrow: weight only
// affects retrieval ranking. It never changes what a fact says, never confirms a
// habit, and never grants permission. A wrong or stale claim can rank lower, but
// it cannot be silently promoted into a rule.

export const DEFAULT_WEIGHT = Object.freeze({
  floor: 0.05,
  ceiling: 5.0,
  boostStep: 0.5,
  decayStep: 0.1,
  decayAfterDays: 30,
  maxBoostsPerPass: 2,
});

const DAY_MS = 86400000;

export function weightConfig(config = {}) {
  const configured = config.weight && typeof config.weight === 'object' ? config.weight : {};
  return { ...DEFAULT_WEIGHT, ...configured };
}

function clamp(value, floor, ceiling) {
  return Math.min(ceiling, Math.max(floor, value));
}

// Pure settlement for one item. `readsSinceLastPass` is the count of new reads
// since the previous settlement, so a single read is only ever counted once.
export function settleWeight(current, { readsSinceLastPass = 0, idleDays = 0 } = {}, config = {}) {
  const rules = weightConfig(config);
  let next = Number(current ?? 1);
  if (!Number.isFinite(next)) next = 1;
  const boosts = Math.min(Math.max(0, readsSinceLastPass), rules.maxBoostsPerPass);
  next += rules.boostStep * boosts;
  if (idleDays >= rules.decayAfterDays) next -= rules.decayStep;
  return Number(clamp(next, rules.floor, rules.ceiling).toFixed(4));
}

// Idle time is measured from the last access, or from the entry's own creation
// time when it has never been read. Returning Infinity for "never read" would
// decay a brand-new entry on its very first settlement pass, which is wrong: an
// entry only becomes stale after the decay window has passed since it appeared.
export function idleDaysFrom(lastAccessAt, now = new Date(), createdAt = null) {
  const reference = lastAccessAt ?? createdAt;
  if (!reference) return 0;
  const last = Date.parse(reference);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, (new Date(now).getTime() - last) / DAY_MS);
}

// Settles a whole projection in one pass. Returns only the entries whose weight
// actually changed, so callers can write a minimal, auditable delta.
export function settleProjection(entries, { readsSinceLastPass = new Map(), lastAccess = new Map(), now = new Date() } = {}, config = {}) {
  const changed = [];
  for (const entry of entries) {
    const key = `${entry.type}\u0000${entry.id}`;
    const reads = readsSinceLastPass.get(key) ?? 0;
    const idleDays = idleDaysFrom(lastAccess.get(key), now, entry.at ?? entry.created ?? null);
    const before = Number(entry.weight ?? 1);
    const after = settleWeight(before, { readsSinceLastPass: reads, idleDays }, config);
    if (after !== before) changed.push({ type: entry.type, id: entry.id, topic: entry.topic, before, after, reads, idleDays: Number.isFinite(idleDays) ? Math.round(idleDays) : null });
  }
  return changed;
}

// Weight multiplies relevance in ranking. Applied at read time so a settlement
// pass never has to rewrite projected notes to take effect.
export function weightFactor(weight, config = {}) {
  const rules = weightConfig(config);
  const value = Number(weight ?? 1);
  if (!Number.isFinite(value) || value <= 0) return rules.floor;
  return clamp(value, rules.floor, rules.ceiling);
}
