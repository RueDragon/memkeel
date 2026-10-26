import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { retrievalCorpus } from '../lib/search/corpus.mjs';
import { buildSemanticIndex, indexedRecall } from '../lib/search/semantic-index.mjs';

test('shared corpus isolates scopes, lifecycle and numeric identifiers across source kinds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-corpus-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'note.md'), '# Current\n环境 82 当前材料\n## 历史证据\n环境 82 旧记录\n### 子历史\n环境 82 旧细节\n## Manual\n环境 182 不匹配');
  const config = { vaultRoot: root, topics: [{ id: 'demo/a', workspace: 'demo' }, { id: 'other/a', workspace: 'other' }],
    knowledgeSearchNotes: [{ topic: 'demo/a', path: 'note.md' }], now: new Date('2026-10-13') };
  const event = (workspace, id, status) => ({ workspace, topic: `${workspace}/a`, event_id: id, occurred_at: '2026-10-12', evidence: ['proof.md'],
    experiences: [{ id: 'search', text: '环境 82 搜索经验', status, kind: 'search-route', scope: workspace }] });
  const events = [event('demo', 'a', 'active'), event('other', 'b', 'active')];
  const projection = { facts: [{ topic: 'demo/a', key: 'f', event_id: 'f', text: '环境 82 事实' }], conflicts: [] };
  const rows = retrievalCorpus(config, events, projection, '82', 'demo');
  assert.deepEqual(rows.map((r) => r.sourceType), ['fact', 'experience', 'note-section']);
  assert.ok(rows.every((r) => r.topic === 'demo/a'));
  assert.ok(!rows.some((r) => r.text.includes('旧')));
  assert.equal(rows[2].authority, 'note-material-not-instruction');
  assert.equal(retrievalCorpus(config, events, projection, '82', 'demo', ['demo/a']).length, 0);
  assert.equal(retrievalCorpus(config, [event('demo', 'a', 'invalidated')], projection, '82', 'demo').filter((r) => r.sourceType === 'experience').length, 0);
});

test('unregistered notes are never searched and registration path escapes reject', (t) => {

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memkeel-corpus-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'private.md'), 'not registered');
  const config = { vaultRoot: root, topics: [{ id: 'demo/a', workspace: 'demo' }] };
  const projection = { facts: [], conflicts: [] };
  assert.deepEqual(retrievalCorpus(config, [], projection, 'all', 'demo'), []);
  const registered = { ...config, knowledgeSearchNotes: [{ topic: 'demo/a', path: 'private.md' }] };
  fs.writeFileSync(path.join(root, 'private.md'), '---\nworkspace: other\n---\n# Material\nwrong project');
  assert.deepEqual(retrievalCorpus(registered, [], projection, 'all', 'demo'), []);
  fs.writeFileSync(path.join(root, 'private.md'), '---\nstatus: archived\n---\n# Material\nold note');
  assert.deepEqual(retrievalCorpus(registered, [], projection, 'all', 'demo'), []);
  assert.throws(() => retrievalCorpus({ ...config, knowledgeSearchNotes: [{ topic: 'demo/a', path: '../escape.md' }] }, [], projection, 'all', 'demo'));
});
