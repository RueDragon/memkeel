import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  bootstrap, recall, refreshIndex, loadEvents, loadRoutes, reduceEvents,
  consumptionStatus, selectProbationary, VERSION,
} from './lib/core.mjs';
import { loadConfig as loadConfigFromDisk, resolveHome } from './lib/config.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { readHabits, readManualHabits, preferenceProjection } from './lib/preferences.mjs';
import { learningProjection, retention } from './lib/experience.mjs';
import { inside } from './lib/transport.mjs';
import { accessLogSummary, settingsSnapshot } from './lib/dashboard-data.mjs';
import { AccessLog } from './lib/access-log.mjs';
import { loadSessions, sessionFor } from './lib/sessions.mjs';
import { loadTranscript } from './lib/transcripts.mjs';
import { planCloseAction, planHabitDecision, planComposeEvent, executePlan, stateFingerprint, safeStateFingerprint, makeToken, planReviseFact, planReviseLearning, planReviseAction, planRevokeHabit, planUpdateConfig } from './lib/dashboard-actions.mjs';

// Read-only HTTP surface over the same core the CLI and MCP use. The dashboard
// never reads notes itself and never writes Markdown: it renders projections that
// already exist and, for any mutation, calls the same capture/record path. That
// keeps the immutable-event guarantees intact no matter what the UI does.
//
// The one file it does edit is the config: every setting lives in a single JSON file the
// program reads, and the settings page is an editor for three groups of it. That write
// goes through the same preview -> signed token -> execute handshake and never touches
// Markdown. Host binding (`memkeel setup`) stays CLI-only because it rewrites other
// applications' files.

// The console honours the same home precedence as every other command: an explicit --home,
// then MEMKEEL_HOME, then the per-user default. It used to ignore --home entirely, so
// `memkeel dashboard --home X` served a different store than the command that started it.
const homeArg = process.argv.indexOf('--home');
const { home: root } = resolveHome({ home: homeArg >= 0 ? process.argv[homeArg + 1] : '' });
const here = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.join(here, 'dashboard', 'static');

function loadConfig() {
  return loadConfigFromDisk(root).config;
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, message, status = 500, issues) {
  // A refusal may carry the structured issues as well as the sentence the server assembled from them:
  // the sentence is what a log or a non-UI caller sees, and the issues are what the settings page
  // renders in the reader's own language.
  sendJson(res, Array.isArray(issues) && issues.length ? { error: message, issues } : { error: message }, status);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (name.includes('..')) { sendError(res, 'Invalid path', 400); return; }
  const file = path.join(staticDir, name);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { sendError(res, 'Not found', 404); return; }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length });
  res.end(body);
}

// Read models. Each returns a plain JSON shape so the UI never has to know about
// projections, event immutability or storage adapters.
function allHabitRules(manualAndProjected, preferences) {
  const merged = new Map();
  for (const rule of manualAndProjected) merged.set(rule.id, rule);
  for (const rule of preferences.rules) if (!merged.has(rule.id)) merged.set(rule.id, rule);
  return [...merged.values()];
}
// readModels is expensive: it refreshes the note index, parses the whole event
// journal and recomputes every projection. A detail lookup needs one record, so the
// built model is cached and reused until a cheap stat-based fingerprint changes.
// This turns a per-click cost of ~2.5s into ~2ms.
let modelCache = null;

function statTree(root) {
  let newest = 0; let size = 0; let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = dir + "/" + entry.name;
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { const s = fs.statSync(full); newest = Math.max(newest, s.mtimeMs); size += s.size; count += 1; } catch { /* ignore */ }
    }
  }
  return count + ":" + newest + ":" + size;
}

function cacheFingerprint(config) {
  const parts = [];
  try { parts.push(statTree(inside(config.vaultRoot, config.eventsRoot))); } catch { parts.push("no-events"); }
  for (const rel of [config.habitsNote, config.actionsNote, config.mistakesNote, config.preferenceCandidatesNote]) {
    try { const s = fs.statSync(inside(config.vaultRoot, rel)); parts.push(rel + ":" + s.mtimeMs + ":" + s.size); }
    catch { parts.push(rel + ":missing"); }
  }
  // The access log lives under the policy root, not the vault, but it feeds the
  // System view. Include it so a recorded read is reflected without a restart.
  try { const s = fs.statSync(path.join(config.policyRoot, 'state', 'access-log.json')); parts.push('access:' + s.mtimeMs + ':' + s.size); }
  catch { parts.push('access:missing'); }
  return parts.join("|");
}

export function invalidateModelCache() { modelCache = null; }

// Full journal from the same cache the model uses, so the session replay does not
// re-parse every event file on each request.
function cachedEvents(config) { return readModelsWithFingerprint(config).events; }

export function readModelsCached(config) {
  return readModelsWithFingerprint(config).model;
}

// The built model already carries the parsed events and the reduced projection, so a
// preview can reuse them instead of re-parsing the whole journal. The token is bound
// to the same stateFingerprint a fresh execute would recompute, so reuse stays safe:
// if the journal moved, execute recomputes a different fingerprint and fails closed.
export function readModelsWithFingerprint(config) {
  const fingerprint = cacheFingerprint(config);
  if (modelCache && modelCache.fingerprint === fingerprint) return { ...modelCache, fingerprint };
  const { model, events, projection } = readModelsDetailed(config);
  modelCache = { fingerprint, model, events, projection, stateHash: stateFingerprint(config, events) };
  return { ...modelCache };
}
export function readModels(config) {
  return readModelsDetailed(config).model;
}

// One full build: refresh the index, parse the journal, reduce it, and shape every
// surface. Returns the intermediate events and projection too, so a caller that
// already paid for the build (the write preview path) can reuse them instead of
// re-parsing the journal.
export function readModelsDetailed(config) {
  const index = refreshIndex(config, { persist: false });
  const events = loadEvents(config);
  const projection = reduceEvents(events);
  const consumption = consumptionStatus(config, events);
  const learning = learningProjection(events);
  const habitText = fs.readFileSync(inside(config.vaultRoot, config.habitsNote), 'utf8');
  const baselineHabits = readManualHabits(habitText);
  const allHabits = readHabits(habitText);
  const preferences = preferenceProjection(events, baselineHabits);
  const routes = loadRoutes(config);

  const now = config.now ?? new Date();
  // A learning row does not carry its writer, but the chat surfaces label the agent
  // bubble after it, so resolve the owning event's agent (codex / dsh / zcode) here.
  const agentOfEvent = new Map(events.map((event) => [event.event_id, event.agent ?? '']));
  const contexts = learning.entries.filter((row) => row.type === 'contexts')
    .map((row) => ({ ...row, agent: agentOfEvent.get(row.event_id) || '', lifecycle: retention(row, now) }));
  const experiences = learning.entries.filter((row) => row.type === 'experiences').map((row) => ({ ...row, lifecycle: retention(row, now) }));
  const facts = projection.facts.map((row) => ({ ...row, conflict: projection.conflicts.some((c) => c.topic === row.topic && c.key === row.key) }));

  return {
    model: {
      status: {
        version: VERSION,
        configured: true,
        workspace: null,
        events: events.length,
        facts: facts.length,
        contexts: contexts.length,
        experiences: experiences.length,
        routes: routes.length,
        pending: consumption.pending,
        pendingTopics: consumption.pendingTopics,
        conflicts: projection.conflicts.length,
        topics: config.topics.length,
      },
    facts,
    contexts,
    experiences,
    // The dashboard shows confirmed habits from both sources: rules written directly
    // in the habits note (baseline) and rules confirmed through events. preferenceProjection
    // only returns the event-confirmed set, so the baseline is merged in here.
    habits: allHabitRules(allHabits, preferences).filter((rule) => rule.status === 'confirmed').map((rule) => ({ ...rule })),
    probationary: allHabitRules(allHabits, preferences).filter((rule) => rule.status === 'probationary').map((rule) => ({ ...rule })),
    candidates: preferences.candidates,
    actions: projection.actions,
    conflicts: projection.conflicts,
    events: events.slice(-200).reverse(),
    routes,
    access: accessLogSummary(config),
    index: index.io,
    topics: config.topics,
    },
    events,
    projection,
  };
}

// Reads a bounded JSON request body. Dashboard writes are small by construction,
// so anything above the cap is rejected instead of buffered.
function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) { resolve({}); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (error) { reject(new Error("Invalid JSON body: " + error.message)); }
    });
    req.on("error", reject);
  });
}

// Confirming a preference needs the user's own words, quoted verbatim from the candidate
// event's evidence note (lib/preferences.mjs re-reads that file and refuses otherwise).
// The console cannot read the vault, so the preview ships back the note's section for the
// event plus quote candidates taken from the same bytes: every candidate returned here is
// present in the note by construction, so picking one always passes the verbatim check.
function habitEvidenceContext(config, events, candidateEvent) {
  const event = (events ?? []).find((row) => row.event_id === candidateEvent);
  const entry = (event?.evidence ?? []).find((item) => fs.existsSync(inside(config.vaultRoot, item.split("#")[0])));
  if (!entry) return null;
  const [notePath, heading = ""] = entry.split("#");
  let note = "";
  try { note = fs.readFileSync(inside(config.vaultRoot, notePath), "utf8"); }
  catch { return { path: notePath, heading, section: "", quotes: [] }; }
  let section = "";
  const marker = heading ? "## " + heading : "";
  const start = marker ? note.indexOf(marker) : -1;
  if (start >= 0) {
    const rest = note.slice(start + marker.length);
    const next = rest.indexOf("\n## ");
    section = (next > 0 ? rest.slice(0, next) : rest).trim();
  } else {
    // Older evidence entries can point at a note without a matching heading; fall back to
    // a bounded window around the event id so the user still sees where it came from.
    const at = note.indexOf(candidateEvent);
    if (at >= 0) section = note.slice(Math.max(0, at - 200), at + 800).trim();
  }
  return { path: notePath, heading, section: section.slice(0, 4000), quotes: verbatimQuoteCandidates(note, section) };
}

// Sentences the user could actually have said, pulled out of the evidence section:
// blockquotes, the span after an 原话/要求 label, and 「」/"" quoted spans. Each candidate is
// checked against the whole note before it is offered, so whatever the user picks is
// guaranteed to satisfy the backend's verbatim requirement.
function verbatimQuoteCandidates(note, section) {
  const found = [];
  const offer = (value) => {
    const text = String(value ?? "").trim();
    if (text.length < 4 || text.length > 240) return;
    if (!note.includes(text) || found.includes(text)) return;
    found.push(text);
  };
  for (const raw of String(section ?? "").split("\n")) {
    const line = raw.trim();
    if (line.startsWith(">")) { offer(line.replace(/^>\s?/, "").trim()); continue; }
    const label = line.match(/(?:原话[一二三四]?|明确要求|要求|确认选|选择)[：:]\s*(.+)$/);
    if (label) {
      const cut = label[1].search(/[。；]/);
      offer(cut > 0 ? label[1].slice(0, cut) : label[1]);
    }
    for (const match of line.matchAll(/[「“"]([^」”"]{4,240})[」”"]/g)) offer(match[1]);
  }
  return found.slice(0, 4);
}

// Write routes share one shape: preview computes a plan plus a token bound to the
// current state fingerprint, and execute applies that exact plan only if the state
// has not moved. A stale review therefore fails closed instead of writing.
async function handleWrite(config, url, req, res) {
  const transport = createTransport(config);
  const body = await readJsonBody(req);
  const route = url.pathname.replace("/api/write/", "");
  // Preview plans are derived from the cached model, which already revalidates a
  // stat fingerprint on every request. The cache also carries the parsed events and
  // the state hash a fresh execute would recompute, so preview reuses them instead
  // of re-parsing the journal on every click. Only execute pays for a fresh full
  // load, because that step must apply against the newest events.
  const PREVIEW_ROUTES = [
    "close-action/preview", "habit-decision/preview", "compose-event/preview",
    "revise-fact/preview", "revise-learning/preview", "revise-action/preview", "revoke-habit/preview",
    "update-config/preview",
  ];
  if (PREVIEW_ROUTES.includes(route)) {
    // The settings editor has to work when the store itself is unreadable — a wrong
    // memoryRoot is one of the reasons to open it — so it derives the fingerprint from
    // the tolerant journal read instead of building the whole model first.
    if (route === "update-config/preview") {
      const fingerprint = safeStateFingerprint(config);
      const plan = planUpdateConfig(config, body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "update-config", plan, fingerprint }) });
      return true;
    }
    const cached = readModelsWithFingerprint(config);
    const fingerprint = cached.stateHash;
    if (route === "close-action/preview") {
      const plan = planCloseAction(config, cached.projection, body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "close-action", plan, fingerprint }) });
      return true;
    }
    if (route === "compose-event/preview") {
      const plan = planComposeEvent(config, body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "compose-event", plan, fingerprint }) });
      return true;
    }
    if (route === "revise-fact/preview") {
      const plan = planReviseFact(config, cached.projection, body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "revise-fact", plan, fingerprint }) });
      return true;
    }
    if (route === "revise-learning/preview") {
      const plan = planReviseLearning(config, learningProjection(cached.events), body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "revise-learning", plan, fingerprint }) });
      return true;
    }
    if (route === "revise-action/preview") {
      const plan = planReviseAction(config, cached.projection, body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "revise-action", plan, fingerprint }) });
      return true;
    }
    if (route === "revoke-habit/preview") {
      const manual = readManualHabits(fs.readFileSync(inside(config.vaultRoot, config.habitsNote), "utf8"));
      const plan = planRevokeHabit(config, preferenceProjection(cached.events, manual), body);
      sendJson(res, { plan, fingerprint, token: makeToken(config, { action: "revoke-habit", plan, fingerprint }) });
      return true;
    }
    const manual = readManualHabits(fs.readFileSync(inside(config.vaultRoot, config.habitsNote), "utf8"));
    const plan = planHabitDecision(config, preferenceProjection(cached.events, manual), body);
    sendJson(res, { plan, evidence: habitEvidenceContext(config, cached.events, body.candidateEvent), fingerprint, token: makeToken(config, { action: "habit-decision", plan: plan.plan, fingerprint }) });
    return true;
  }
  if (route === "execute") {
    const result = executePlan(config, transport, body);
    invalidateModelCache();
    sendJson(res, result);
    return true;
  }
  return false;
}
// Cross-surface search. A new user should be able to type one word and land on the
// right record without knowing which page owns it, so every surface is searched and
// each hit carries the route needed to open it.
export function searchModels(models, config, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return { query: "", hits: [] };
  const match = (...values) => values.some((value) => String(value ?? "").toLowerCase().includes(q));
  const hits = [];
  const push = (type, id, title, snippet, extra = {}) => {
    if (!match(title, snippet, id)) return;
    hits.push({ type, id, title: String(title ?? ""), snippet: String(snippet ?? "").slice(0, 260), ...extra });
  };
  for (const fact of models.facts) push("fact", `${fact.topic}/${fact.key}`, fact.key, fact.text, { topic: fact.topic, workspace: fact.workspace, eventId: fact.event_id });
  for (const ctx of models.contexts) push("context", ctx.id, ctx.task, ctx.text, { topic: ctx.topic, workspace: ctx.workspace, eventId: ctx.event_id, lifecycle: ctx.lifecycle });
  for (const exp of models.experiences) push("experience", exp.id, exp.kind, exp.text, { topic: exp.topic, workspace: exp.workspace, eventId: exp.event_id });
  for (const rule of [...models.habits, ...models.probationary, ...models.candidates]) push("habit", rule.id, rule.text, rule.scope, { status: rule.status });
  for (const action of models.actions) push("action", `${action.topic}/${action.id}`, action.text, action.topic, { topic: action.topic, status: action.status, eventId: action.event_id });
  for (const event of models.events) push("event", event.event_id, event.event_id, (event.facts ?? []).map((f) => f.text).join(" ") || (event.contexts ?? []).map((c) => c.task).join(" "), { workspace: event.workspace, topic: event.topic, occurredAt: event.occurred_at });
  for (const route of models.routes) push("workspace", route.id, route.project ?? route.id, route.workspace, { status: route.status });
  for (const topic of models.topics) push("topic", topic.id, topic.title, (topic.aliases ?? []).join(", "), { workspace: topic.workspace, path: topic.path });
  for (const conflict of models.conflicts) push("conflict", conflictId(conflict), conflict.key, conflict.current?.text ?? conflict.incoming?.text ?? "", { topic: conflict.topic, key: conflict.key });
  return { query: q, hits: hits.slice(0, 80), total: hits.length };
}

// Detail lookup powers in-page navigation. Opening a result must not require a full
// reload, so the client asks for one record by type and id.
export function detailFor(models, type, id) {
  if (!type || !id) return null;
  if (type === "fact") {
    const [topic, key] = [id.slice(0, id.lastIndexOf("/")), id.slice(id.lastIndexOf("/") + 1)];
    return models.facts.find((row) => row.topic === topic && row.key === key) ?? null;
  }
  if (type === "context") return models.contexts.find((row) => row.id === id) ?? null;
  if (type === "experience") return models.experiences.find((row) => row.id === id) ?? null;
  if (type === "habit") return [...models.habits, ...models.probationary, ...models.candidates].find((row) => row.id === id) ?? null;
  if (type === "action") {
    const [topic, actionId] = [id.slice(0, id.lastIndexOf("/")), id.slice(id.lastIndexOf("/") + 1)];
    return models.actions.find((row) => row.topic === topic && row.id === actionId) ?? null;
  }
  if (type === "event") return models.events.find((row) => row.event_id === id) ?? null;
  if (type === "workspace") return models.routes.find((row) => row.id === id) ?? null;
  if (type === "topic") return models.topics.find((row) => row.id === id) ?? null;
  if (type === "conflict") return models.conflicts.find((row) => conflictId(row) === id) ?? null;
  return null;
}

// Stable id for a conflict: topic + key + the incoming event that disagreed.
export function conflictId(row) {
  return `${row.topic}/${row.key}/${row.event_id}`;
}

// The console binds to loopback, but a loopback bind alone does not stop a hostile page
// from reaching it: DNS rebinding makes the browser treat the attacker's domain as
// same-origin with 127.0.0.1, and a cross-origin POST still lands as a side effect even
// when its response cannot be read. Requests are therefore accepted only when the Host
// header names loopback, and an Origin header, when present, must name loopback too.
// Clients that send no Origin at all (curl, the test suite) keep working unchanged.
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export function loopbackViolation(req) {
  const hostname = String(req.headers.host ?? '').replace(/:\d+$/, '');
  if (!LOOPBACK_HOSTS.has(hostname)) return `Host header must name loopback, received "${hostname || '(none)'}"`;
  const origin = req.headers.origin;
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch { return `Origin header is not a valid URL: "${origin}"`; }
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return `Origin must be loopback, received "${parsed.hostname}"`;
  }
  return null;
}
export function createServer(configLoader = loadConfig) {
  return http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { sendError(res, 'Bad request', 400); return; }
    const violation = loopbackViolation(req);
    if (violation) { sendError(res, `Refused: ${violation}`, 403); return; }
    try {
      if (url.pathname === '/health') { sendJson(res, { ok: true, version: VERSION }); return; }
      if (req.method === 'POST' && url.pathname.startsWith('/api/write/')) {
        const handled = await handleWrite(configLoader(), url, req, res);
        if (!handled) sendError(res, 'Unknown write route', 404);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        const config = configLoader();
        // The settings read model must answer even when the store is unreadable: telling
        // the user that a configured path does not resolve is the point of that page, so
        // it is served before the model build that a broken store would fail.
        if (url.pathname === '/api/settings') { sendJson(res, settingsSnapshot(config)); return; }
        const models = readModelsCached(config);
        if (url.pathname === '/api/status') { sendJson(res, models.status); return; }
        if (url.pathname === '/api/overview') { sendJson(res, models); return; }
        if (url.pathname === '/api/facts') { sendJson(res, models.facts); return; }
        if (url.pathname === '/api/contexts') { sendJson(res, models.contexts); return; }
        if (url.pathname === '/api/experiences') { sendJson(res, models.experiences); return; }
        if (url.pathname === '/api/habits') { sendJson(res, { habits: models.habits, probationary: models.probationary, candidates: models.candidates }); return; }
        if (url.pathname === '/api/actions') { sendJson(res, models.actions); return; }
        if (url.pathname === '/api/conflicts') { sendJson(res, models.conflicts); return; }
        if (url.pathname === '/api/events') { sendJson(res, models.events); return; }
        if (url.pathname === '/api/routes') { sendJson(res, models.routes); return; }
        if (url.pathname === '/api/topics') { sendJson(res, models.topics); return; }
        if (url.pathname === '/api/compose-options') {
          const index = refreshIndex(config, { persist: false });
          // Evidence candidates are authored notes only. Managed projections and the
          // event journal itself are excluded so a new event cannot cite generated
          // output as its own source.
          const skip = new Set(['memory-events', 'memory-evidence', 'daily-digest', 'template', 'experience-catalog', 'topic-state', 'preference-candidates']);
          const evidence = Object.values(index.entries)
            .filter((row) => !skip.has(row.meta?.type))
            .map((row) => ({ path: row.path, title: row.title, type: row.meta?.type ?? '', workspace: row.workspace ?? null, date: row.date ?? null }))
            .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
            .slice(0, 400);
          sendJson(res, { topics: config.topics.map((t) => ({ id: t.id, title: t.title, workspace: t.workspace })), evidence });
          return;
        }
        if (url.pathname === '/api/revisions') {
          // Returns the supersede chain for one fact key or learning id so the UI can
          // show how a value changed over time. Read-only: it walks the immutable
          // journal and follows `supersedes` links backwards from the current event.
          const topic = url.searchParams.get('topic') ?? '';
          const key = url.searchParams.get('key') ?? '';
          const id = url.searchParams.get('id') ?? '';
          const type = url.searchParams.get('type') ?? 'facts';
          const events = cachedEvents(config);
          const rows = [];
          for (const event of events) for (const row of event[type] ?? []) {
            if (topic && event.topic !== topic) continue;
            if (type === 'facts' ? row.key !== key : row.id !== id) continue;
            rows.push({
              event_id: event.event_id, agent: event.agent, at: event.occurred_at,
              text: row.text, supersedes: row.supersedes ?? null, status: row.status ?? 'active',
            });
          }
          rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.event_id.localeCompare(b.event_id));
          sendJson(res, { topic, key, id, type, revisions: rows });
          return;
        }
        if (url.pathname === '/api/search') {
          sendJson(res, searchModels(models, config, url.searchParams.get('q') ?? ''));
          return;
        }
        if (url.pathname === '/api/sessions') { sendJson(res, loadSessions(config, cachedEvents(config))); return; }
        if (url.pathname === '/api/transcript') {
          const sessionId = url.searchParams.get('sessionId');
          const host = url.searchParams.get('host') ?? '';
          const key = url.searchParams.get('key');
          // The transcript locator needs the raw session id, which only the session
          // state holds, so resolve the state record first instead of trusting the
          // query alone. The hook-written transcript path is preferred when present.
          const detail = key ? sessionFor(config, cachedEvents(config), key) : null;
          const resolvedId = sessionId || detail?.sessionId || '';
          const resolvedHost = host || detail?.host || '';
          const resolvedPath = detail?.transcriptPath || '';
          sendJson(res, loadTranscript({
            host: resolvedHost, sessionId: resolvedId, transcriptPath: resolvedPath, cwd: detail?.cwd || '',
          }));
          return;
        }
        if (url.pathname === '/api/detail') {
          const type = url.searchParams.get('type');
          const id = url.searchParams.get('id');
          let detail = detailFor(models, type, id);
          // The cached model only keeps the most recent 200 events for the event feed.
          // A conflict, action or fact can reference an older event, so fall back to a
          // full journal lookup instead of returning 404 for a record that exists.
          if (!detail && type === 'session' && id) {
            detail = sessionFor(config, cachedEvents(config), id);
          }
          if (!detail && type === 'event' && id) {
            detail = loadEvents(config).find((row) => row.event_id === id) ?? null;
          }
          if (!detail) { sendError(res, 'Not found', 404); return; }
          // Reading a record is the one write the dashboard performs outside the review
          // handshake, and it only appends to the derived, rebuildable access log so the
          // learning pass can weight what is actually used. It never touches memory.
          if (['fact', 'context', 'experience'].includes(type)) {
            try {
              new AccessLog(config).record({ kind: type, workspace: detail.workspace, topic: detail.topic, id, query: '' });
            } catch { /* access logging must never break a read */ }
          }
          sendJson(res, detail);
          return;
        }
        sendError(res, 'Unknown API route', 404);
        return;
      }
      serveStatic(res, url.pathname);
    } catch (error) {
      sendError(res, error.message, 500, error.issues);
    }
  });
}

export function startServer({ port = 3247, host = '127.0.0.1' } = {}) {
  // Warm the model cache before serving. The first build parses every event and
  // rebuilds the index, so doing it once at startup keeps the first user click fast
  // instead of paying that cost inside a request.
  try { readModelsCached(loadConfig()); } catch { /* fall back to lazy build */ }
  const server = createServer();
  return new Promise((resolve) => server.listen(port, host, () => resolve({ server, port, host, url: `http://${host}:${port}` })));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const portArg = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 3247;
  startServer({ port: portArg }).then(({ url }) => console.log(`Agent Memory dashboard: ${url}`));
}

