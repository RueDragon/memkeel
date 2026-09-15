import fs from 'node:fs';
import path from 'node:path';

// Conversation replay. The hook writes one bounded state file per host session at
// <policyRoot>/state/hook-sessions/<key>/session.json. That file is the live,
// per-turn record: the current prompt, the last assistant reply, tool counts and
// the workspace the session was routed to. The durable journal separately keeps an
// immutable context event per checkpoint, so the two are joined by the session key
// rather than copied: the state file gives the freshest turn, the journal gives the
// auditable trail. Nothing here writes.

// The hook hashes `${host}\0${sessionId}` into a 24-char key. The journal stores the
// same key inside the context id (`session-<key>`), which is what makes the join
// exact instead of a fuzzy match on cwd.
function sessionKeyFromContextId(id) {
  return typeof id === 'string' && id.startsWith('session-') ? id.slice('session-'.length) : null;
}

function asString(value, max = 0) {
  const text = typeof value === 'string' ? value : '';
  return max > 0 && text.length > max ? text.slice(0, max) : text;
}

function asCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// A session's status is derived, never stored: the hook keeps `checkpoint.status`
// for the newest turn only, so it is reported as-is and the older `lastStop` flag
// tells us whether a turn is still open.
function sessionStatus(state) {
  const checkpoint = state?.checkpoint;
  if (checkpoint?.status === 'queued') return 'captured';
  if (checkpoint?.status === 'skipped') return 'skipped';
  if (state?.lastStop) return 'idle';
  return 'active';
}

// Reads one state file defensively: a half-written or legacy file must degrade to
// "this session is unreadable", never take down the whole list.
function readState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function shortModel(model) {
  const text = asString(model).trim();
  if (!text) return '';
  // Provider ids are sometimes prefixed with an opaque account/uuid segment; the
  // readable model name is the last path segment.
  const tail = text.split('/').pop();
  return tail || text;
}

// Groups immutable context events by their owning session. Each context event is a
// turn checkpoint, so the list is already chronological; the newest one supplies the
// replay headline.
function turnsBySession(events) {
  const bySession = new Map();
  for (const event of events ?? []) {
    for (const context of event.contexts ?? []) {
      const key = sessionKeyFromContextId(context.id);
      if (!key) continue;
      const list = bySession.get(key) ?? [];
      list.push({
        event_id: event.event_id,
        agent: event.agent ?? '',
        workspace: event.workspace ?? '',
        topic: event.topic ?? '',
        occurred_at: event.occurred_at ?? event.recorded_at ?? '',
        recorded_at: event.recorded_at ?? '',
        task: asString(context.task, 240),
        text: asString(context.text, 4000),
        certainty: context.certainty ?? '',
        lifecycle: context.lifecycle ?? '',
        supersedes: context.supersedes ?? null,
      });
      bySession.set(key, list);
    }
  }
  for (const list of bySession.values()) {
    list.sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at)));
  }
  return bySession;
}

// Builds the list the replay tab renders. Bounded on purpose: the sidebar shows the
// newest sessions and the API caps the pages, so a long-lived policy root cannot
// make this response grow without limit.
export function loadSessions(config, events, { limit = 400 } = {}) {
  const root = path.join(config.policyRoot, 'state', 'hook-sessions');
  if (!fs.existsSync(root)) return { hosts: [], sessions: [] };
  const turns = turnsBySession(events);
  const sessions = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const key = entry.name;
    const state = readState(path.join(root, key, 'session.json'));
    if (!state) continue;
    const host = asString(state.host).trim() || 'unknown';
    const turnList = turns.get(key) ?? [];
    const lastTurn = turnList.at(-1) ?? null;
    const counts = state.counts && typeof state.counts === 'object' ? state.counts : {};
    sessions.push({
      key,
      id: `session-${key}`,
      host,
      sessionId: asString(state.sessionId),
      transcriptPath: asString(state.transcriptPath),
      cwd: asString(state.cwd),
      workspace: asString(state.workspace) || lastTurn?.workspace || '',
      model: shortModel(state.model),
      turn: asCount(state.turn),
      tools: asCount(state.tools),
      reads: asCount(counts.UserPromptSubmit),
      toolCalls: asCount(counts.PreToolUse),
      startedAt: turnList[0]?.occurred_at ?? '',
      updatedAt: asString(state.updatedAt) || lastTurn?.occurred_at || '',
      status: sessionStatus(state),
      readOnly: state.readOnly === true,
      prompt: asString(state.prompt, 900),
      lastAssistant: asString(state.lastAssistant, 4000),
      summary: turnList[0]?.task || lastTurn?.task || asString(state.prompt, 240),
      summaryAt: turnList[0]?.occurred_at ?? lastTurn?.occurred_at ?? '',
      firstTask: turnList[0]?.task ?? '',
      firstTaskAt: turnList[0]?.occurred_at ?? '',
      lastTask: lastTurn?.task ?? '',
      checkpointCount: turnList.length,
      failedTools: (state.observations ?? []).filter((row) => row?.failed).length,
      factMatches: asCount(state.factRecall?.matched?.length),
      routeError: asString(state.routeError, 240),
    });
  }
  sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  // The host rail is derived from the sessions themselves, so an agent that stops
  // appearing simply disappears instead of leaving a permanent empty tab.
  const hosts = [];
  for (const row of sessions) {
    let host = hosts.find((h) => h.id === row.host);
    if (!host) {
      host = { id: row.host, sessions: 0, turns: 0, workspaces: 0, latestAt: '', _ws: new Set() };
      hosts.push(host);
    }
    host.sessions += 1;
    host.turns += row.turn;
    if (row.workspace) host._ws.add(row.workspace);
    if (!host.latestAt || String(row.updatedAt) > host.latestAt) host.latestAt = row.updatedAt;
  }
  for (const host of hosts) {
    host.workspaces = host._ws.size;
    delete host._ws;
  }
  hosts.sort((a, b) => String(b.latestAt).localeCompare(String(a.latestAt)));
  return { hosts, sessions: sessions.slice(0, limit) };
}

// One full replay record: the live state plus every immutable checkpoint that
// belongs to the same hook session key, newest first.
export function sessionFor(config, events, key) {
  const id = key.startsWith('session-') ? key : `session-${key}`;
  const bare = id.slice('session-'.length);
  const stateFile = path.join(config.policyRoot, 'state', 'hook-sessions', bare, 'session.json');
  const state = fs.existsSync(stateFile) ? readState(stateFile) : null;
  const turns = turnsBySession(events).get(bare) ?? [];
  if (!state && turns.length === 0) return null;
  const counts = state?.counts && typeof state.counts === 'object' ? state.counts : {};
  const observations = Array.isArray(state?.observations) ? state.observations : [];
  return {
    key: bare,
    id,
    host: asString(state?.host).trim() || turns[0]?.agent || 'unknown',
    sessionId: asString(state?.sessionId),
    transcriptPath: asString(state?.transcriptPath),
    cwd: asString(state?.cwd),
    workspace: asString(state?.workspace) || turns[0]?.workspace || '',
    model: shortModel(state?.model),
    turn: asCount(state?.turn),
    tools: asCount(state?.tools),
    reads: asCount(counts.UserPromptSubmit),
    toolCalls: asCount(counts.PreToolUse),
    startedAt: turns.at(-1)?.occurred_at ?? '',
    updatedAt: asString(state?.updatedAt) || turns[0]?.occurred_at || '',
    status: sessionStatus(state),
    readOnly: state?.readOnly === true,
    prompt: asString(state?.prompt, 4000),
    lastAssistant: asString(state?.lastAssistant, 12000),
    routeError: asString(state?.routeError, 500),
    factRecall: state?.factRecall ?? null,
    observations,
    failedTools: observations.filter((row) => row?.failed).length,
    counts,
    checkpoint: state?.checkpoint ?? null,
    turns,
    firstTask: turns[0]?.task ?? '',
    firstTaskAt: turns[0]?.occurred_at ?? '',
    lastTask: turns.at(-1)?.task ?? '',
  };
}

