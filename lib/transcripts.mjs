import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { msg } from './messages.mjs';

// Locates and parses each host's real on-disk conversation transcript so the console
// can show the actual dialogue next to the recorded summary. Read-only: this module
// never writes anywhere. Every host stores transcripts differently, so each gets its
// own locator and parser. A missing or unreadable file degrades to an explicit
// `available: false` reason instead of throwing.

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function fileInfo(file) {
  try {
    const stat = fs.statSync(file);
    return { file, mtime: stat.mtime.toISOString(), size: stat.size };
  } catch {
    return null;
  }
}

// A session id is used only to match a filename, never to build one, so strip any
// path separators a hostile id could smuggle in.
function safeToken(value) {
  return asString(value).replace(/[^A-Za-z0-9_.-]/g, '');
}

// Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl. The transcript
// path is usually supplied by the hook; fall back to a bounded recursive search by
// thread id so older sessions without a recorded path still resolve by name.
function findCodex(sessionId, transcriptPath, cwd) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const id = safeToken(sessionId);
  if (!id) return '';
  const root = path.join(HOME, '.codex', 'sessions');
  if (!fs.existsSync(root)) return '';
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < 4000) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      visited += 1;
      if (visited > 4000) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.includes(id) && entry.name.endsWith('.jsonl')) return full;
    }
  }
  return '';
}

// Claude Code: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl. The cwd slug replaces
// every non-alphanumeric character with '-'.
function findClaude(sessionId, transcriptPath, cwd) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const id = safeToken(sessionId);
  if (!id) return '';
  const root = path.join(HOME, '.claude', 'projects');
  if (!fs.existsSync(root)) return '';
  const slug = cwd ? cwd.replace(/[^A-Za-z0-9]/g, '-') : '';
  const candidates = [];
  if (slug) candidates.push(path.join(root, slug, `${id}.jsonl`));
  try {
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (dir.isDirectory()) candidates.push(path.join(root, dir.name, `${id}.jsonl`));
    }
  } catch { /* fall through to the linear candidate list */ }
  return candidates.find((file) => fs.existsSync(file)) ?? '';
}

// dsh: ~/.dsh/sessions/<workspace-slug>/session-<sessionId>/session.v3.jsonl.zstd.
// The body is zstd-compressed inside the session directory.
function findDsh(sessionId, transcriptPath, cwd) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const id = safeToken(sessionId);
  if (!id) return '';
  const root = path.join(HOME, '.dsh', 'sessions');
  if (!fs.existsSync(root)) return '';
  const candidates = [`session-${id}`, id];
  try {
    for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue;
      for (const name of candidates) {
        const dir = path.join(root, ws.name, name);
        if (!fs.existsSync(dir)) continue;
        for (const file of ['session.v3.jsonl.zstd', 'session.jsonl.zstd', 'session.jsonl']) {
          const full = path.join(dir, file);
          if (fs.existsSync(full)) return full;
        }
      }
    }
  } catch { /* unreadable root is treated as not found */ }
  return '';
}

// zcode writes two different kinds of files:
//   - rollout/model-io-sess_<id>.jsonl : the real main conversation (request/response per turn)
//   - agents/sess_<id>/agent_*/transcript.jsonl : sub-agent event logs
// The hook records ids like `sess_<uuid>`, so try the rollout file first. Only fall back
// to the largest sub-agent transcript when no rollout file exists.
function findZcode(sessionId, transcriptPath, cwd) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const id = safeToken(sessionId).replace(/^sess_/, '');
  if (!id) return '';
  const cli = path.join(HOME, '.zcode', 'cli');
  const rollout = path.join(cli, 'rollout', `model-io-sess_${id}.jsonl`);
  if (fs.existsSync(rollout)) return rollout;
  const root = path.join(cli, 'agents', `sess_${id}`);
  if (!fs.existsSync(root)) return '';
  let best = '';
  let bestSize = -1;
  try {
    for (const agent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!agent.isDirectory()) continue;
      const file = path.join(root, agent.name, 'transcript.jsonl');
      if (!fs.existsSync(file)) continue;
      const size = fs.statSync(file).size;
      if (size > bestSize) { best = file; bestSize = size; }
    }
  } catch { /* unreadable session dir treated as not found */ }
  return best;
}

const LOCATORS = { codex: findCodex, claude: findClaude, dsh: findDsh, zcode: findZcode };

// Parses the plaintext JSONL hosts (codex / claude / zcode) into chat turns. Each host
// nests the message body differently, so the extractor is per-host but the outer
// "one JSON object per line, role + text" shape is shared.
function readParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => asString(part?.text) || asString(part?.content)).filter(Boolean).join('\n');
}

// Some hosts record tool-injected context as a user turn: AGENTS.md reminders, skill
// catalogs, runtime snapshots, memory bootstrap text, and hook nudges. Those are not
// things the user typed, so they are dropped before a turn is shown. Only clearly
// machine-generated prefixes are matched; normal prose is never guessed at.
const INJECTED_USER_PREFIXES = [
  '<system-reminder>',
  '<INSTRUCTIONS>',
  '# AGENTS.md instructions',
  'Current runtime context.',
  '以下是已记录的长期事实',
  '已进行多步搜索。',
  '已由原生 hook 注入',
];

function isInjectedUserText(text) {
  const trimmed = String(text || '').trimStart();
  return INJECTED_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

// Codex/Claude/zcode are line-oriented, but the message body sits at a different
// depth per host. `role` and `content` are read from the object that actually holds
// the message, never assumed from the outer wrapper.
function parseJsonl(host, raw, limit) {
  const turns = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const payload = obj?.payload ?? obj;
    const role = asString(payload?.role) || asString(payload?.message?.role) || asString(obj?.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const text = readParts(payload?.content ?? payload?.message?.content ?? obj?.message?.content ?? obj?.content).trim();
    if (!text) continue;
    // Skip injected system scaffolding that some hosts record as a user turn.
    if (isInjectedUserText(text)) continue;
    turns.push({ role, text, at: asString(obj?.timestamp) || asString(payload?.timestamp) });
    if (turns.length >= limit) break;
  }
  return turns;
}

// zcode has two record shapes:
//   - rollout `model_io`: { sessionId, request: { messages, messageOffset, messagesKind }, response: { text }, ... }
//     Each line is one model call. The real user turn is the LAST user message with
//     real prose; earlier user entries are hook/skill/context injections. `response.text`
//     is the assistant's visible reply.
//   - agents `transcript.jsonl`: a streaming event log where `model_request` carries the
//     last user entry and `model_complete` carries the answer.
// Both are handled here; `model_io` is checked first since that is the main-thread file.
function zcodeUserText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    const text = readParts(m?.content).trim();
    if (!text) continue;
    if (isInjectedUserText(text)) continue;
    return text;
  }
  return '';
}

function parseZcode(raw, limit) {
  const turns = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const at = asString(obj?.timestamp) || asString(obj?.completedAt) || asString(obj?.startedAt);
    if (obj?.type === 'model_io') {
      const text = zcodeUserText(obj?.request?.messages);
      if (text) turns.push({ role: 'user', text, at });
      const reply = asString(obj?.response?.text).trim();
      if (reply) turns.push({ role: 'assistant', text: reply, at });
    } else if (obj?.type === 'model_request') {
      const text = zcodeUserText(obj?.payload?.messages);
      if (text && !turns.some((t) => t.role === 'user' && t.text === text)) turns.push({ role: 'user', text, at });
    } else if (obj?.type === 'model_complete') {
      const text = asString(obj?.payload?.content).trim();
      if (text) turns.push({ role: 'assistant', text, at });
    }
    if (turns.length >= limit) break;
  }
  return turns;
}

// dsh stores zstd frames that Node's zlib cannot fully decode (it stops after the
// first frame), so decode through the Python zstandard stream reader. If the module
// is not installed, report that precisely rather than returning an empty transcript.
function readZstd(file) {
  const script = [
    'import sys',
    'try:',
    '    import zstandard as zstd',
    'except Exception as e:',
    "    sys.stderr.write('NO_ZSTD:' + str(e)); sys.exit(3)",
    'd = zstd.ZstdDecompressor()',
    'with open(sys.argv[1], "rb") as f:',
    '    with d.stream_reader(f) as r:',
    '        sys.stdout.buffer.write(r.read())',
  ].join('\n');
  const result = spawnSync('python', ['-c', script, file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return { error: (result.stderr || 'zstd decode failed').trim() };
  return { text: result.stdout };
}

// dsh records are `{ type, seq, time, data }`. User and assistant turns live in
// `user/message` / `assistant/message`, with the body under `data.message.content`.
// Reasoning and tool-call blocks are dropped: only visible text is kept.
function parseDsh(raw, limit) {
  const turns = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const type = asString(obj?.type);
    const role = type === 'user/message' ? 'user' : type === 'assistant/message' ? 'assistant' : '';
    if (!role) continue;
    const content = obj?.data?.message?.content ?? obj?.data?.content;
    const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
    const text = blocks
      .filter((p) => !p?.type || p.type === 'text')
      .map((p) => asString(p?.text))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!text) continue;
    // dsh stores hook reminders, skill catalogs, runtime snapshots and memory context as
    // `user/message` alongside the real input. Hide those so the transcript reads like a
    // conversation; assistant turns are never filtered.
    if (role === 'user' && isInjectedUserText(text)) continue;
    const at = Number.isFinite(obj?.time) ? new Date(obj.time).toISOString() : asString(obj?.time);
    turns.push({ role, text, at });
    if (turns.length >= limit) break;
  }
  return turns;
}

// Public entry: resolve the host's real transcript and return a bounded, parsed view.
// `available: false` always carries a human-readable `reason` for the UI.
export function loadTranscript({ host, sessionId, transcriptPath, cwd }, { limit = 400 } = {}) {
  const locator = LOCATORS[host];
  if (!locator) return { available: false, reason: msg('cli.transcript.unknownHost', { host: host || msg('cli.transcript.hostEmpty') }), source: '', turns: [] };
  let file = '';
  try { file = locator(sessionId, transcriptPath, cwd); } catch (error) { return { available: false, reason: msg('cli.transcript.locateFailed', { error: error.message }), source: '', turns: [] }; }
  if (!file || !fs.existsSync(file)) {
    return { available: false, reason: msg(sessionId ? 'cli.transcript.notFound' : 'cli.transcript.noSessionId'), source: '', turns: [] };
  }
  const info = fileInfo(file);
  if (!info) return { available: false, reason: msg('cli.transcript.unreadable'), source: file, turns: [] };

  if (host === 'dsh' || file.endsWith('.zstd')) {
    const decoded = readZstd(file);
    if (decoded.error) {
      return { available: false, reason: msg(decoded.error.startsWith('NO_ZSTD:') ? 'cli.transcript.noZstd' : 'cli.transcript.decodeFailed', { error: decoded.error }), source: file, turns: [] };
    }
    return { available: true, reason: '', source: file, mtime: info.mtime, size: info.size, turns: parseDsh(decoded.text, limit), truncated: false };
  }

  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { return { available: false, reason: msg('cli.transcript.readFailed', { error: error.message }), source: file, turns: [] }; }
  const turns = host === 'zcode' ? parseZcode(raw, limit) : parseJsonl(host, raw, limit);
  return { available: true, reason: '', source: file, mtime: info.mtime, size: info.size, turns, truncated: false };
}


