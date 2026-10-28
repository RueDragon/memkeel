import test from 'node:test';
import assert from 'node:assert/strict';
import { createManagedDocument, projectState, replaceManagedBlock } from '../lib/state-projection.mjs';

const now = '2026-10-27T12:00:00.000Z';
const event = (event_id, occurred_at, recorded_at, extra = {}) => ({
  event_id, workspace: 'demo', topic: 'demo/task', agent: 'codex', occurred_at, recorded_at,
  evidence: ['proof.md'], ...extra,
});

test('state projection uses occurred_at for activity and recorded_at for ingestion watermark', () => {
  const result = projectState({
    now,
    events: [
      event('backfilled', '2026-09-01T10:00:00Z', '2026-10-26T10:00:00Z', { facts: [{ key: 'old', text: 'old fact' }] }),
      event('recent', '2026-10-26T10:00:00Z', '2026-10-27T10:00:00Z', { contexts: [{ id: 'task', task: 'Active task', text: 'Latest progress', certainty: 'reported' }] }),
    ],
  });
  assert.equal(result.generated_at, '2026-10-27T12:00:00.000Z');
  assert.equal(result.recent_projects.length, 1);
  assert.equal(result.recent_projects[0].source_event_id, 'recent');
  assert.equal(result.health.latest_processed_recorded_at, '2026-10-27T10:00:00.000Z');
  assert.equal(result.stable_knowledge[0].occurred_at, '2026-09-01T10:00:00.000Z');
  assert.equal(result.stable_knowledge[0].recorded_at, '2026-10-26T10:00:00.000Z');
});

test('long-unupdated open actions are isolated from current tasks and are not closed', () => {
  const result = projectState({
    now,
    staleTodoDays: 30,
    events: [
      event('old-todo', '2026-09-01T10:00:00Z', '2026-10-26T10:00:00Z', { actions: [{ id: 'todo', status: 'open', text: 'Review old item' }] }),
      event('done', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z', { actions: [{ id: 'done', status: 'done', text: 'Ship result' }] }),
    ],
  });
  assert.equal(result.stale_todos.length, 1);
  assert.equal(result.stale_todos[0].id, 'todo');
  assert.equal(result.stale_todos[0].stale_since, '2026-09-01T10:00:00.000Z');
  assert.equal(result.stale_todos[0].status, 'open');
  assert.equal(result.current_tasks.length, 0);
  assert.equal(result.recent_completed.length, 1);
});

test('managed block replacement preserves manual content and rejects unsafe markers', () => {
  const document = `# Summary\nManual note\n\n${createManagedDocument('<!-- header -->', 'old state')}`;
  const replaced = replaceManagedBlock(document, 'new state');
  assert.equal(replaced.status, 'replaced');
  assert.match(replaced.text, /Manual note/);
  assert.match(replaced.text, /new state/);
  assert.doesNotMatch(replaced.text, /old state/);
  assert.equal(replaceManagedBlock('# no managed section', 'new').status, 'missing');
  assert.equal(replaceManagedBlock('<!-- AUTO-MANAGED:START -->a<!-- AUTO-MANAGED:START -->b<!-- AUTO-MANAGED:END -->', 'new').status, 'conflict');
  assert.throws(() => createManagedDocument('header', '<!-- AUTO-MANAGED:END -->'), /reserved markers/);
});
