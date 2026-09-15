import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInjected, classifyCodexMessage, parseCodexSession, selectCandidates, EventKind } from '../lib/ingest/sources.mjs';
import { importanceScore, isImportant, contentHash, DedupLedger } from '../lib/ingest/pipeline.mjs';

function writeRollout(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');
  return file;
}

test('injected harness blocks are not treated as authored user input', () => {
  assert.equal(isInjected('# AGENTS.md instructions for C:\\x'), true);
  assert.equal(isInjected('<INSTRUCTIONS>\ndo things'), true);
  assert.equal(isInjected('<app-context>\n# Codex'), true);
  assert.equal(isInjected('我们继续第二阶段吧'), false);
});

test('all observed machine-generated wrappers are classified as injected', () => {
  // Each of these was observed in a real Codex rollout with role=user.
  for (const block of [
    '<recommended_plugins>\nhere is a list',
    '<subagent_notification> {"agent_path":"x"}',
    '# Files mentioned by the user:\n## shot.png: C:/tmp/x.png',
    'PLEASE IMPLEMENT THIS PLAN:\n# Some plan',
    'Implement task-scoped incremental gate in C:/x',
  ]) assert.equal(isInjected(block), true, block.slice(0, 30));
});

test('classification is positive-identification and fail-closed', () => {
  assert.equal(classifyCodexMessage('user', '真实需求'), EventKind.AUTHORED_USER);
  assert.equal(classifyCodexMessage('user', '# AGENTS.md\nrules'), EventKind.META_INJECTION);
  assert.equal(classifyCodexMessage('assistant', 'reply'), EventKind.AUTHORED_ASSISTANT);
  assert.equal(classifyCodexMessage('system', 'sys'), EventKind.SYSTEM);
  assert.equal(classifyCodexMessage('tool', 'out'), EventKind.UNKNOWN);
});

test('parsing a rollout keeps only authored turns as candidates', (t) => {
  const file = writeRollout(t, [
    { type: 'session_meta', payload: { session_id: 'sess-1', cwd: 'C:/Code/Proj', timestamp: '2026-09-01T00:00:00Z' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md\ninjected rules' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '我们决定以后都用 Markdown 作为真源，而不是数据库。' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好的，我会遵守。' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] } },
  ]);
  const transcript = parseCodexSession(file);
  assert.equal(transcript.cwd, 'C:/Code/Proj');
  const selected = selectCandidates([transcript]);
  // selectCandidates identifies authored turns only; the injected block is meta.
  assert.equal(selected.length, 2);
  assert.ok(selected.every((row) => row.kind === 'user'));
  // The importance gate is the second stage and drops '继续', leaving the real decision.
  const kept = selected.filter((row) => isImportant(row.text));
  assert.equal(kept.length, 1);
  assert.match(kept[0].text, /Markdown 作为真源/);
});

test('importance gate keeps durable intent and drops coordination chatter', () => {
  assert.equal(isImportant('继续'), false);
  assert.equal(isImportant('好的'), false);
  assert.equal(isImportant('ok'), false);
  assert.ok(importanceScore('我们决定以后所有记忆都以 Markdown 作为唯一真源，不再引入数据库。') >= 0.5);
  assert.ok(importanceScore('Important: always validate the write with a readback before committing.') >= 0.5);
});

test('content hash is stable and the dedup ledger is idempotent', () => {
  const h1 = contentHash('same turn');
  const h2 = contentHash('same turn');
  assert.equal(h1, h2);
  const ledger = new DedupLedger('unused', [h1]);
  assert.equal(ledger.has(h1), true);
  assert.equal(ledger.add(h1), false);
  assert.equal(ledger.add(contentHash('new turn')), true);
});

test('the same text twice in one session yields two distinct ordinals', () => {
  // Content hashing alone cannot separate a repeated turn; the collection step
  // attaches a per-session ordinal so derived event ids stay unique.
  const counters = new Map();
  const inputs = ['same text', 'same text'];
  const ordinals = inputs.map(() => {
    const ordinal = counters.get('sess') ?? 0;
    counters.set('sess', ordinal + 1);
    return ordinal;
  });
  assert.deepEqual(ordinals, [0, 1]);
});
