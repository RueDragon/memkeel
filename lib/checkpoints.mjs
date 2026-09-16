import fs from 'node:fs';
import { redactSecrets } from './redaction.mjs';
import path from 'node:path';
import { registerTopic, loadEvents, loadRoutes, ensureWorkspace } from './core.mjs';
import { capture } from './lifecycle.mjs';
import { resolveCollection } from './privacy.mjs';
import { atomicJson, withLock } from './transport.mjs';

function utf8(text, max) {
  let result = '';
  for (const char of String(text)) { if (Buffer.byteLength(result + char) > max) break; result += char; }
  return result;
}
function eventText(text, max) {
  return utf8(redactSecrets(text), max).replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}
export function drainCheckpoints(config, transport, { limit = 20 } = {}) {
  const root = path.join(config.policyRoot, 'state/hook-queue');
  if (!fs.existsSync(root)) return { processed: 0, errors: [] };
  return withLock(root, () => {
    let processed = 0; const errors = []; let held = 0;
    const known = new Set(loadEvents(config).map((event) => event.event_id));
    // `held` rows are re-considered on every pass: they were deferred, not decided, so turning
    // collection back on drains them normally.
    const rows = fs.readdirSync(root).filter((name) => name.endsWith('.json')).map((name) => ({ file: path.join(root, name), row: JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) }))
      .filter(({ row }) => row.status === 'pending' || row.status === 'held').sort((a, b) => a.row.at.localeCompare(b.row.at)).slice(0, limit);
    for (const { file, row } of rows) {
      try {
        // Queued-but-not-yet-drained is the gap that matters most: a checkpoint written before the
        // switch was turned off must not become evidence afterwards, or "off" would only mean "off
        // for new sessions" while the text already on disk kept arriving in the ledger.
        const collection = resolveCollection(config, { host: row.host, workspace: row.workspace, cwd: row.cwd });
        if (!collection.collecting) {
          // `held`, not a terminal status: the row was collected while collection was on and is only
          // being *deferred*. Marking it decided would silently discard something the user had
          // already agreed to keep, and would make turning collection back on unable to recover it.
          if (row.status !== 'held') atomicJson(file, { ...row, status: 'held', reason: 'collection-disabled', decidedBy: collection.decidedBy, heldAt: new Date().toISOString() });
          held += 1;
          continue;
        }
        // A checkpoint whose event is already recorded — an out-of-band recovery or a manual
        // repair — must be closed rather than retried forever: capture() refuses to append
        // its evidence a second time, so the row would otherwise stay pending for good and
        // keep the checkpoint health check red.
        if (known.has(row.id)) {
          atomicJson(file, { ...row, status: 'consumed', consumedAt: new Date().toISOString(), event_id: row.id, recovered: true });
          processed += 1;
          continue;
        }
        if (!row.capture) {
          const existingRoute = loadRoutes(config).find((route) => route.id === row.workspace);
          if (existingRoute) transport.verify(existingRoute.note);
          else {
            const route = ensureWorkspace(config, transport, row.cwd);
            row.workspace = route.id;
            atomicJson(file, row);
          }
          let topic = config.topics.find((t) => t.workspace === row.workspace && [t.title, ...(t.aliases ?? [])].some((alias) => row.task.toLowerCase().includes(alias.toLowerCase())));
          if (!topic) {
            const id = `${row.workspace}/task-context`;
            topic = config.topics.find((t) => t.id === id);
            if (!topic) { topic = registerTopic(config, { id, workspace: row.workspace, title: `${row.workspace} 近期任务上下文`, alias: '近期任务' }); config.topics.push(topic); }
          }
          const id = `session-${row.session}`;
          const prior = loadEvents(config).filter((e) => e.topic === topic.id && e.contexts?.some((c) => c.id === id)).at(-1);
          row.capture = { event: { event_id: row.id, workspace: row.workspace, topic: topic.id, agent: row.host, occurred_at: row.at,
            contexts: [{ id, task: eventText(row.task, 160), text: eventText(row.context, 1100), certainty: 'reported', ttl_days: 30,
              ...(prior ? { supersedes: prior.event_id } : {}) }] },
          evidence_text: `原生 hook 自动检查点。来源：${row.host}，会话指纹 ${row.session}，时间 ${row.at}。只保存脱敏截断的用户要求及回复片段，不将回复提升为已验证事实。\n${utf8(redactSecrets(row.context), 1100)}` };
          atomicJson(file, row);
        }
        const result = capture(config, transport, row.capture.event, row.capture.evidence_text);
        atomicJson(file, { ...row, status: 'consumed', consumedAt: new Date().toISOString(), event_id: result.event_id });
        processed++;
      } catch (error) {
        atomicJson(file, { ...row, lastError: error.message, lastAttemptAt: new Date().toISOString() });
        errors.push({ id: row.id, error: error.message });
      }
    }
    return { processed, held, errors };
  });
}
