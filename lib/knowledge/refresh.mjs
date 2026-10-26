import { atomicJson, sha } from '../transport.mjs';
import { replacePageBlock } from './pages.mjs';

// A persisted publication intent makes page/manifest writes recoverable. If the
// process dies after the page write, a retry recognises the exact published bytes.
export function publishPage({ relative, existing, page, previousManifest, pendingIntent,
  transport, writeIntent, writeManifest, clearIntent, sourceCheck }) {
  if (pendingIntent) {
    if (pendingIntent.relative !== relative) throw new Error('Publication target mismatch');
    if (sha(existing) === pendingIntent.nextHash) {
      if (!sourceCheck()) throw new Error('Page sources changed during recovery');
      if (transport.verify(relative).replaceAll('\r\n', '\n').trim() !== existing.replaceAll('\r\n', '\n').trim())
        throw new Error('Recovered page readback mismatch');
      writeManifest(pendingIntent.manifest);
      clearIntent();
      return { recovered: true, manifest: pendingIntent.manifest };
    }
    if (sha(existing) !== pendingIntent.previousHash) throw new Error('Interrupted page changed manually');
    // A never-published intent is safe to replace only against its original bytes.
  }
  const next = replacePageBlock(existing, page.body, previousManifest);
  if (!sourceCheck()) throw new Error('Page sources changed');
  const intent = { relative, previousHash: sha(existing), nextHash: sha(next), manifest: page.manifest };
  writeIntent(intent);
  if (!existing) transport.create(relative, next);
  else transport.replace(relative, existing, next);
  if (transport.verify(relative).replaceAll('\r\n', '\n').trim() !== next.replaceAll('\r\n', '\n').trim()) throw new Error('Page readback mismatch');
  writeManifest(page.manifest);
  clearIntent();
  return { recovered: false, manifest: page.manifest };
}

export function planRefreshes(topics, projection, manifests, pageState, pendingTopics = []) {
  return topics.map((topic) => ({ topic: topic.id,
    state: pageState(manifests[topic.id], projection, topic.id, pendingTopics) }))
    .filter((row) => row.state !== 'fresh');
}

// One task per page revision. Failures are visible and retries are bounded.
export function mergeRefreshQueue(previous = [], tasks, { retryFailed = false } = {}) {
  const byTopic = new Map(previous.map((task) => [task.topic, task]));
  for (const task of tasks) {
    const old = byTopic.get(task.topic);
    if (old?.revision === task.revision && old.status !== 'done'
      && !(retryFailed && ['failed', 'deferred'].includes(old.status))) continue;
    byTopic.set(task.topic, { ...task, status: 'queued', attempts: 0 });
  }
  return [...byTopic.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

export async function runRefreshQueue(tasks, run, { maxAttempts = 3 } = {}) {
  const result = [];
  for (const task of tasks) {
    if (task.status === 'done' || task.attempts >= maxAttempts) { result.push(task); continue; }
    try { await run(task); result.push({ ...task, status: 'done', attempts: task.attempts + 1 }); }
    catch { result.push({ ...task, status: 'failed', attempts: task.attempts + 1, error: 'refresh-failed' }); }
  }
  return result;
}

export const writeDerivedJson = atomicJson;
