import fs from 'node:fs';
import path from 'node:path';

export function checkpointHealth(config, events) {
  const pending = []; const held = []; const unqueued = []; const invalid = []; const missingEvents = []; const uninitialized = [];
  const queueRoot = path.join(config.policyRoot, 'state/hook-queue');
  const sessionRoot = path.join(config.policyRoot, 'state/hook-sessions');
  const queueIds = new Set();
  const eventIds = events && new Set(events.map((event) => event.event_id));
  for (const name of fs.existsSync(queueRoot) ? fs.readdirSync(queueRoot) : []) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(queueRoot, name), 'utf8'));
      queueIds.add(row.id);
      if (row.status === 'pending') pending.push({ id: row.id, workspace: row.workspace, at: row.at, error: row.lastError });
      // A checkpoint deferred by the collection switch is an intentional state, not a fault: it is
      // reported so the reason is visible, but it does not make the store unhealthy. Counting it as
      // invalid would turn "collection is off" into a permanent red health check.
      else if (row.status === 'held') held.push({ id: row.id, workspace: row.workspace, at: row.at, reason: row.reason ?? 'collection-disabled', decidedBy: row.decidedBy ?? null });
      else if (row.status !== 'consumed') invalid.push({ file: name, error: 'Unknown checkpoint status' });
      else if (eventIds && !eventIds.has(row.event_id)) missingEvents.push(row.id);
    } catch (error) { invalid.push({ file: name, error: error.message }); }
  }
  for (const id of fs.existsSync(sessionRoot) ? fs.readdirSync(sessionRoot) : []) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(sessionRoot, id, 'session.json'), 'utf8'));
      if (!row.lastStop || row.readOnly || !row.prompt || !(row.tools > 0 || row.checkpoint?.status === 'queued')) continue;
      if (!row.lastQueued?.startsWith('hook-' + id + '-' + row.turn + '-') || !queueIds.has(row.lastQueued))
        unqueued.push({ session: id, host: row.host, cwd: row.cwd, at: row.updatedAt, reason: row.checkpoint?.reason ?? 'finished-without-checkpoint' });
    } catch (error) {
      if (error.code === 'ENOENT') uninitialized.push(id);
      else invalid.push({ file: id + '/session.json', error: error.message });
    }
  }
  return { healthy: !pending.length && !unqueued.length && !invalid.length && !missingEvents.length, pending, held, unqueued, invalid, missingEvents, uninitialized };
}
