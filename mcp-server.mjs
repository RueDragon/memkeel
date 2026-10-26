import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootstrap, recall, record, consolidate, registerTopic, loadEvents, consumptionStatus } from './lib/core.mjs';
import { capture, decideHabit, maintain } from './lib/lifecycle.mjs';
import { createTransport } from './lib/storage/index.mjs';
import { recallLearning, checkOperation } from './lib/core.mjs';
import { loadConfig, resolveHome } from './lib/config.mjs';
import { submitCapture, captureStatus } from './lib/capture-queue.mjs';
import { startCheckpointWorker } from './lib/checkpoint-worker.mjs';

// Home precedence is shared with the CLI and the hook runner: an explicit --home wins over
// MEMKEEL_HOME, which wins over the per-user default.
const homeArg = process.argv.indexOf('--home');
if (homeArg >= 0 && !process.argv[homeArg + 1]) throw new Error('--home requires a directory');
const { home: root } = resolveHome({ home: homeArg >= 0 ? process.argv[homeArg + 1] : '' });
const tool = { name: 'agent_memory', description: `Shared Markdown memory only. Read with agent_memory_read. At meaningful stage boundaries, capture important explicit decisions, verified corrections/completed stages, or an explicit user request to remember. Ordinary searches, path exploration and tool failures do not require capture. Example: { action: "capture", input: { event_id: "20260909-zcode-example-01", workspace: "my-project", topic: "my-project/service-profile", agent: "zcode", facts: [{ key: "verified-point", text: "A short verified conclusion." }] }, evidence_text: "Actual checked evidence." }. Capture validates then durably queues by default. queued means queue only; recorded means ledger exists but projections pending; ready means completed; needs_attention requires inspection. Query read-only status with receipt_id. wait:true opts into synchronous completion. New workspace/key topics in registered workspaces can be registered after validation; explicit register requires input.id, workspace and title. JSON-string capture input and embedded evidence_text are accepted. Never claim a queue receipt is an archive. Filesystem storage needs no Obsidian; strict obsidian-cli never automatically falls back. No arbitrary filesystem/shell access. habit_decide requires explicit user quote evidence. Use help for the full contract.`,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['help', 'status', 'bootstrap', 'recall', 'knowledge_recall', 'knowledge_inspect', 'experience_recall', 'context_recall', 'check_operation', 'capture', 'record', 'consolidate', 'maintenance', 'register', 'habit_decide'] },
    operation: { type: 'object' }, task: { type: 'string' },
    cwd: { type: 'string' }, query: { type: 'string' }, workspace: { type: 'string' }, history: { type: 'boolean' },
    input: { anyOf: [{ type: 'object' }, { type: 'string' }], description: 'Capture accepts an event object (preferred) or JSON-encoded object, with optional embedded evidence_text. For register: id (workspace/key), workspace, title and optional alias.' },
    wait: { type: 'boolean', description: 'Capture only: true explicitly waits for synchronous recording and consolidation; default false durably queues and returns a receipt, not an archive claim.' },
    receipt_id: { type: 'string', description: 'For status: event_id of a capture receipt.' },
    evidence_text: { type: 'string', description: 'For capture: actual observations, plain Markdown without fences or HTML comments; no secrets or raw logs.' }
  } } };
const readActions = ['help', 'status', 'bootstrap', 'recall', 'knowledge_recall', 'knowledge_inspect', 'experience_recall', 'context_recall', 'check_operation'];
// A workspace identity is a path in the *store's* convention, which need not match the
// platform this process runs on: a store created on Windows can be read from Linux or WSL,
// and normalizeWorkspace already treats `C:/x` and `C:\x` as the same identity. So accept any
// absolute-looking path, not only the current platform's, while still refusing to guess one
// from the MCP server's own working directory.
const absoluteWorkspace = (value) => typeof value === 'string'
  && (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value));
const readTool = { ...tool, name: 'agent_memory_read', description: 'Read-only shared Obsidian memory. Start with bootstrap and actual cwd, then reuse its returned facts; recall only for missing detail, never in parallel with the first bootstrap. status reports current pending events. Cannot write, capture, confirm habits, rebuild or execute shell commands.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: 'object', required: ['action'], additionalProperties: false, properties: { action: { type: 'string', enum: readActions },
    operation: { type: 'object', description: 'For check_operation: kind, command, shell, cwd, boundary. Static preflight is not authorization.' }, task: { type: 'string' },
    cwd: { type: 'string', description: 'Required for bootstrap: the actual absolute working directory, not the MCP server directory.' }, query: { type: 'string' },
    workspace: { type: 'string', description: 'Recall scope: workspace ID, display name or absolute path. For bootstrap, an absolute path here is accepted as a cwd alias; a display name alone is not enough.' }, history: { type: 'boolean' },
    receipt_id: { type: 'string', description: 'For status: event_id of a capture receipt; reading does not start or retry work.' } } } };
function dispatch(args) {
  const { config } = loadConfig(root);
  const transport = createTransport(config);
  switch (args.action) {
    case 'help': return fs.readFileSync(path.join(root, 'event-schema.md'), 'utf8');
    case 'status': { const events = loadEvents(config); return { events: events.length, ...consumptionStatus(config, events), captures: captureStatus(config, args.receipt_id), writerLocked: fs.existsSync(path.join(root, 'state/writer.lock')) }; }
    case 'bootstrap': {
      const cwd = args.cwd ?? (absoluteWorkspace(args.workspace) ? args.workspace : undefined);
      if (!cwd || !absoluteWorkspace(cwd)) throw new Error('Actual absolute workspace cwd is required; do not infer it from the MCP server process');
      return bootstrap(config, cwd, args.query ?? '', args.workspace).text;
    }
    case 'recall': return recall(config, args.query ?? '', args.workspace, args.history ?? false);
    case 'knowledge_recall':
    case 'knowledge_inspect': {
      if (!args.workspace || !config.topics.some((t) => t.workspace === args.workspace)) throw new Error('Explicit registered workspace ID required');
      const command = args.action === 'knowledge_recall' ? 'recall' : 'inspect';
      if (command === 'recall' && !args.query?.trim()) throw new Error('Non-empty query required');
      const script = fileURLToPath(new URL('./scripts/knowledge-upgrade.mjs', import.meta.url));
      const child = spawnSync(process.execPath, [script, command, '--home', root, '--workspace', args.workspace,
        ...(command === 'recall' ? ['--query', args.query] : [])],
      { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
      if (![0, 2].includes(child.status)) throw new Error('Knowledge operation failed; inspect local CLI diagnostics');
      return JSON.parse(child.stdout);
    }
    case 'experience_recall': return recallLearning(config, { ...args, type: 'experiences' });
    case 'context_recall': return recallLearning(config, { ...args, type: 'contexts' });
    case 'check_operation': return checkOperation(config, args);
    case 'capture': {
      if (args.wait === true) return capture(config, transport, args.input, args.evidence_text);
      const queued = submitCapture(config, args.input, args.evidence_text);
      startCheckpointWorker(root);
      return queued;
    }
    case 'record': return { ...record(config, transport, args.input), consolidation: consolidate(config, transport) };
    case 'consolidate': return consolidate(config, transport);
    case 'maintenance': return maintain(config, transport);
    case 'register': return registerTopic(config, args.input);
    case 'habit_decide': return decideHabit(config, transport, args.input);
    default: throw new Error('Unsupported memory action');
  }
}
function respond(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`); }
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  let message;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Request too large');
    message = JSON.parse(line);
    if (message.id === undefined) continue;
    if (message.method === 'initialize') respond(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'lu-agent-memory', version: '1.1.0' } });
    else if (message.method === 'ping') respond(message.id, {});
    else if (message.method === 'tools/list') respond(message.id, { tools: [readTool, tool] });
    else if (message.method === 'tools/call' && [tool.name, readTool.name].includes(message.params?.name)) {
      try {
        if (message.params.name === readTool.name && !readActions.includes(message.params.arguments?.action)) throw new Error('Read-only tool cannot perform writes');
        const result = dispatch(message.params.arguments ?? {}); respond(message.id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }); }
      catch (error) { respond(message.id, { isError: true, content: [{ type: 'text', text: error.message }] }); }
    } else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })}\n`);
  } catch (error) { if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: error.message } })}\n`); }
}
