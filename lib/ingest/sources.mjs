import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Harness-agnostic history ingest. Backfills durable memory from transcripts the
// host already wrote to disk, so the system is useful on day one instead of only
// capturing forward. Classification is positive-identification and fail-closed:
// only a genuinely authored user turn can become a candidate; injected rule
// blocks, tool output, system messages and unknown rows never do.

export const EventKind = Object.freeze({
  AUTHORED_USER: 'authored_user',
  AUTHORED_ASSISTANT: 'authored_assistant',
  TOOL_RESULT: 'tool_result',
  META_INJECTION: 'meta_injection',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
});

// Blocks hosts lace into a role=user message. Anything starting with one of these
// is harness-injected, not authored by the user.
const INJECTED_PREFIXES = [
  '# AGENTS.md',
  '# Codex desktop context',
  '# Files mentioned by the user:',
  '<INSTRUCTIONS>',
  '<app-context>',
  '<environment_context',
  '<recommended_plugins>',
  '<subagent_notification>',
  '<turn_aborted',
  '<user_instructions',
  'PLEASE IMPLEMENT THIS PLAN:',
  'Implement task-scoped',
  '## 1. 本次事件已落盘',
  '## 本次事件已落盘',
];

// Inter-agent coordination turns also arrive with role=user. They describe a
// sub-agent reporting to or polling its parent, not a durable user intent, so they
// must not become memory candidates even though no wrapper tag marks them.
const AGENT_COORDINATION = [
  /\bparent\s+(needs|ready|actual|requires|expects)\b/i,
  /\bsub-?agent\b/i,
  /\b(status|time)\s*\/?\s*status\s+check\b/i,
  /^\s*(ACTUAL|Real)\s+(begin|apply|update|run|check)\b/i,
  /^\s*Additional integration issues\b/i,
  /^\s*Docs now complete\b/i,
  /^\s*Reviewed\s+(launcher|the)\b/i,
];

export function isAgentCoordination(text) {
  const head = String(text ?? '').trimStart();
  return AGENT_COORDINATION.some((pattern) => pattern.test(head));
}

export function isInjected(text) {
  const head = String(text ?? '').trimStart();
  return INJECTED_PREFIXES.some((prefix) => head.startsWith(prefix)) || isAgentCoordination(head);
}

export function classifyCodexMessage(role, text) {
  if (role === 'user') return isInjected(text) ? EventKind.META_INJECTION : EventKind.AUTHORED_USER;
  if (role === 'assistant') return EventKind.AUTHORED_ASSISTANT;
  if (role === 'system' || role === 'developer') return EventKind.SYSTEM;
  return EventKind.UNKNOWN;
}

// Codex rollout logs live under ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
export function codexSessionRoot(home = os.homedir()) {
  return path.join(home, '.codex', 'sessions');
}

export function listCodexSessions(root = codexSessionRoot()) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

function extractText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block.text === 'string' && ['input_text', 'output_text', 'text'].includes(block.type))
    .map((block) => block.text)
    .join('\n')
    .trim();
}

// Parses one Codex rollout file into normalized events. Fail-closed: a row that
// does not parse contributes nothing rather than being guessed at.
export function parseCodexSession(file) {
  const events = [];
  const text = fs.readFileSync(file, 'utf8');
  let meta = { sessionId: path.basename(file, '.jsonl'), cwd: '', timestamp: '', threadSource: '' };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    const payload = row?.payload;
    if (row?.type === 'session_meta' && payload) {
      meta = {
        sessionId: payload.session_id ?? payload.id ?? meta.sessionId,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : '',
        timestamp: payload.timestamp ?? row.timestamp ?? '',
        // thread_source distinguishes a real user thread from a sub-agent, an
        // automation or an agent-created thread. This is the most reliable signal
        // available and does not depend on guessing at message wording.
        threadSource: String(payload.thread_source ?? ''),
      };
      continue;
    }
    if (row?.type !== 'response_item' || payload?.type !== 'message') continue;
    const content = extractText(payload.content);
    if (!content) continue;
    const kind = classifyCodexMessage(payload.role, content);
    events.push({
      kind,
      role: String(payload.role ?? ''),
      text: content,
      timestamp: row.timestamp ?? null,
      sessionId: meta.sessionId,
      cwd: meta.cwd,
      sourcePath: file,
      harness: 'codex',
    });
  }
  return { sessionId: meta.sessionId, cwd: meta.cwd, threadSource: meta.threadSource, events };
}

// One candidate per authored user turn. Assistant turns are retained in the stream
// but never become candidates; injected blocks, tool output and system rows are
// excluded by kind.
export function selectCandidates(transcripts) {
  const candidates = [];
  for (const transcript of transcripts) {
    let lastAssistant = '';
    for (const event of transcript.events) {
      if (event.kind === EventKind.AUTHORED_ASSISTANT) { lastAssistant = event.text; continue; }
      if (event.kind !== EventKind.AUTHORED_USER) continue;
      candidates.push({
        text: event.text,
        sessionId: transcript.sessionId,
        cwd: transcript.cwd || path.dirname(event.sourcePath),
        timestamp: event.timestamp,
        sourcePath: event.sourcePath,
        harness: event.harness,
        antecedent: lastAssistant,
        kind: 'user',
      });
    }
  }
  return candidates;
}
