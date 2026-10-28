// Pure visibility policy: no store reads/writes. History is audit, not current truth.
export const HIDDEN_STATUSES = new Set([
  'drop', 'dropped', 'superseded', 'invalidated', 'closed', 'cancelled', 'canceled',
  'rejected', 'dormant', 'expired', 'deleted', 'hidden', 'withdrawn', 'archived',
  'soft-hidden', 'soft_hidden', 'invalid',
]);
export const CURRENT_STATUSES = new Set(['active', 'candidate', 'hot', 'warm', 'retained', 'open']);
// This is display precedence among blockers, not permission to override a blocker.
const PRECEDENCE = ['invalid', 'deleted', 'drop', 'dropped', 'hidden', 'soft-hidden',
  'soft_hidden', 'invalidated', 'superseded', 'withdrawn', 'rejected', 'archived',
  'cancelled', 'canceled', 'closed', 'expired', 'dormant'];

function statusValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function dateExpired(value, now) {
  if (value === undefined || value === null || value === '') return false;
  const text = String(value).trim();
  if (!text || !Number.isFinite(Date.parse(text))) return false;
  // experience.retention treats YYYY-MM-DD as inclusive through that UTC day.
  if (/^\d{4}-\d\d-\d\d$/.test(text)) return new Date(now).toISOString().slice(0, 10) > text;
  return Date.parse(text) <= new Date(now).getTime();
}

/** All status fields are intersected: a permissive field cannot revive a hidden row. */
export function visibilityOf(item, { history = false, includeCandidates = true, now = new Date() } = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    return { visible: false, historical: false, status: 'invalid', reason: 'invalid-item', statuses: ['invalid'] };
  }
  const statuses = [...new Set([item.visibilityStatus, item.visibility, item.status, item.lifecycle]
    .map(statusValue).filter(Boolean))];
  if (item.visible === false || item.visibility === false || item.hidden === true) statuses.push('hidden');
  // Check every supplied expiry, not first-non-null: a future alias cannot mask an expired one.
  const expired = [item.expires, item.expiresAt, item.dateExpires, item.date_expires, item.expiry].some((value) => dateExpired(value, now));
  if (expired) statuses.push('expired');
  const blockingStatus = PRECEDENCE.find((status) => statuses.includes(status));
  const candidateHidden = !includeCandidates && statuses.includes('candidate');
  const status = blockingStatus ?? (candidateHidden ? 'candidate' : statuses[0] ?? 'active');
  const hidden = Boolean(blockingStatus || candidateHidden);
  const reason = hidden
    ? item.visibilityReason ?? item.reason ?? (candidateHidden && !blockingStatus ? 'candidate-excluded' : `status=${status}`)
    : item.visibilityReason ?? item.reason ?? null;
  return { visible: !hidden || Boolean(history), historical: hidden && Boolean(history), status, reason, statuses: [...new Set(statuses.length ? statuses : ['active'])] };
}

export function isVisible(item, options = {}) {
  return visibilityOf(item, options).visible;
}

/** Filter only; use projectVisibility for history output carrying effective status. */
export function filterVisible(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  return items.filter((item) => isVisible(item, options));
}

export function projectVisibility(items, options = {}) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  return items.map((item) => ({ item, ...visibilityOf(item, options) }));
}

export function partitionVisibility(items, options = {}) {
  const rows = projectVisibility(items, options);
  return {
    visible: rows.filter((row) => row.visible && !row.historical).map((row) => row.item),
    historical: rows.filter((row) => row.visible && row.historical).map((row) => row.item),
    hidden: rows.filter((row) => !row.visible).map((row) => row.item),
  };
}

export function visibilityReason(item, options = {}) {
  return visibilityOf(item, options).reason;
}
