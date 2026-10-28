const DAY_MS = 86400000;

export const STATE_PROJECTION_VERSION = 1;
export const MANAGED_START = '<!-- AUTO-MANAGED:START -->';
export const MANAGED_END = '<!-- AUTO-MANAGED:END -->';

function instant(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

function iso(value) {
  const time = instant(value);
  return time === undefined ? undefined : new Date(time).toISOString();
}

function eventOrder(a, b) {
  return (instant(a.occurred_at) ?? -Infinity) - (instant(b.occurred_at) ?? -Infinity)
    || (instant(a.recorded_at) ?? -Infinity) - (instant(b.recorded_at) ?? -Infinity)
    || String(a.event_id ?? '').localeCompare(String(b.event_id ?? ''));
}

function eventTimes(event, byId, fallback = {}) {
  const source = byId.get(event?.event_id) ?? event;
  const occurred_at = iso(source?.occurred_at ?? fallback.occurred_at);
  const recorded_at = iso(source?.recorded_at ?? fallback.recorded_at);
  const source_event_id = source?.event_id ?? fallback.source_event_id ?? fallback.event_id;
  return {
    ...(occurred_at === undefined ? {} : { occurred_at }),
    ...(recorded_at === undefined ? {} : { recorded_at }),
    ...(source_event_id === undefined ? {} : { source_event_id }),
  };
}

function scopedEvents(events, workspace) {
  return (Array.isArray(events) ? events : [])
    .filter((event) => !workspace || event.workspace === workspace)
    .slice()
    .sort(eventOrder);
}

function projectLearning(events, byId) {
  const entries = new Map();
  const conflicts = [];
  for (const event of events) {
    for (const type of ['contexts', 'experiences']) {
      for (const row of Array.isArray(event[type]) ? event[type] : []) {
        const key = `${type}/${event.topic}/${row.id}`;
        const old = entries.get(key);
        if (old && old.event_id !== event.event_id && row.supersedes !== old.event_id) {
          if (old.text !== row.text) conflicts.push({ key, current: old.event_id, incoming: event.event_id });
          continue;
        }
        entries.set(key, { ...row, type, workspace: event.workspace, topic: event.topic,
          event_id: event.event_id, ...eventTimes(event, byId) });
      }
    }
  }
  return { entries: [...entries.values()], conflicts };
}

function projectActions(events, byId) {
  const actions = new Map();
  for (const event of events) for (const action of Array.isArray(event.actions) ? event.actions : []) {
    const key = `${event.topic}/${action.id}`;
    actions.set(key, { ...action, workspace: event.workspace, topic: event.topic, event_id: event.event_id,
      ...eventTimes(event, byId) });
  }
  return [...actions.values()];
}

function projectFacts(events, byId) {
  const facts = new Map();
  const conflicts = [];
  const resolved = new Set();
  for (const event of events) for (const fact of Array.isArray(event.facts) ? event.facts : []) {
    if (fact.supersedes) resolved.add(fact.supersedes);
  }
  for (const event of events) for (const fact of Array.isArray(event.facts) ? event.facts : []) {
    const key = `${event.topic}/${fact.key}`;
    const old = facts.get(key);
    if (old && old.text !== fact.text && fact.supersedes !== old.event_id) {
      if (!resolved.has(old.event_id) && !resolved.has(event.event_id)) conflicts.push({ key, current: old.event_id, incoming: event.event_id });
      continue;
    }
    if (fact.status === 'invalidated') { facts.delete(key); continue; }
    facts.set(key, { ...fact, workspace: event.workspace, topic: event.topic, event_id: event.event_id,
      ...eventTimes(event, byId) });
  }
  return { facts: [...facts.values()], conflicts };
}

function lifecycle(row, nowMs) {
  if (['closed', 'invalidated'].includes(row.status)) return row.status;
  if (row.expires && instant(`${row.expires}T23:59:59.999Z`) < nowMs) return 'expired';
  if (row.type !== 'contexts') return 'retained';
  const age = (nowMs - (instant(row.occurred_at) ?? nowMs)) / DAY_MS;
  if (age < -1) return 'future';
  if (age > (Number.isInteger(row.ttl_days) ? row.ttl_days : 30)) return 'dormant';
  return age > 7 ? 'warm' : 'hot';
}

function taskName(row) {
  return String(row.task ?? row.topic ?? row.id ?? row.text ?? '').trim() || '未命名任务';
}

function latestByTime(rows) {
  return rows.slice().sort((a, b) => (instant(b.occurred_at) ?? -Infinity) - (instant(a.occurred_at) ?? -Infinity)
    || (instant(b.recorded_at) ?? -Infinity) - (instant(a.recorded_at) ?? -Infinity))[0];
}

/**
 * Build the deterministic current-state model used by future bootstrap/MD/UI adapters.
 * `occurred_at` controls activity and recency; `recorded_at` is ingestion/watermark only;
 * `generated_at` is the projection generation instant and never participates in recency.
 */
export function projectState({ events = [], projection = {}, learningEntries, now = new Date(), generatedAt, workspace,
  recentDays = 14, staleTodoDays = 30, health = {} } = {}) {
  if (!Number.isInteger(recentDays) || recentDays < 1) throw new Error('recentDays must be a positive integer');
  if (!Number.isInteger(staleTodoDays) || staleTodoDays < 1) throw new Error('staleTodoDays must be a positive integer');
  const nowMs = instant(now) ?? Date.now();
  const generated_at = iso(generatedAt ?? new Date(nowMs)) ?? new Date(nowMs).toISOString();
  const rows = scopedEvents(events, workspace);
  const byId = new Map(rows.map((event) => [event.event_id, event]));
  const actions = Array.isArray(projection.actions) ? projection.actions.map((row) => ({ ...row,
    workspace: row.workspace ?? byId.get(row.event_id)?.workspace,
    ...eventTimes(byId.get(row.event_id), byId, row) })) : projectActions(rows, byId);
  const factProjection = Array.isArray(projection.facts) ? { facts: projection.facts.map((row) => ({ ...row,
    workspace: row.workspace ?? byId.get(row.event_id)?.workspace,
    ...eventTimes(byId.get(row.event_id), byId, row) })), conflicts: projection.conflicts ?? [] } : projectFacts(rows, byId);
  const learning = Array.isArray(learningEntries) ? { entries: learningEntries.map((row) => ({ ...row, ...eventTimes(byId.get(row.event_id), byId, row) })), conflicts: [] } : projectLearning(rows, byId);
  const cutoffMs = nowMs - (recentDays - 1) * DAY_MS;
  const staleCutoffMs = nowMs - staleTodoDays * DAY_MS;
  const activityEvents = rows.filter((event) => {
    const at = instant(event.occurred_at);
    return at !== undefined && at >= cutoffMs && at <= nowMs;
  });
  const projectMap = new Map();
  for (const event of activityEvents) {
    const old = projectMap.get(event.workspace);
    if (!old || eventOrder(old, event) < 0) projectMap.set(event.workspace, event);
  }
  const recentProjects = [...projectMap.entries()].map(([id, event]) => {
    const projectRows = activityEvents.filter((row) => row.workspace === id);
    return { workspace: id, topic: event.topic, latest_occurred_at: iso(event.occurred_at), latest_recorded_at: iso(event.recorded_at),
      source_event_id: event.event_id, event_count: projectRows.length };
  }).sort((a, b) => (instant(b.latest_occurred_at) ?? -Infinity) - (instant(a.latest_occurred_at) ?? -Infinity) || a.workspace.localeCompare(b.workspace));

  const currentTasks = new Map();
  for (const row of learning.entries.filter((entry) => entry.type === 'contexts')) {
    const state = lifecycle(row, nowMs);
    if (!['hot', 'warm', 'retained'].includes(state)) continue;
    const key = `${row.workspace}/${taskName(row)}`;
    const task = currentTasks.get(key) ?? { task: taskName(row), workspace: row.workspace, updates: [], next_steps: [], blockers: [] };
    task.updates.push({ text: row.text, certainty: row.certainty ?? 'reported', lifecycle: state, ...eventTimes(byId.get(row.event_id), byId) });
    currentTasks.set(key, task);
  }
  const staleTodos = [];
  const recentCompleted = new Map();
  for (const action of actions) {
    const at = instant(action.occurred_at);
    const taskKey = `${action.workspace}/${taskName(action)}`;
    if (action.status === 'open') {
      if (at !== undefined && at < staleCutoffMs) {
        staleTodos.push({ id: action.id, task: taskName(action), workspace: action.workspace, topic: action.topic, text: action.text, status: 'open',
          ...eventTimes(byId.get(action.event_id), byId), stale_since: action.occurred_at });
        continue;
      }
      const target = currentTasks.get(taskKey) ?? { task: taskName(action), workspace: action.workspace, updates: [], next_steps: [], blockers: [] };
      target.next_steps.push({ id: action.id, topic: action.topic, text: action.text, status: 'open', ...eventTimes(byId.get(action.event_id), byId) });
      currentTasks.set(taskKey, target);
    } else if (action.status === 'done' && at !== undefined && at >= cutoffMs && at <= nowMs) {
      const target = recentCompleted.get(taskKey) ?? { task: taskName(action), workspace: action.workspace, completed: [] };
      target.completed.push({ id: action.id, text: action.text, ...eventTimes(byId.get(action.event_id), byId) });
      recentCompleted.set(taskKey, target);
    }
  }
  for (const task of currentTasks.values()) {
    task.updates.sort((a, b) => (instant(b.occurred_at) ?? -Infinity) - (instant(a.occurred_at) ?? -Infinity));
    task.next_steps.sort((a, b) => (instant(b.occurred_at) ?? -Infinity) - (instant(a.occurred_at) ?? -Infinity));
    task.latest_occurred_at = latestByTime([...task.updates, ...task.next_steps])?.occurred_at;
    task.latest_recorded_at = latestByTime([...task.updates, ...task.next_steps])?.recorded_at;
  }
  const stableKnowledge = factProjection.facts.map((fact) => ({ topic: fact.topic, key: fact.key, text: String(fact.text).slice(0, 240), ...eventTimes(byId.get(fact.event_id), byId) }));
  const latestRecorded = rows.reduce((best, event) => (instant(event.recorded_at) ?? -Infinity) > (instant(best?.recorded_at) ?? -Infinity) ? event : best, undefined);
  return {
    version: STATE_PROJECTION_VERSION,
    generated_at,
    window: { recent_days: recentDays, from: new Date(cutoffMs).toISOString(), to: new Date(nowMs).toISOString() },
    recent_projects: recentProjects,
    current_tasks: [...currentTasks.values()],
    recent_completed: [...recentCompleted.values()],
    stale_todos: staleTodos,
    stable_knowledge: stableKnowledge,
    health: { generated_at, latest_processed_recorded_at: iso(health.latest_processed_recorded_at ?? latestRecorded?.recorded_at),
      pending_count: Number(health.pending_count ?? health.pending ?? 0), exception_count: Number(health.exception_count ?? health.exceptions ?? 0) },
    conflicts: [...(factProjection.conflicts ?? []), ...(learning.conflicts ?? [])],
  };
}

export function renderManagedBlock(body) {
  if (typeof body !== 'string') throw new TypeError('managed body must be a string');
  if (body.includes(MANAGED_START) || body.includes(MANAGED_END)) throw new Error('managed body contains reserved markers');
  return `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}`;
}

/** Replace exactly one existing managed block, preserving all manual text around it. */
export function replaceManagedBlock(document, body) {
  if (typeof document !== 'string') throw new TypeError('document must be a string');
  const starts = [...document.matchAll(new RegExp(MANAGED_START, 'g'))];
  const ends = [...document.matchAll(new RegExp(MANAGED_END, 'g'))];
  if (starts.length === 0 && ends.length === 0) return { status: 'missing', changed: false, text: document, reason: 'managed markers not found' };
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index > ends[0].index) return { status: 'conflict', changed: false, text: document, reason: 'managed markers are malformed or duplicated' };
  const rendered = renderManagedBlock(body);
  const start = starts[0].index;
  const end = ends[0].index + MANAGED_END.length;
  const text = document.slice(0, start) + rendered + document.slice(end);
  return { status: 'replaced', changed: text !== document, text };
}

export function createManagedDocument(header, body) {
  if (typeof header !== 'string') throw new TypeError('header must be a string');
  return `${header.replace(/\s+$/, '')}\n\n${renderManagedBlock(body)}\n`;
}
