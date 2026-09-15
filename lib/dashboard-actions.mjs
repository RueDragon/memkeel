import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha, inside, atomicJson } from './transport.mjs';
import { record, loadEvents, consolidate, localDay, validateEvent } from './core.mjs';
import { decideHabit } from './lifecycle.mjs';

// Preview/execute handshake for dashboard writes. A mutation is never applied from
// a single request: the server first computes a plan and returns it with a token
// bound to (a) the exact plan payload and (b) a fingerprint of the state the plan
// was computed against. Execute only proceeds when the token matches and the state
// fingerprint is unchanged, so a plan reviewed against stale data is rejected
// rather than silently applied to different content.
//
// This mirrors the reviewable-operator pattern: the UI shows what will happen,
// the human confirms, and the write lands through the same immutable event path the
// CLI and MCP use. The dashboard never edits Markdown.

const TOKEN_TTL_MS = 10 * 60 * 1000;

function secret(config) {
  // Prefer a persisted per-install secret so tokens survive a restart; fall back to
  // an ephemeral one when the policy root is not writable.
  return config.dashboardTokenSecret ?? 'agent-memory-dashboard-local';
}

export function stateFingerprint(config, events) {
  // Fingerprint the parts of state a mutation depends on: the event set and the
  // consumed checkpoint. Any intervening write changes this value.
  return sha(events.map((event) => `${event.event_id}:${event.recorded_at}`).join('|') + `#${config.policyRoot}`);
}

export function makeToken(config, { action, plan, fingerprint, now = Date.now() }) {
  const body = { action, plan, fingerprint, iat: now, exp: now + TOKEN_TTL_MS };
  const payload = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret(config)).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyToken(config, token, { now = Date.now() } = {}) {
  if (typeof token !== 'string' || !token.includes('.')) throw new Error('Invalid preview token');
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', secret(config)).update(payload).digest('base64url');
  const a = Buffer.from(mac ?? '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Preview token signature mismatch');
  let body;
  try { body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw new Error('Preview token payload is malformed'); }
  if (!Number.isFinite(body.exp) || body.exp < now) throw new Error('Preview token expired; request a new preview');
  return body;
}

// Builds the action plan for closing an action. Pure: it only reads projections.
export function planCloseAction(config, projection, { topic, actionId }) {
  const action = projection.actions.find((row) => row.topic === topic && row.id === actionId);
  if (!action) throw new Error(`Action not found: ${topic}/${actionId}`);
  if (action.status === 'done') throw new Error('Action is already closed');
  const workspace = config.topics.find((t) => t.id === topic)?.workspace;
  if (!workspace) throw new Error(`Unknown topic: ${topic}`);
  // The closing event reuses the evidence already attached to the event that opened
  // the action. A dashboard action therefore never invents a source, and the
  // immutable journal keeps a single evidence chain per action.
  return {
    kind: 'close-action',
    summary: `关闭待办：${action.text}`,
    changes: [{ field: 'status', from: action.status, to: 'done', topic, actionId }],
    applies: { topic, actionId, workspace, text: action.text, sourceEvent: action.event_id },
  };
}

// Builds the plan for a habit decision. The plan records whether a user quote is

// Executes a previously previewed plan. `token` must have been issued for exactly
// this plan and the current state fingerprint. Both checks are mandatory: a plan
// reviewed against different data, or a token reused for another payload, fails
// closed instead of writing.
export function executePlan(config, transport, { action, plan, fingerprint, token, now = Date.now() }) {
  const events = loadEventsForFingerprint(config);
  const current = stateFingerprint(config, events);
  if (current !== fingerprint) throw new Error('State changed since preview; request a new preview');
  const body = verifyToken(config, token, { now });
  if (body.action !== action) throw new Error('Preview token is for a different action');
  if (JSON.stringify(body.plan) !== JSON.stringify(plan)) throw new Error('Plan does not match the previewed payload');
  if (body.fingerprint !== fingerprint) throw new Error('Preview token was issued for different state');
  if (action === 'close-action') return executeCloseAction(config, transport, plan, events);
  if (action === 'habit-decision') return executeHabitDecision(config, transport, plan);
  if (action === 'compose-event') return executeComposeEvent(config, transport, plan);
  // Every revision family reduces to the same append: validate the already-built
  // event, record it, then consolidate. Keeping one executor means a revised fact,
  // context, experience, action or habit goes through exactly the path CLI/MCP use.
  if (['revise-fact', 'revise-learning', 'revise-action', 'revoke-habit'].includes(action)) return executeAppendEvent(config, transport, plan, action);
  if (action === 'update-config') return executeUpdateConfig(config, transport, plan);
  throw new Error(`Unsupported dashboard action: ${action}`);
}
// required so the UI can refuse to offer an unattributed confirmation.
export function planHabitDecision(config, projection, { candidateEvent, preferenceId, decision, userQuote = null }) {
  if (!['confirmed', 'rejected'].includes(decision)) throw new Error('Decision must be confirmed or rejected');
  const candidate = projection.candidates.find((row) => row.source_event === candidateEvent && row.id === preferenceId);
  if (!candidate) throw new Error(`Candidate not found: ${candidateEvent}/${preferenceId}`);
  const workspace = config.topics.find((t) => t.id === candidate.topic)?.workspace;
  if (!workspace) throw new Error(`Unknown topic: ${candidate.topic}`);
  return {
    kind: 'habit-decision',
    summary: `${decision === 'confirmed' ? '确认' : '拒绝'}偏好：${candidate.text}`,
    requiresUserQuote: decision === 'confirmed',
    changes: [{ field: 'status', from: candidate.status ?? 'candidate', to: decision, candidateEvent, preferenceId }],
    plan: { candidateEvent, preferenceId, decision, topic: candidate.topic, workspace, userQuote },
  };
}

function loadEventsForFingerprint(config) {
  // Config editing must stay possible while the store itself is unreadable: a wrong
  // memoryRoot is one of the reasons a user opens the settings page. An unreadable
  // journal fingerprints as "no events", so a plan that was previewed against real
  // events still fails closed once the journal becomes readable again.
  try { return loadEvents(config); }
  catch { return []; }
}

// The fingerprint a preview hands to the client, computed exactly the way the matching
// execute recomputes it. Kept here so both sides can never drift apart.
export function safeStateFingerprint(config) {
  return stateFingerprint(config, loadEventsForFingerprint(config));
}

function executeCloseAction(config, transport, plan, events) {
  // The closing event must carry existing evidence. Reuse the opening event's own
  // evidence so the chain stays traceable and no new source is fabricated.
  const source = events.find((event) => event.event_id === plan.applies?.sourceEvent);
  if (!source) throw new Error('Source event for the action no longer exists');
  const evidence = (source.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('Opening event has no readable evidence to attach to the close');
  const event = {
    event_id: `dashboard-action-close-${plan.applies.actionId}-${Date.now().toString(36)}`,
    workspace: plan.applies.workspace,
    topic: plan.applies.topic,
    agent: 'dashboard',
    occurred_at: new Date().toISOString(),
    evidence: [evidence],
    actions: [{ id: plan.applies.actionId, status: 'done', text: plan.applies.text }],
  };
  const result = record(config, transport, event);
  return { ...result, consolidation: consolidate(config, transport), kind: 'close-action' };
}

function executeHabitDecision(config, transport, plan) {
  const events = loadEvents(config);
  const candidate = events.find((event) => event.event_id === plan.candidateEvent);
  if (!candidate) throw new Error('Candidate event no longer exists');
  const evidence = (candidate.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('Candidate event has no readable evidence');

  if (plan.decision === 'rejected') {
    // Rejection needs no user quote; it revokes the candidate without rewriting history.
    const event = {
      event_id: `dashboard-habit-reject-${plan.preferenceId}-${Date.now().toString(36)}`,
      workspace: plan.workspace,
      topic: plan.topic,
      agent: 'dashboard',
      occurred_at: new Date().toISOString(),
      evidence: [evidence],
      habit_decisions: [{ candidate_event: plan.candidateEvent, preference_id: plan.preferenceId, status: 'rejected', evidence }],
    };
    const result = record(config, transport, event);
    return { ...result, consolidation: consolidate(config, transport), kind: 'habit-decision' };
  }

  // Confirmation requires the user's own words, quoted from the evidence. The
  // dashboard passes that quote through; decideHabit re-reads the evidence file and
  // refuses if the quote is not actually present there.
  if (typeof plan.userQuote !== 'string' || plan.userQuote.trim().length < 4) throw new Error('Confirmed habits require the user quote that authorises them');
  const result = decideHabit(config, transport, {
    event_id: `dashboard-habit-confirm-${plan.preferenceId}-${Date.now().toString(36)}`,
    candidate_event: plan.candidateEvent,
    preference_id: plan.preferenceId,
    status: 'confirmed',
    evidence,
    user_quote: plan.userQuote,
    agent: 'dashboard',
  });
  return { ...result, kind: 'habit-decision' };
}

// Revising an existing fact. A revision is never an in-place edit: it appends a new
// event whose fact carries `supersedes = <previous event id>`, which is exactly the
// contract reduceEvents already uses to retire the old value. `retire` produces a
// replacement that marks the fact inactive so it leaves the current view while the
// original event stays in the journal as evidence.
export function planReviseFact(config, projection, { topic, key, text, expectedEvent, retire = false, supersedeEvent = null }) {
  const route = config.topics.find((t) => t.id === topic);
  if (!route) throw new Error(`Unknown topic: ${topic}`);
  const current = projection.facts.find((row) => row.topic === topic && row.key === key);
  if (!current) throw new Error(`Fact not found: ${topic}/${key}`);
  // Guard against revising a value that already moved under the reviewer. The caller
  // passes the event id it saw; a mismatch means a newer event won and this plan is stale.
  if (expectedEvent && current.event_id !== expectedEvent) throw new Error('Fact changed since it was opened; reopen it to revise the current value');
  const body = retire ? retireText(current.text) : String(text ?? '').trim();
  if (!body) throw new Error('Replacement text is required');
  // Conflict resolution may name the opposing side as the record to supersede (keeping
  // the current claim re-affirms it by explicitly retiring the newer one). Default is
  // the currently retained event.
  const supersedes = supersedeEvent || current.event_id;
  const evidenceSource = supersedeEvent && supersedeEvent !== current.event_id
    ? (projection.conflicts.find((c) => c.topic === topic && c.key === key && c.event_id === supersedeEvent)?.incoming ?? current)
    : current;
  const evidence = (evidenceSource.evidence ?? current.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])))
    ?? (current.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('This fact has no readable evidence to attach a revision to');
  const event = {
    event_id: `dashboard-fact-${retire ? 'retire' : 'revise'}-${Date.now().toString(36)}`,
    workspace: route.workspace,
    topic,
    agent: 'dashboard',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    evidence: [evidence],
    facts: [{ key, text: body, supersedes, ...(retire ? { status: 'invalidated' } : {}) }],
  };
  validateEvent(event, config);
  return {
    kind: 'revise-fact',
    summary: `${retire ? '停用' : '修正'}事实 ${topic}/${key}：${body.slice(0, 60)}`,
    changes: [{ field: retire ? 'status' : 'text', from: current.text, to: body, expectedEvent: current.event_id }],
    event,
  };
}

// A retired fact needs readable text because every fact requires non-empty body. The
// marker makes it obvious in Event detail that this was an explicit retirement and not
// a real conclusion someone recorded.
function retireText(previous) {
  return `[已停用] 该结论于 ${localDay()} 被显式停用；停用前的原文：${String(previous).slice(0, 1200)}`;
}

// Revising a context or experience. Both already support `supersedes` and a status
// field in the schema, so a revision is the same immutable-append shape as a fact.
export function planReviseLearning(config, projection, { type, topic, id, text, expectedEvent, retire = false, keep = {} }) {
  if (!['contexts', 'experiences'].includes(type)) throw new Error(`Unsupported learning type: ${type}`);
  const route = config.topics.find((t) => t.id === topic);
  if (!route) throw new Error(`Unknown topic: ${topic}`);
  const current = projection.entries.find((row) => row.type === type && row.topic === topic && row.id === id);
  if (!current) throw new Error(`Record not found: ${topic}/${id}`);
  if (expectedEvent && current.event_id !== expectedEvent) throw new Error('Record changed since it was opened; reopen it to revise the current value');
  const body = retire ? `[已停用] ${String(current.text).slice(0, 1400)}` : String(text ?? '').trim();
  if (!body) throw new Error('Replacement text is required');
  if (body.length > 1600) throw new Error('Learning text is limited to 1600 characters');
  const evidence = (current.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('This record has no readable evidence to attach a revision to');
  const row = { id, text: body, supersedes: current.event_id, status: retire ? 'invalidated' : 'active' };
  if (type === 'experiences') {
    // Experiences carry required fields that must survive a text-only revision.
    row.kind = keep.kind ?? current.kind;
    row.scope = keep.scope ?? current.scope;
    row.triggers = keep.triggers ?? current.triggers;
    row.verification = keep.verification ?? current.verification;
    if (row.kind === 'negative-search') {
      row.boundary = keep.boundary ?? current.boundary;
      row.expires = keep.expires ?? current.expires;
    }
    if (row.kind === 'path-finding') row.location = keep.location ?? current.location;
  } else {
    row.task = keep.task ?? current.task;
    row.ttl_days = Number(keep.ttl_days ?? current.ttl_days ?? 30);
    row.certainty = keep.certainty ?? current.certainty ?? 'reported';
  }
  const event = {
    event_id: `dashboard-${type === 'contexts' ? 'context' : 'experience'}-${retire ? 'retire' : 'revise'}-${Date.now().toString(36)}`,
    workspace: route.workspace,
    topic,
    agent: 'dashboard',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    evidence: [evidence],
    [type]: [row],
  };
  validateEvent(event, config);
  return {
    kind: 'revise-learning',
    summary: `${retire ? '停用' : '修正'}${type === 'contexts' ? '短期记忆' : '执行经验'} ${id}：${body.slice(0, 60)}`,
    changes: [{ field: retire ? 'status' : 'text', from: current.text, to: body }],
    event,
  };
}

// Revising an action's text. Actions have no supersedes field: the projection keys on
// topic/id and the latest event wins, so a revision simply reuses the id with the new
// text and keeps the current status. Retirement reuses the existing close semantics.
export function planReviseAction(config, projection, { topic, actionId, text, retire = false }) {
  const route = config.topics.find((t) => t.id === topic);
  if (!route) throw new Error(`Unknown topic: ${topic}`);
  const current = projection.actions.find((row) => row.topic === topic && row.id === actionId);
  if (!current) throw new Error(`Action not found: ${topic}/${actionId}`);
  const body = String(text ?? '').trim();
  if (!retire && !body) throw new Error('Action text is required');
  const source = loadEvents(config).find((event) => event.event_id === current.event_id);
  const evidence = (source?.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('This action has no readable evidence to attach a revision to');
  const event = {
    event_id: `dashboard-action-${retire ? 'retire' : 'revise'}-${actionId}-${Date.now().toString(36)}`,
    workspace: route.workspace,
    topic,
    agent: 'dashboard',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    evidence: [evidence],
    actions: [{ id: actionId, status: retire ? 'done' : current.status, text: retire ? current.text : body }],
  };
  validateEvent(event, config);
  return {
    kind: 'revise-action',
    summary: `${retire ? '关闭' : '修正'}待办 ${current.text.slice(0, 60)}`,
    changes: [{ field: retire ? 'status' : 'text', from: retire ? current.status : current.text, to: retire ? 'done' : body }],
    event,
  };
}

// Revoking a confirmed preference. preferenceProjection requires any later decision to
// explicitly supersede the previous one, so revocation appends a `rejected` decision
// carrying `supersedes = <previous decision event>`. The rule disappears from the
// enforced set without editing the confirmation that once existed.
export function planRevokeHabit(config, projection, { preferenceId }) {
  // Only event-backed decisions can be revoked; a hand-written baseline rule lives in
  // the habits note and has no event to supersede, so it must be edited there.
  const active = projection.rules.find((rule) => rule.id === preferenceId);
  if (!active) {
    throw new Error('该偏好不是事件确认的规则（可能写在偏好笔记里），需要在偏好笔记中直接修改，界面无法撤销');
  }
  const candidate = projection.candidates.find((row) => row.id === preferenceId && row.status === active.status)
    ?? projection.candidates.find((row) => row.id === preferenceId);
  if (!candidate) throw new Error(`Preference source not found: ${preferenceId}`);
  const candidateKey = `${candidate.source_event}/${preferenceId}`;
  const previous = projection.decisions?.get(candidateKey);
  if (!previous) throw new Error('该偏好没有可替代的既有决定，无法撤销');
  const source = loadEvents(config).find((event) => event.event_id === previous.event_id);
  const evidence = (source?.evidence ?? []).find((entry) => fs.existsSync(inside(config.vaultRoot, entry.split('#')[0])));
  if (!evidence) throw new Error('Preference decision has no readable evidence to attach a revocation to');
  const event = {
    event_id: `dashboard-habit-revoke-${preferenceId}-${Date.now().toString(36)}`,
    workspace: config.topics.find((t) => t.id === candidate.topic)?.workspace,
    topic: candidate.topic,
    agent: 'dashboard',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    evidence: [evidence],
    habit_decisions: [{
      candidate_event: candidate.source_event ?? candidateKey.split('/')[0],
      preference_id: preferenceId,
      status: 'rejected',
      evidence,
      supersedes: previous.event_id,
    }],
  };
  validateEvent(event, config);
  return {
    kind: 'revoke-habit',
    summary: `撤销偏好：${active.text}`,
    changes: [{ field: 'status', from: active.status ?? 'confirmed', to: 'rejected' }],
    event,
  };
}

// Composing a brand-new memory record from the UI. The dashboard collects a
// structured payload, but the event is still built by this module and validated by
// the same validateEvent the CLI and MCP use. The UI can therefore never write an
// event shape the ordinary write path would reject.
//
// `kind` selects which payload field the text goes into:
//   fact        -> facts[]    (key + text; optional supersedes for a correction)
//   action      -> actions[]  (always opened; id derived from a slug)
//   context     -> contexts[] (task + text, TTL, certainty)
//   experience  -> experiences[] (kind + triggers + verification + scope)
export function planComposeEvent(config, { kind, topic, workspace, text, key, task, evidence, triggers, verification, scope, ttlDays, certainty, supersedes, agent = 'dashboard' }) {
  const route = config.topics.find((t) => t.id === topic);
  if (!route) throw new Error(`Unknown topic: ${topic}`);
  const ws = route.workspace;
  if (workspace && workspace !== ws) throw new Error(`Topic ${topic} belongs to ${ws}, not ${workspace}`);
  if (!['fact', 'action', 'context', 'experience'].includes(kind)) throw new Error(`Unsupported kind: ${kind}`);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Content is required');
  if (!Array.isArray(evidence) || !evidence.length) throw new Error('At least one evidence note is required');
  const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  // CJK content slugifies to an empty string, so fall back to the kind. Event ids
  // must stay ASCII ([\w-]) and this keeps them readable even for Chinese input.
  const token = slug(key || task || text) || kind;
  const id = `dash-${token}-${Date.now().toString(36)}`;
  const event = {
    event_id: `dashboard-compose-${token.slice(0, 30)}-${Date.now().toString(36)}`,
    workspace: ws,
    topic,
    agent: slug(agent) || 'dashboard',
    occurred_at: new Date().toISOString(),
    recorded_at: new Date().toISOString(),
    evidence: [...evidence],
  };
  if (kind === 'fact') {
    const factKey = slug(key);
    if (!factKey) throw new Error('A fact needs a stable key (letters, digits, hyphens)');
    event.facts = [{ key: factKey, text: text.trim(), ...(supersedes ? { supersedes } : {}) }];
  } else if (kind === 'action') {
    event.actions = [{ id: slug(key) || id, status: 'open', text: text.trim() }];
  } else if (kind === 'context') {
    if (!task || !String(task).trim()) throw new Error('A context needs a task name');
    event.contexts = [{ id, task: String(task).trim(), text: text.trim(), ttl_days: Number(ttlDays) || 7, certainty: certainty === 'verified' ? 'verified' : 'reported' }];
  } else if (kind === 'experience') {
    const trig = (Array.isArray(triggers) ? triggers : String(triggers ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);
    if (!trig.length) throw new Error('An experience needs at least one trigger');
    if (!verification || !String(verification).trim()) throw new Error('An experience needs a verification note');
    event.experiences = [{ id, kind: scope === 'negative-search' ? 'negative-search' : 'path-finding', text: text.trim(), triggers: trig, verification: String(verification).trim(), scope: ws, ...(scope === 'negative-search' ? { boundary: String(verification).trim(), expires: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) } : { location: String(verification).trim() }) }];
  }
  // Validate now so the preview fails loudly instead of at execute time.
  validateEvent(event, config);
  return {
    kind: 'compose-event',
    summary: `新增${{ fact: '长期事实', action: '待办', context: '短期上下文', experience: '执行经验' }[kind]}：${text.trim().slice(0, 60)}`,
    changes: [{ field: kind, from: '(无)', to: text.trim().slice(0, 60) }],
    event,
  };
}

// Shared executor for the revision family. The plan already carries a fully built and
// validated event, so this only re-validates against the live config and appends.
function executeAppendEvent(config, transport, plan, kind) {
  if (!plan?.event) throw new Error('Revision plan is missing its event payload');
  validateEvent(plan.event, config);
  const result = record(config, transport, plan.event);
  return { ...result, consolidation: consolidate(config, transport), kind };
}

function executeComposeEvent(config, transport, plan) {
  // Re-validate at execute time: the preview may be minutes old and the topic or
  // evidence may have moved underneath it.
  validateEvent(plan.event, config);
  const result = record(config, transport, plan.event);
  return { ...result, consolidation: consolidate(config, transport), kind: 'compose-event' };
}

// --- Settings: editing the single JSON config file -----------------------------------
//
// The product is deliberately not a desktop app: every setting lives in one JSON config
// file the program reads, and the console is only an editor for that file. `update-config`
// rewrites `config.json` under the policy root through the same preview -> signed token
// -> execute handshake as every other write. It never edits Markdown, never binds a host
// (that rewrites other applications' config files and stays CLI-only) and never restarts
// a process.

export const CONFIG_FILE = 'config.json';

// Three editable groups, and only three. Roles are logical names, so a store can be
// reorganised without code depending on physical paths.
export const CONFIG_ROLE_FIELDS = Object.freeze([
  ['eventsRoot', '事件目录'],
  ['topicsRoot', '主题目录'],
  ['projectRoot', '项目目录'],
  ['habitsNote', '偏好笔记'],
  ['actionsNote', '待办笔记'],
  ['mistakesNote', '错误笔记'],
  ['candidatesNote', '候选笔记'],
  ['experienceNote', '经验笔记'],
  ['inboxRoot', '收集箱目录'],
]);

// [key, label, min, max, hint]
export const CONFIG_NUMBER_FIELDS = Object.freeze([
  ['activeLimit', '活跃项目注入条数', 1, 200, '活跃项目状态最多注入几条（缺省不限制）'],
  ['recentLimit', '近期变化注入条数', 1, 500, '近期变化最多注入几条（缺省不限制）'],
  ['recentDays', '近期变化天数窗口', 1, 3650, '近期变化的回溯天数（运行时缺省 14 天）'],
  ['budgetBytes', '注入预算（字节）', 256, 16 * 1024 * 1024, '注入正文的总预算，超出会折叠低优先级段落'],
]);

export const CONFIG_LAYOUT_OPTIONS = Object.freeze([
  ['neutral', '中性默认（逻辑角色名，不绑定任何私有目录结构）'],
  ['obsidian-notion', 'Obsidian / Notion 预设（既有私有布局）'],
]);

export const CONFIG_STORAGE_OPTIONS = Object.freeze([
  ['filesystem', '文件系统（默认，不需要任何外部服务）'],
  ['obsidian-cli', 'Obsidian CLI（必须同时填写 obsidianCli 与 vaultName）'],
]);

const CONFIG_FIELD_LABELS = Object.freeze({
  storage: '存储后端 storage',
  memoryRoot: 'memoryRoot（记忆库根目录）',
  vaultRoot: 'vaultRoot（Obsidian 库根目录）',
  vaultName: 'vaultName（Obsidian 库名称）',
  obsidianCli: 'obsidianCli（Obsidian CLI 路径）',
  layout: 'layout（布局）',
  activeLimit: 'activeLimit（活跃项目注入条数）',
  recentLimit: 'recentLimit（近期变化注入条数）',
  recentDays: 'recentDays（近期变化天数窗口）',
  budgetBytes: 'budgetBytes（注入预算字节）',
});

// The checkout this console ships in. A memory store must never live inside it: the
// checkout is disposable, the store is not.
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function configFilePath(config) {
  return path.join(config.policyRoot, CONFIG_FILE);
}

export function readConfigFile(config) {
  const file = configFilePath(config);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`无法读取配置文件 ${file}：${error.message}`); }
  try { return { file, text, raw: JSON.parse(text) }; }
  catch (error) { throw new Error(`配置文件不是合法 JSON（${file}）：${error.message}`); }
}

const trimText = (value) => String(value ?? '').trim();

function insideRepository(target) {
  let cursor = path.resolve(target);
  const tail = [];
  while (!fs.existsSync(cursor)) {
    tail.unshift(path.basename(cursor));
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const resolved = fs.existsSync(cursor) ? path.join(fs.realpathSync(cursor), ...tail) : path.resolve(target);
  const rel = path.relative(fs.realpathSync(REPOSITORY_ROOT), resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// A store root is acceptable when it exists and is writable, or when the nearest
// existing ancestor is a writable directory. `create` is set only by the write path, so
// merely opening the settings page never creates a directory.
function resolveStoreDir(value, field, issues, { create = false } = {}) {
  const label = field === 'memoryRoot' ? 'memoryRoot（记忆库根目录）' : 'vaultRoot（Obsidian 库根目录）';
  if (!value) { issues.push({ field, message: `${label}不能为空` }); return null; }
  if (!path.isAbsolute(value)) { issues.push({ field, message: `${label}必须是绝对路径：${value}` }); return null; }
  if (insideRepository(value)) {
    issues.push({ field, message: `${label}不能指向本项目仓库目录（${REPOSITORY_ROOT}），记忆库要放在仓库之外` });
    return null;
  }
  const target = path.resolve(value);
  if (fs.existsSync(target)) {
    let stat;
    try { stat = fs.statSync(target); } catch (error) { issues.push({ field, message: `${label}无法访问：${error.message}` }); return null; }
    if (!stat.isDirectory()) { issues.push({ field, message: `${label}已存在但不是目录：${target}` }); return null; }
    try { fs.accessSync(target, fs.constants.W_OK); } catch { issues.push({ field, message: `${label}不可写：${target}` }); return null; }
    return target;
  }
  let cursor = path.dirname(target);
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) { issues.push({ field, message: `${label}无法创建：${target}` }); return null; }
    cursor = parent;
  }
  let stat;
  try { stat = fs.statSync(cursor); } catch (error) { issues.push({ field, message: `${label}的上级路径无法访问：${error.message}` }); return null; }
  if (!stat.isDirectory()) { issues.push({ field, message: `${label}的上级路径不是目录，无法创建 ${target}` }); return null; }
  try { fs.accessSync(cursor, fs.constants.W_OK); } catch { issues.push({ field, message: `${label}的上级目录不可写，无法创建 ${target}` }); return null; }
  if (!create) return target;
  try { fs.mkdirSync(target, { recursive: true }); } catch (error) { issues.push({ field, message: `${label}创建失败：${error.message}` }); return null; }
  return target;
}

// Validates the editable groups and returns their normalized form. Every problem is
// collected rather than thrown one at a time, so the settings page can list all of them;
// the write path turns any non-empty list into a refusal (fail closed).
export function inspectConfigGroups(candidate = {}, { createRoots = false } = {}) {
  const issues = [];
  const notes = [];

  const storage = trimText(candidate.storage) || 'filesystem';
  if (!CONFIG_STORAGE_OPTIONS.some(([id]) => id === storage)) {
    issues.push({ field: 'storage', message: `存储后端只能是 filesystem 或 obsidian-cli（当前：${trimText(candidate.storage) || '(空)'}）` });
  }
  const layout = trimText(candidate.layout) || 'neutral';
  if (!CONFIG_LAYOUT_OPTIONS.some(([id]) => id === layout)) {
    issues.push({ field: 'layout', message: `布局只能是 neutral 或 obsidian-notion（当前：${trimText(candidate.layout) || '(空)'}）` });
  }
  const obsidianCli = trimText(candidate.obsidianCli);
  const vaultName = trimText(candidate.vaultName);
  if (storage === 'obsidian-cli') {
    if (!obsidianCli) issues.push({ field: 'obsidianCli', message: '选择 obsidian-cli 存储后必须填写 obsidianCli（Obsidian CLI 可执行文件路径）' });
    if (!vaultName) issues.push({ field: 'vaultName', message: '选择 obsidian-cli 存储后必须填写 vaultName（Obsidian 库名称）' });
  }

  const configuredMemoryRoot = trimText(candidate.memoryRoot);
  const memoryRoot = resolveStoreDir(configuredMemoryRoot, 'memoryRoot', issues, { create: createRoots });
  // An empty vaultRoot is unusable at runtime (every note path is resolved against it),
  // so it is materialised from memoryRoot instead of being written back as an empty string.
  const vaultRootValue = trimText(candidate.vaultRoot) || configuredMemoryRoot;
  const vaultRoot = resolveStoreDir(vaultRootValue, 'vaultRoot', issues, { create: createRoots });
  if (!trimText(candidate.vaultRoot) && configuredMemoryRoot) notes.push('vaultRoot 为空，运行时按 memoryRoot 解析。');

  const configuredRoles = candidate.roles && typeof candidate.roles === 'object' ? candidate.roles : {};
  const roles = {};
  for (const [key, label] of CONFIG_ROLE_FIELDS) {
    const value = trimText(configuredRoles[key]).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!value) { issues.push({ field: `roles.${key}`, message: `roles.${key}（${label}）不能为空` }); continue; }
    roles[key] = value;
  }
  if (memoryRoot && !fs.existsSync(memoryRoot)) notes.push('记忆库根目录还不存在，保存时会自动创建并校验角色路径。');
  // Preview validates new roots without creating them.
  for (const root of [memoryRoot, vaultRoot].filter(Boolean)) {
    for (const [key, label] of CONFIG_ROLE_FIELDS) {
      const value = roles[key];
      if (!value) continue;
      try {
        const rel = path.relative(root, path.resolve(root, value));
        if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes root');
        if (fs.existsSync(root)) inside(root, value);
      } catch (error) {
        issues.push({ field: `roles.${key}`, message: `roles.${key} (${label}) 必须位于记忆库根目录内 (${error.message})` });
      }
    }
  }
  const numbers = {};
  for (const [key, label, min, max] of CONFIG_NUMBER_FIELDS) {
    const raw = candidate[key];
    const value = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push({ field: key, message: `${label}（${key}）必须是 ${min} 到 ${max} 之间的整数，当前：${raw === undefined ? '(未设置)' : JSON.stringify(raw)}` });
      continue;
    }
    numbers[key] = value;
  }

  return {
    groups: {
      storage,
      layout,
      obsidianCli,
      vaultName,
      memoryRoot: configuredMemoryRoot,
      vaultRoot: vaultRootValue,
      roles,
      ...numbers,
    },
    issues,
    notes,
  };
}

function displayValue(value) {
  if (value === undefined || value === null) return '（未设置）';
  const text = String(value);
  return text === '' ? '（空）' : text;
}

// `field` is the human label the confirmation dialog prints and `key` is the machine
// name, because these fields have no entry in the dialog's own label table.
function configChanges(raw, next) {
  const changes = [];
  const compare = (key, label, before, after) => {
    if (String(before ?? '') === String(after ?? '')) return;
    changes.push({ field: label, key, from: displayValue(before), to: displayValue(after) });
  };
  for (const key of Object.keys(CONFIG_FIELD_LABELS)) compare(key, CONFIG_FIELD_LABELS[key], raw[key], next[key]);
  const rawRoles = raw.roles && typeof raw.roles === 'object' ? raw.roles : {};
  for (const [key, label] of CONFIG_ROLE_FIELDS) compare(`roles.${key}`, `roles.${key}（${label}）`, rawRoles[key], next.roles[key]);
  return changes;
}

// Builds the plan for a config edit: the whole candidate file is validated first, and the
// plan carries both the exact bytes it was built from and the exact bytes to write.
export function planUpdateConfig(config, input = {}) {
  const { file, text, raw } = readConfigFile(config);
  const candidate = { ...raw };
  for (const key of Object.keys(CONFIG_FIELD_LABELS)) if (input[key] !== undefined) candidate[key] = input[key];
  candidate.roles = { ...(raw.roles && typeof raw.roles === 'object' ? raw.roles : {}) };
  if (input.roles && typeof input.roles === 'object') {
    for (const [key] of CONFIG_ROLE_FIELDS) if (input.roles[key] !== undefined) candidate.roles[key] = input.roles[key];
  }
  const { groups, issues } = inspectConfigGroups(candidate, { createRoots: false });
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('；'));
  // Keys outside the three groups (topics, hook, workspaceAliases ...) are carried over
  // untouched: the console is an editor for three groups, not for the whole file.
  const next = { ...raw, ...groups };
  const changes = configChanges(raw, next);
  if (!changes.length) throw new Error('配置没有变化，无需写入');
  const labels = changes.map((change) => change.field);
  const shown = labels.slice(0, 4).join('、') + (labels.length > 4 ? ` 等 ${labels.length} 项` : '');
  return {
    kind: 'update-config',
    summary: `更新配置：${shown}`,
    changes,
    configPath: file,
    expectedConfigHash: sha(text),
    next,
  };
}

function executeUpdateConfig(config, transport, plan) {
  const file = configFilePath(config);
  let before;
  try { before = fs.readFileSync(file, 'utf8'); }
  catch (error) { throw new Error(`无法读取配置文件 ${file}：${error.message}`); }
  // The journal fingerprint already rejects a stale review; the config file itself can
  // also move under the reviewer (a hand edit, another tool), so the plan pins the exact
  // bytes it was built from.
  if (sha(before) !== plan.expectedConfigHash) throw new Error('配置文件在预览之后被改动；请重新预览再写入');
  const candidate = { ...plan.next };
  const { groups, issues } = inspectConfigGroups(candidate, { createRoots: false });
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('；'));
  const next = { ...candidate, ...groups };
  for (const root of [next.memoryRoot, next.vaultRoot]) fs.mkdirSync(root, { recursive: true });
  atomicJson(file, next);
  let written;
  try { written = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`配置写入后无法回读（${file}）：${error.message}`); }
  if (JSON.stringify(written) !== JSON.stringify(next)) {
    fs.writeFileSync(file, before, 'utf8');
    throw new Error('配置写入后校验不一致，已回滚到写入前的内容');
  }
  return {
    kind: 'update-config',
    configPath: file,
    configHash: sha(JSON.stringify(next)),
    changed: (plan.changes ?? []).map((change) => change.key ?? change.field),
    restartRequired: true,
  };
}
