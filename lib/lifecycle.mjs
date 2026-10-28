import fs from 'node:fs';
import { redactSecrets } from './redaction.mjs';
import path from 'node:path';
import { record, loadEvents, consolidate, localDay, validateEvent, canonicalJson, refreshIndex, registerTopic, loadRoutes } from './core.mjs';
import { habitBlocks, preferenceProjection } from './preferences.mjs';
import { atomicJson, inside, sha, withLock } from './transport.mjs';
import { publishCatalog } from './catalog.mjs';
import { drainCheckpoints } from './checkpoints.mjs';
import { AccessLog } from './access-log.mjs';
import { settleProjection } from './weight.mjs';
import { planPromotions, promotionEvent } from './learning.mjs';
import { reserveCapture } from './capture-reservation.mjs';
import { admissionDecision } from './governance.mjs';

// Agents often send `input` as a JSON string, or put evidence_text inside it. Accept both
// shapes so a formatting slip does not cost the record; anything else gets a precise error.
export function normalizeCaptureArgs(input, evidenceText) {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new Error('Capture input must be an object, but the string given is not valid JSON'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capture input must be an object with event_id, workspace, topic, agent, facts; pass evidence_text as a separate argument');
  if (typeof input.evidence_text === 'string') {
    const { evidence_text: inner, ...rest } = input;
    if (evidenceText !== undefined && evidenceText !== inner) throw new Error('Conflicting evidence_text arguments');
    return { input: rest, evidenceText: evidenceText ?? inner };
  }
  return { input, evidenceText };
}

// A missing topic is registered on the spot when it is unambiguous: the workspace must already
// exist and the id must be `<workspace>/<kebab-case>`. Typos in the workspace still fail.
function ensureCaptureTopic(config, input) {
  if (config.topics.some((t) => t.id === input.topic && t.workspace === input.workspace)) return null;
  if (typeof input.topic !== 'string' || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(input.topic) || input.topic.split('/')[0] !== input.workspace) return null;
  if (config.topics.some((t) => t.id === input.topic)) return null;
  if (!loadRoutes(config).some((row) => row.id === input.workspace)) return null;
  const key = input.topic.split('/')[1];
  const topic = registerTopic(config, { id: input.topic, workspace: input.workspace, title: key.replace(/-/g, ' '), alias: key.replace(/-/g, ' ') });
  return topic;
}

// Validation uses a proposed topic in memory only. No plan, registration or evidence is
// published until every caller-supplied field and existing evidence reference passed.
export function prepareCapture(config, rawInput, rawEvidenceText) {
  const { input, evidenceText } = normalizeCaptureArgs(rawInput, rawEvidenceText);
  if (typeof evidenceText !== 'string' || !evidenceText.trim() || /<!--|```/.test(evidenceText)) throw new Error('Evidence must be non-empty plain Markdown, without fences or HTML comments; pass it as the separate evidence_text argument');
  const inputJson = JSON.stringify(input) ?? '';
  if (redactSecrets(evidenceText) !== evidenceText || redactSecrets(inputJson) !== inputJson) throw new Error('Possible secret; redact before capture');
  if (/\bsk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|(?:password|apiKey|access_token)\s*[:=]\s*\S{5,}/i.test(evidenceText)) throw new Error('Possible secret in capture evidence');
  let topics = config.topics;
  if (!topics.some((t) => t.id === input.topic && t.workspace === input.workspace)
      && typeof input.topic === 'string' && /^[a-z0-9-]+\/[a-z0-9-]+$/.test(input.topic)
      && input.topic.split('/')[0] === input.workspace && !topics.some((t) => t.id === input.topic)
      && loadRoutes(config).some((row) => row.id === input.workspace)) topics = [...topics, { id: input.topic, workspace: input.workspace }];
  const now = new Date().toISOString();
  validateEvent({ ...input, occurred_at: input.occurred_at ?? now, recorded_at: input.recorded_at ?? now,
    evidence: [...(input.evidence ?? []), config.habitsNote] }, { ...config, topics });
  return { input, evidenceText, digest: sha(canonicalJson({ input, evidenceText })) };
}

export function admitCapture(config, rawInput, rawEvidenceText, { source = 'mcp', explicit = false, noRecord = false } = {}) {
  const normalized = normalizeCaptureArgs(rawInput, rawEvidenceText);
  const input = normalized.input;
  const event = input.event && typeof input.event === 'object' ? input.event : input;
  const stateChange = Boolean((event.facts?.length ?? 0) || (event.actions?.length ?? 0)
    || (event.preferences?.length ?? 0) || (event.habit_decisions?.length ?? 0) || (event.experiences?.length ?? 0));
  const contextText = [...(event.contexts ?? []), ...(event.facts ?? []), ...(event.actions ?? []), ...(event.experiences ?? [])]
    .flatMap((row) => [row.task, row.text]).filter(Boolean).join('\n');
  return admissionDecision({ source, text: contextText || normalized.evidenceText,
    explicit: explicit === true, stateChange, noRecord: noRecord || input.noRecord === true || input.no_record === true,
    config, collectionContext: { host: event.agent, workspace: event.workspace, cwd: event.cwd, source } });
}

export function capture(config, transport, rawInput, rawEvidenceText, { deferConsolidation = false, source = 'mcp', explicit = false, noRecord = false } = {}) {
  const admission = admitCapture(config, rawInput, rawEvidenceText, { source, explicit, noRecord });
  if (!admission.admitted) return { status: 'skipped', recorded: false, reason: admission.reason };
  const prepared = prepareCapture(config, rawInput, rawEvidenceText);
  const { evidenceText, digest } = prepared;
  const captureInput = prepared.input;
  withLock(path.join(config.policyRoot, 'state'), () => reserveCapture(config, captureInput.event_id, digest));
  const priorPlans = path.join(config.policyRoot, 'state/captures.json');
  const priorPlan = fs.existsSync(priorPlans) ? JSON.parse(fs.readFileSync(priorPlans, 'utf8'))[captureInput.event_id] : null;
  if (priorPlan && priorPlan.digest !== digest) throw new Error('Capture id reused with different evidence or event');
  const autoRegistered = ensureCaptureTopic(config, captureInput);
  const prior = loadEvents(config).find((event) => event.event_id === captureInput.event_id);
  const planFile = path.join(config.policyRoot, 'state', 'captures.json');
  const plan = withLock(path.join(config.policyRoot, 'state'), () => {
    const plans = fs.existsSync(planFile) ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : {};
    const digest = sha(canonicalJson({ input: captureInput, evidenceText }));
    if (plans[captureInput.event_id] && plans[captureInput.event_id].digest !== digest) throw new Error('Capture id reused with different evidence or event');
    const recordedAt = plans[captureInput.event_id]?.recorded_at ?? prior?.recorded_at ?? captureInput.recorded_at ?? new Date().toISOString();
    const relative = `${config.eventsRoot}/Evidence/${localDay(recordedAt)}-${captureInput.workspace}.md`;
    const evidence = `${relative}#${captureInput.event_id}`;
    const finalEvent = { ...captureInput, occurred_at: captureInput.occurred_at ?? prior?.occurred_at ?? recordedAt, recorded_at: recordedAt, evidence: [...new Set([...(captureInput.evidence ?? []), evidence])] };
    validateEvent({ ...finalEvent, evidence: [config.habitsNote] }, config);
    if (/\bsk-[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|(?:password|apiKey|access_token)\s*[:=]\s*\S{5,}/i.test(evidenceText)) throw new Error('Possible secret in capture evidence');
    plans[captureInput.event_id] ??= { digest, recorded_at: recordedAt, path: relative, evidence, input: captureInput, evidenceText };
    atomicJson(planFile, plans);
    if (!fs.existsSync(inside(config.vaultRoot, relative))) transport.create(relative, `---\ntype: memory-evidence\nworkspace_id: ${captureInput.workspace}\ndate: ${localDay(recordedAt)}\n---\n# Agent 验证证据\n\n短证据按事件标识追加；不是新的长期习惯或自动执行指令。`);
    const block = `## ${captureInput.event_id}\n${evidenceText.trim()}`;
    const current = transport.verify(relative);
    if (!current.includes(block)) {
      if (current.includes(`## ${captureInput.event_id}\n`)) throw new Error('Existing capture evidence changed');
      transport.append(relative, block);
    }
    return plans[captureInput.event_id];
  });
  const result = record(config, transport, { ...captureInput, occurred_at: captureInput.occurred_at ?? prior?.occurred_at ?? plan.recorded_at, recorded_at: plan.recorded_at, evidence: [...new Set([...(captureInput.evidence ?? []), plan.evidence])] });
  if (result.duplicate) {
    transport.verify(`${config.eventsRoot}/${localDay(plan.recorded_at)}-${captureInput.workspace}-${captureInput.agent}.md`);
  }
  return { ...result, status: deferConsolidation ? 'recorded' : 'ready', evidence: plan.evidence, ...(autoRegistered ? { autoRegisteredTopic: autoRegistered.id } : {}), ...(deferConsolidation ? {} : { consolidation: consolidate(config, transport) }) };
}

export function decideHabit(config, transport, input) {
  const events = loadEvents(config);
  const candidate = events.find((event) => event.event_id === input.candidate_event);
  if (!candidate?.preferences?.some((rule) => rule.id === input.preference_id)) throw new Error('Candidate not found');
  const baseline = habitBlocks(fs.readFileSync(inside(config.vaultRoot, config.habitsNote), 'utf8'))[0]?.rules ?? [];
  const projection = preferenceProjection(events, baseline);
  const old = projection.decisions.get(`${input.candidate_event}/${input.preference_id}`);
  const existing = events.find((event) => event.event_id === input.event_id);
  const decision = existing?.habit_decisions?.[0] ?? { candidate_event: input.candidate_event, preference_id: input.preference_id,
    status: input.status, evidence: input.evidence, user_quote: input.user_quote, ...(old ? { supersedes: old.event_id } : {}) };
  if (existing && ['candidate_event', 'preference_id', 'status', 'evidence', 'user_quote'].some((key) => decision[key] !== input[key])) throw new Error('Decision retry changed content');
  const result = record(config, transport, { event_id: input.event_id, workspace: candidate.workspace, topic: candidate.topic,
    agent: input.agent ?? 'codex', occurred_at: existing?.occurred_at ?? new Date().toISOString(), evidence: [input.evidence], habit_decisions: [decision] });
  return { ...result, consolidation: consolidate(config, transport) };
}

// Settles weight from the access log and promotes only the candidates that earned
// it. Both steps are bounded and auditable: weight affects ranking only, and the
// strongest status an automatic pass can assign is probationary.
function settleWeights(config) {
  const log = new AccessLog(config);
  const markerFile = path.join(config.policyRoot, 'state', 'weight-settled.json');
  const since = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')).at : null;
  const events = loadEvents(config);
  const rows = [];
  for (const event of events) {
    for (const fact of event.facts ?? []) rows.push({ type: 'facts', id: fact.key, topic: event.topic, at: event.recorded_at, weight: Number(fact.weight ?? 1) });
  }
  const changed = settleProjection(rows, { readsSinceLastPass: log.countsSince(since), lastAccess: log.lastAccess(), now: config.now ?? new Date() }, config);
  atomicJson(markerFile, { at: new Date().toISOString(), changed });
  return { settled: changed.length, changed: changed.slice(0, 20) };
}

function promoteHabits(config, transport) {
  const events = loadEvents(config);
  const habitText = fs.readFileSync(inside(config.vaultRoot, config.habitsNote), 'utf8');
  const baseline = habitBlocks(habitText)[0]?.rules ?? [];
  const planned = planPromotions({ events, baseline, accessLog: new AccessLog(config), now: config.now ?? new Date(), config });
  const promoted = []; const errors = [];
  for (const row of planned) {
    const workspace = row.topic.split('/')[0];
    const evidence = config.eventsRoot + '/Evidence/' + localDay() + '-' + workspace + '.md';
    const marker = '## habit-probation-' + row.candidateEvent + '-' + row.id;
    try {
      if (!fs.existsSync(inside(config.vaultRoot, evidence))) transport.create(evidence, '---\ntype: memory-evidence\nworkspace_id: ' + workspace + '\ndate: ' + localDay() + '\n---\n# Agent 验证证据\n\n自动提升证据按事件标识追加。');
      const current = transport.verify(evidence);
      if (!current.includes(marker)) transport.append(evidence, marker + '\n自动提升：偏好 ' + row.id + ' 在 ' + row.readCount + ' 次检索中反复命中且已存在 ' + row.ageDays + ' 天，从 candidate 升至 probationary。该级别仅参与检索提示，不作为强制规则；确认仍需用户明确原话。');
      record(config, transport, promotionEvent(row, { evidence: evidence + '#habit-probation-' + row.candidateEvent + '-' + row.id }));
      promoted.push({ id: row.id, readCount: row.readCount });
    } catch (error) { errors.push({ id: row.id, error: error.message }); }
  }
  return { promoted, errors };
}
export function maintain(config, transport, { rebuild = false } = {}) {
  const checkpoints = drainCheckpoints(config, transport);
  const plansFile = path.join(config.policyRoot, 'state/captures.json');
  const plans = fs.existsSync(plansFile) ? JSON.parse(fs.readFileSync(plansFile, 'utf8')) : {};
  const existing = new Set(loadEvents(config).map((event) => event.event_id));
  const recoveredCaptures = []; const captureErrors = [];
  for (const [id, plan] of Object.entries(plans)) if (!existing.has(id)) {
    try {
      if (!plan.input || !plan.evidenceText) throw new Error(`Incomplete capture ${id} lacks recovery payload; inspect it before continuing`);
      const result = capture(config, transport, plan.input, plan.evidenceText, { source: 'recovery', explicit: true });
      if (result.status === 'skipped') {
        captureErrors.push({ event_id: id, error: `Capture recovery held: ${result.reason}` });
        continue;
      }
      recoveredCaptures.push(result.event_id);
    } catch (error) { captureErrors.push({ event_id: id, error: error.message }); }
  }
  const weights = settleWeights(config);
  const habitPromotion = promoteHabits(config, transport);
  const consolidation = consolidate(config, transport, { rebuild });
  const index = refreshIndex(config);
  const catalog = withLock(path.join(config.policyRoot, 'state'), () => publishCatalog(config, transport, index));
  refreshIndex(config);
  return { healthy: !captureErrors.length && !checkpoints.errors.length && !habitPromotion.errors.length, checkpoints, recoveredCaptures, captureErrors, weights, habitPromotion, consolidation, index: index.io, catalog };
}




