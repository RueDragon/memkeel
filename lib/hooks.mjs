import fs from 'node:fs';
import path from 'node:path';
import { bootstrap, checkOperation, recallLearning, recallFacts, loadRoutes, discoverWorkspace, normalizeWorkspace } from './core.mjs';
import { formatFacts } from './fact-retrieval.mjs';
import { redactSecrets } from './redaction.mjs';
import { resolveCollection } from './privacy.mjs';
import { atomicJson, sha, withLock } from './transport.mjs';

export const hookVersion = 1;
function boundedContext(text, maxBytes = 18000) {
  let result = '';
  let bytes = 0;
  for (const char of text) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    result += char;
  }
  return result;
}
export function redact(value, limit = 1300) {
  return redactSecrets(value).replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]+)/gi, '[REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|secret|authorization|cookie)\s*["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[REDACTED]@')
    .replace(/```|<!--|-->/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '').slice(0, limit);
}
// Codex turns hook additionalContext into a developer message. PreToolUse fires
// between a tool call and its output, and PostToolUse can fire while the other
// calls of the same assistant message are still outstanding, so an advisory
// injected mid-sequence splits tool_calls from its tool results. Strict Responses
// providers reject that ordering, so for every Codex model the advisory is
// carried to the next prompt instead of being injected mid-sequence. Deny
// decisions are unaffected: hookOutput returns them before the additionalContext
// branch is reached.
// Model names cannot establish whether the forwarding provider accepts interleaved
// tool messages. Legacy model lists are intentionally ignored for safe upgrades.
function defersAdvisory(config) {
  return config?.hook?.codexDeferAdvisory !== false;
}
// The hook payload carries transcript_path but no model, so the active model is
// read from the tail of the rollout log. The transcript is held open by Codex
// while it runs, so every failure path degrades to an empty result.
function transcriptModel(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    const { size } = fs.statSync(transcriptPath);
    if (!size) return '';
    const window = Math.min(size, 1048576);
    const fd = fs.openSync(transcriptPath, 'r');
    let text = '';
    try {
      const buffer = Buffer.alloc(window);
      fs.readSync(fd, buffer, 0, window, size - window);
      text = buffer.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = text.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      if (!lines[index].includes('turn_context')) continue;
      const hit = lines[index].match(/"model":"([^"]+)"/);
      if (hit) return hit[1];
    }
    return '';
  } catch { return ''; }
}
export function observedModel(input) {
  const direct = String(input?.model ?? '').trim();
  return direct || transcriptModel(input?.transcript_path ?? input?.agent_transcript_path);
}
export function normalizeHook(host, input) {
  const toolInput = input.tool_input ?? input.toolInput ?? {};
  const tool = input.tool_name ?? input.toolName ?? '';
  const command = toolInput.command ?? toolInput.cmd ?? '';
  const kind = /search|glob|grep|find|list.*file/i.test(tool) || /\brg\b|Get-ChildItem|\bfind\b/.test(command) ? 'search'
    : command ? 'shell' : /edit|write|patch/i.test(tool) ? 'edit' : 'other';
  return { host, event: input.hook_event_name ?? input.hookEventName, session: input.session_id ?? input.sessionId,
    transcriptPath: input.transcript_path ?? input.agent_transcript_path ?? '',
    cwd: input.cwd, prompt: input.prompt ?? input.userPrompt ?? '', tool, toolInput,
    operation: { kind, command: String(command), cwd: toolInput.cwd ?? toolInput.workdir ?? input.cwd, shell: toolInput.shell,
      description: toolInput.description ?? tool }, input };
}
export function hookOutput(event, context = '', blocked) {
  if (blocked && event === 'PreToolUse') return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'deny', permissionDecisionReason: blocked } };
  if (blocked && event === 'Stop') return { decision: 'block', reason: blocked };
  if (context && ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(event))
    return { hookSpecificOutput: { hookEventName: event, additionalContext: redactSecrets(context) } };
  return {};
}
function recentQueue(config, workspace, query, cwd) {
  const dir = path.join(config.policyRoot, 'state/hook-queue');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
  }).filter((r) => (workspace ? r?.workspace === workspace : normalizeWorkspace(r?.cwd) === normalizeWorkspace(cwd)) && r.status === 'pending' && r.context && Date.now() - Date.parse(r.at) < 7 * 86400000)
    .filter((r) => !query || /继续|记忆|项目|context|resume/i.test(query) || r.context.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 2);
}
export function processHook(config, host, input, { occurredAt } = {}) {
  const call = normalizeHook(host, input);
  if (!['codex', 'claude', 'zcode', 'dsh'].includes(host) || !call.session || !call.cwd || !path.isAbsolute(call.cwd)) throw new Error('Hook requires known host, session_id and actual absolute cwd');
  const key = sha(`${host}\0${call.session}`).slice(0, 24);
  const root = path.join(config.policyRoot, 'state/hook-sessions', key);
  const file = path.join(root, 'session.json');
  return withLock(root, () => {
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { revision: hookVersion, injected: [], counts: {}, observations: [], turn: 0 };
    let route; let routeError;
    try { route = discoverWorkspace(config, call.cwd, loadRoutes(config)); }
    catch (error) { routeError = error.message; }
    state.routeError = routeError;
    // One collection decision per hook call, evaluated once and shared by every layer below. A gate
    // that each writer evaluated for itself is a gate that can disagree with itself, and "collection
    // is off" has to be a single fact rather than four similar-looking checks.
    const collection = resolveCollection(config, { host, workspace: route?.id, cwd: call.cwd });
    state.collection = collection;
    state.host = host; state.cwd = call.cwd; state.workspace = route?.id; state.updatedAt = new Date().toISOString();
    // Keep the raw ids so the console can locate the host's real transcript file; the
    // session directory name stays the hash key and is never used to look up files.
    state.sessionId = call.session;
    if (call.transcriptPath) state.transcriptPath = call.transcriptPath;
    state.counts[call.event] = (state.counts[call.event] ?? 0) + 1;
    if (call.event === 'SessionStart' || call.event === 'UserPromptSubmit') {
      const model = observedModel(input);
      if (model) state.model = model;
    }
    let output = {};
    // The deferral gate is shared by PreToolUse and PostToolUse: both can land a
    // developer message in the middle of an open tool group. Deny decisions never
    // reach it, because hookOutput returns the blocked result first.
    const currentModel = () => {
      let activeModel = input.model ?? state.model ?? '';
      if (!activeModel && !state.modelProbed) {
        // The hook can start mid-session, so probe the transcript once instead of
        // reading it before every tool call.
        state.modelProbed = true;
        activeModel = observedModel(input);
        if (activeModel) state.model = activeModel;
      }
      return activeModel;
    };
    const deferForCodex = (text) => {
      if (!text || host !== 'codex' || !defersAdvisory(config, currentModel())) return text;
      state.deferredAdvisory = [...(state.deferredAdvisory ?? []), { at: state.updatedAt, text: redact(text, 2000) }].slice(-3);
      return '';
    };
    const memoryTool = /(?:^|[_:.])agent_memory(?:[_:.]|$)/.test(call.tool);
    if (call.event === 'SessionStart') {
      if (!state.bootstrapped || input.source === 'compact') {
        const context = bootstrap(config, call.cwd, '').text;
        output = hookOutput(call.event, `[agent-memory-hook:bootstrap] 已由原生 hook 注入，禁止再重复 bootstrap。\n${context}`);
        state.bootstrapped = true;
      }
    } else if (call.event === 'UserPromptSubmit') {
      const promptDigest = sha(String(call.prompt));
      if (state.promptDigest !== promptDigest || state.lastStop) {
        state.turn++; state.promptDigest = promptDigest; state.lastStop = false;
        state.readOnly = /不(?:要)?(?:记录|保存|写收尾|写入记忆|写入)|禁止.*写入|只读(?:验收|测试)|do not (?:save|record)|no memory writes/i.test(call.prompt);
        // Neither an explicit no-record request nor a switched-off collection may leave the prompt in
        // the session file. That file is runtime state, but it is still on disk, and "not collected"
        // has to mean the text was never written rather than written and then hidden.
        state.prompt = state.readOnly || !collection.collecting ? '' : redact(call.prompt, 900);
        state.observations = []; state.tools = 0; state.lastAssistant = '';
      }
      let context = '';
      // dsh SessionStart is detached. The synchronous first prompt also owns
      // bootstrap when it wins the session lock, preventing duplicate injection.
      if (!state.bootstrapped) { context += `[agent-memory-hook:bootstrap]\n${bootstrap(config, call.cwd, call.prompt).text}\n`; state.bootstrapped = true; }
      const rows = recallLearning(config, { cwd: call.cwd, query: /^(继续|接着|continue|resume)[。.!\s]*$/i.test(call.prompt) ? '' : call.prompt, type: 'contexts' });
      const experiences = recallLearning(config, { cwd: call.cwd, query: call.prompt });
      for (const row of [...rows, ...experiences]) {
        if (state.injected.includes(row.event_id + '/' + row.id)) continue;
        context += `\n[历史${row.type}] ${row.text} (事件 ${row.event_id}，${row.at}；使用前复核)\n`;
        state.injected.push(row.event_id + '/' + row.id);
      }
      for (const row of recentQueue(config, route?.id, call.prompt, call.cwd)) {
        if (state.injected.includes(row.id)) continue;
        context += `\n[未核验短期检查点 ${row.at}] ${row.context}\n`; state.injected.push(row.id);
      }
      state.injected = state.injected.slice(-80);
      // Re-evaluate facts each prompt, including repeated questions and changed evidence.
      const facts = recallFacts(config, call.prompt, route?.id, true);
      const factContext = formatFacts(facts);
      state.factRecall = { query: collection.collecting ? redact(call.prompt, 160) : '', matched: facts.map((f) => ({ topic: f.topic, key: f.key, event_id: f.event_id, crossWorkspace: f.crossWorkspace })), at: state.updatedAt };
      const deferred = (state.deferredAdvisory ?? []).map((row) => `\n[上轮工具执行经验·延后送达 ${row.at}]\n${row.text}\n`).join('');
      state.deferredAdvisory = [];
      output = hookOutput(call.event, boundedContext(redactSecrets((factContext + '\n' + deferred + context).trim())));
    } else if (call.event === 'PreToolUse' && !memoryTool) {
      const check = checkOperation(config, { operation: call.operation, cwd: call.cwd });
      const digest = sha(JSON.stringify({ matched: check.matched, warnings: check.warnings, ids: check.experiences.map((r) => r.event_id) }));
      let text = '';
      if (check.experiences.length || check.warnings.length) text = `[执行经验检查]\n${check.warnings.join('\n')}\n${check.experiences.map((r) => `${r.text}；${r.location ?? ''}；事件 ${r.event_id}；使用前复核`).join('\n')}`;
      if (state.lastCheck === digest && check.allowed) text = '';
      state.lastCheck = digest;
      // Defer only the advisory. A deny decision is still returned below for every
      // host and every model, because hookOutput checks the blocked argument first.
      output = hookOutput(call.event, deferForCodex(text), check.allowed ? undefined : check.matched.map((r) => `${r.reason} ${r.fix}`).join('\n'));
    } else if (['PostToolUse', 'PostToolUseFailure'].includes(call.event) && !memoryTool) {
      state.tools = (state.tools ?? 0) + 1;
      const failed = call.event === 'PostToolUseFailure' || input.tool_response?.isError === true;
      state.observations.push({ tool: redact(call.tool, 80), kind: call.operation.kind, failed });
      state.observations = state.observations.slice(-12);
      const text = failed ? '本次工具失败不是已确认错误。重试前先核对原因和可能副作用；若修正方法已验证，用 capture.experiences 记录适用边界与证据。'
        : call.operation.kind === 'search' && state.tools % 5 === 0 ? '已进行多步搜索。找到真实路径或明确排除范围后，请立即 capture 一个带证据的路径/搜索经验与任务上下文，避免压缩后重复探索。' : '';
      output = hookOutput(call.event, deferForCodex(text));
    } else if (['Stop', 'PreCompact', 'SessionEnd'].includes(call.event)) {
      const supplied = redact(input.last_assistant_message ?? input.responseText ?? '', 1500);
      const assistant = state.readOnly || !collection.collecting ? '' : supplied || state.lastAssistant || '';
      if (!state.readOnly && collection.collecting && assistant) state.lastAssistant = assistant;
      const text = `任务要求（用户报告）：${state.prompt ?? ''}\n最近回复（未复核，不是当前事实）：${assistant || '宿主未提供回复正文；只保留任务线索。'}\n工具概况：${state.observations.map((r) => `${r.tool}:${r.failed ? '失败待查' : '已返回未判定'}`).join('；')}`;
      if (!collection.collecting) {
        // Checkpoints are the layer that turns a turn into evidence, so this is the gate the plan
        // names first. Nothing is queued, and the reason is recorded so "why is my history empty"
        // has an answer that is not a guess.
        state.checkpoint = { status: 'skipped', reason: 'collection-disabled', decidedBy: collection.decidedBy };
      } else if (!state.readOnly && state.prompt && (assistant || state.tools > 0)) {
        const at = occurredAt ?? new Date().toISOString();
        if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(at) || !Number.isFinite(Date.parse(at))) throw new Error('Invalid checkpoint occurrence time');
        const id = `hook-${key}-${state.turn}-${sha(text).slice(0, 10)}`;
        const queueFile = path.join(config.policyRoot, 'state/hook-queue', `${id}.json`);
        if (!fs.existsSync(queueFile)) atomicJson(queueFile, { version: hookVersion, id, host, cwd: call.cwd, workspace: route?.id,
          at, context: redact(text, 2000), task: redact(state.prompt, 120), status: 'pending', session: key });
        state.lastQueued = id;
        state.checkpoint = { status: 'queued', id, at, ...(routeError ? { routeError } : {}) };
      } else {
        state.checkpoint = { status: 'skipped', reason: state.readOnly ? 'no-record' : !state.prompt ? 'no-user-prompt' : 'no-assistant-or-tools' };
      }
      state.lastStop = true;
    }
    atomicJson(file, state);
    return output;
  });
}

