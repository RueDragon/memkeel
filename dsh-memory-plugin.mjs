import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const name = 'agent-memory-hooks';
export const inject = [];

function message(text) {
  return Object.freeze({
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  });
}

export function textOf(messages) {
  return (Array.isArray(messages) ? messages : [messages]).flatMap((entry) => entry?.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function isUserMessage(entry) {
  if (!entry || entry.role !== 'user') return false;
  const sourceKind = entry.source?.kind;
  return sourceKind === 'user';
}

export function promptOf(messages) {
  const entry = (Array.isArray(messages) ? messages : []).findLast(isUserMessage);
  return entry ? textOf(entry) : '';
}

export function assistantReplyOf(messages) {
  const rows = Array.isArray(messages) ? messages : [];
  const userIndex = rows.findLastIndex(isUserMessage);
  if (userIndex < 0) return '';
  const entry = rows.slice(userIndex + 1).findLast((candidate) => candidate?.role === 'assistant');
  return entry ? textOf(entry) : '';
}

function base(agent, event) {
  return {
    session_id: agent?.session?.header?.id ?? '',
    cwd: agent?.session?.header?.cwd ?? process.cwd(),
    hook_event_name: event,
  };
}

function run(runner, host, input, timeoutMs, signal, memoryHome) {
  return new Promise((resolve, reject) => {
    const limit = 4 * 1024 * 1024;
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > limit) return reject(new Error('Hook payload exceeds bounded input'));
    if (signal?.aborted) return reject(new Error('hook runner aborted before spawn'));
    const child = spawn(process.execPath, ['--experimental-strip-types', runner, host, ...(memoryHome ? ['--home', memoryHome] : [])], {
      cwd: input.cwd,
      env: process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const abort = () => fail(new Error('hook runner aborted'));
    const settle = (error, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(output);
    };
    const fail = (error) => {
      if (settled) return;
      settle(error);
      child.kill();
    };
    const collect = (target, chunk) => (target + chunk.toString('utf8')).slice(-limit);
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk); });
    // Pipe errors are separate from ChildProcess errors and must stay handled after settlement.
    for (const [name, stream] of [['stdin', child.stdin], ['stdout', child.stdout], ['stderr', child.stderr]]) {
      stream.on('error', (error) => fail(new Error('hook runner ' + name + ': ' + error.message, { cause: error })));
    }
    child.once('error', fail);
    child.once('close', (code, exitSignal) => {
      if (settled) return;
      const details = 'code=' + code + ', signal=' + (exitSignal ?? 'none') + ', stdoutBytes=' + Buffer.byteLength(stdout);
      if (code !== 0) return settle(new Error('hook runner exited (' + details + '): ' + stderr.trim().slice(-2000)));
      try { settle(null, JSON.parse(stdout)); }
      catch (error) { settle(new Error('invalid hook output (' + details + '): ' + error.message)); }
    });
    timer = setTimeout(() => fail(new Error('hook runner timed out after ' + timeoutMs + 'ms')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try { child.stdin.end(payload); }
    catch (error) { fail(error); }
  });
}

function contextOf(output, event) {
  const specific = output?.hookSpecificOutput;
  return specific?.hookEventName === event && typeof specific.additionalContext === 'string'
    ? specific.additionalContext : '';
}

function permissionOf(output, event) {
  const specific = output?.hookSpecificOutput;
  return specific?.hookEventName === event ? specific : {};
}

export function apply(ctx, config) {
  const runner = config.runner;
  const timeoutMs = config.timeoutMs ?? 90000;
  if (typeof runner !== 'string' || !runner) throw new Error('agent-memory-hooks requires config.runner');
  const invoke = async (input, signal) => {
    try { return await run(runner, 'dsh', input, timeoutMs, signal, config.memoryHome); }
    catch (error) {
      ctx.logger.warn(`agent-memory-hooks: ${input.hook_event_name} failed: ${String(error)}`);
      return {};
    }
  };

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const prompt = promptOf(messages);
    if (!prompt) return next();
    const output = await invoke({ ...base(agent, 'UserPromptSubmit'), prompt }, signal);
    const decision = permissionOf(output, 'UserPromptSubmit');
    if (decision.permissionDecision === 'deny') return { kind: 'reject' };
    const downstream = await next();
    const context = contextOf(output, 'UserPromptSubmit');
    if (!context || downstream.kind !== 'enter') return downstream;
    return { ...downstream, messages: [...downstream.messages, message(context)] };
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const output = await invoke({
      ...base(exec.agent, 'PreToolUse'),
      tool_name: exec.name,
      tool_input: exec.arguments,
      tool_use_id: exec.callId,
    }, exec.signal);
    const decision = permissionOf(output, 'PreToolUse');
    if (decision.permissionDecision === 'deny') {
      return { kind: 'deny', reason: decision.permissionDecisionReason ?? 'blocked by memory experience check' };
    }
    if (decision.permissionDecision === 'ask') {
      return { kind: 'ask', ...(decision.permissionDecisionReason ? { reason: decision.permissionDecisionReason } : {}) };
    }
    return next();
  });

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const output = await invoke({
      ...base(exec.agent, 'PostToolUse'),
      tool_name: exec.name,
      tool_input: exec.arguments,
      tool_use_id: exec.callId,
      tool_response: { text: textOf([{ content: result.content ?? [] }]), isError: false },
    }, exec.signal);
    const downstream = await next();
    const context = contextOf(output, 'PostToolUse');
    if (!context) return downstream;
    const extra = message(context);
    return { ...downstream, additionalContexts: [extra, ...(downstream.additionalContexts ?? [])] };
  });

  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    const messages = typeof agent?.session?.deriveMessages === 'function'
      ? agent.session.deriveMessages()
      : [];
    const lastAssistant = assistantReplyOf(messages);
    await invoke({
      ...base(agent, 'Stop'),
      ...(lastAssistant ? { last_assistant_message: lastAssistant } : {}),
      stop_hook_active: false,
    }, signal);
  });
}
