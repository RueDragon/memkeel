// Covers the real-transcript resolver: per-host file lookup, the plaintext JSONL
// parsers, and the graceful "unavailable" paths. The host directories live under the
// user home, so this test points HOME-derived lookup at fixtures via env override.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// transcripts.mjs binds HOME at import time, so set USERPROFILE before importing.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-home-'));
after(() => fs.rmSync(home, { recursive: true, force: true }));
process.env.USERPROFILE = home;
process.env.HOME = home;

const { loadTranscript } = await import('../lib/transcripts.mjs');

function write(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
}

test('codex: locates rollout by session id and parses user/assistant turns', () => {
  const id = '01a0a2f2-4f8d-7281-90c9-f31c89e974a4';
  const file = path.join(home, '.codex', 'sessions', '2026', '09', '15', `rollout-2026-09-15T10-43-04-${id}.jsonl`);
  write(file, [
    { type: 'session_meta', payload: {} },
    { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] } },
    { type: 'response_item', timestamp: 't2', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '## 标题\n正文' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'x' } },
  ]);
  const result = loadTranscript({ host: 'codex', sessionId: id, transcriptPath: '', cwd: home });
  assert.equal(result.available, true);
  assert.equal(result.turns.length, 2);
  assert.deepEqual(result.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(result.turns[1].text, '## 标题\n正文');
});

test('claude: reads message.role and nested message.content', () => {
  const id = '97936f55-863f-459c-abb7-a5cbab6a6669';
  const slug = 'C--Users-demo-Code-sample';
  const file = path.join(home, '.claude', 'projects', slug, `${id}.jsonl`);
  write(file, [
    { type: 'user', message: { role: 'user', content: '提问' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
  ]);
  const result = loadTranscript({ host: 'claude', sessionId: id, transcriptPath: '', cwd: 'C:/Users/demo/Code/sample' });
  assert.equal(result.available, true);
  assert.deepEqual(result.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(result.turns[1].text, '回答');
});

test('codex: missing session id degrades to an explicit reason, not a throw', () => {
  const result = loadTranscript({ host: 'codex', sessionId: 'does-not-exist', transcriptPath: '', cwd: home });
  assert.equal(result.available, false);
  assert.match(result.reason, /未找到/);
  assert.deepEqual(result.turns, []);
});

test('unknown host reports a reason instead of throwing', () => {
  const result = loadTranscript({ host: '', sessionId: 'x', transcriptPath: '', cwd: home });
  assert.equal(result.available, false);
  assert.match(result.reason, /未知宿主/);
});

test('zcode: resolves rollout model-io file (not agents subagent dir) and parses request/response', () => {
  const id = '43dc2e15-0a5d-43aa-b599-cd11319bd544';
  const file = path.join(home, '.zcode', 'cli', 'rollout', `model-io-sess_${id}.jsonl`);
  write(file, [
    {
      type: 'model_io',
      sessionId: `sess_${id}`,
      startedAt: '2026-09-14T06:31:10.357Z',
      request: {
        messagesKind: 'full',
        messages: [
          { role: 'system', content: 'system prompt' },
          { role: 'user', content: '<system-reminder>\nskills available' },
          { role: 'user', content: '真正的问题' },
        ],
      },
      response: { text: '## 回答\n正文' },
    },
  ]);
  const result = loadTranscript({ host: 'zcode', sessionId: `sess_${id}`, transcriptPath: '', cwd: home });
  assert.equal(result.available, true);
  assert.match(result.source, /rollout/);
  assert.deepEqual(result.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(result.turns[0].text, '真正的问题');
  assert.equal(result.turns[1].text, '## 回答\n正文');
});

test('zcode: without a rollout file falls back to the largest subagent transcript', () => {
  const id = 'aaaaaaaa-1111-2222-3333-444444444444';
  const small = path.join(home, '.zcode', 'cli', 'agents', `sess_${id}`, 'agent_small', 'transcript.jsonl');
  const big = path.join(home, '.zcode', 'cli', 'agents', `sess_${id}`, 'agent_big', 'transcript.jsonl');
  write(small, [
    { type: 'model_request', payload: { messages: [{ role: 'user', content: '小问题' }] } },
  ]);
  write(big, [
    { type: 'model_request', payload: { messages: [{ role: 'user', content: '大问题' }] } },
    { type: 'model_complete', payload: { content: '大回答' } },
  ]);
  const result = loadTranscript({ host: 'zcode', sessionId: `sess_${id}`, transcriptPath: '', cwd: home });
  assert.equal(result.available, true);
  assert.match(result.source, /agent_big/);
  assert.deepEqual(result.turns.map((t) => t.text), ['大问题', '大回答']);
});

test('dsh: injected hook/skill/runtime user records are hidden from the transcript', () => {
  const id = '55555555-6666-7777-8888-999999999999';
  const dir = path.join(home, '.dsh', 'sessions', 'ws', `session-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  const lines = [
    { type: 'user/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: '真实提问' }] } } },
    { type: 'user/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: '<system-reminder>\ncontext' }] } } },
    { type: 'user/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: 'Current runtime context. snapshot' }] } } },
    { type: 'user/message', seq: 4, time: 4, data: { message: { content: [{ type: 'text', text: '已进行多步搜索。找到真实路径后请立即 capture' }] } } },
    { type: 'assistant/message', seq: 5, time: 5, data: { message: { content: [{ type: 'text', text: '回答' }] } } },
  ];
  const py = [
    'import sys, zstandard as zstd',
    'raw = open(sys.argv[1], "rb").read()',
    'open(sys.argv[2], "wb").write(zstd.ZstdCompressor().compress(raw))',
  ].join('\n');
  const src = path.join(dir, 'plain.jsonl');
  fs.writeFileSync(src, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  const spawned = spawnSync('python', ['-c', py, src, file], { encoding: 'utf8' });
  if (spawned.status !== 0) return; // zstandard unavailable: skip quietly
  fs.rmSync(src, { force: true });
  const result = loadTranscript({ host: 'dsh', sessionId: `session-${id}`, transcriptPath: '', cwd: home });
  assert.equal(result.available, true);
  assert.deepEqual(result.turns.map((t) => t.role), ['user', 'assistant']);
  assert.equal(result.turns[0].text, '真实提问');
  assert.equal(result.turns[1].text, '回答');
});

test('explicit transcriptPath wins over directory search', () => {
  const file = path.join(home, 'custom', 'anything.jsonl');
  write(file, [
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '直连路径' }] } },
  ]);
  const result = loadTranscript({ host: 'codex', sessionId: 'unused', transcriptPath: file, cwd: home });
  assert.equal(result.available, true);
  assert.equal(result.turns.length, 1);
  assert.equal(result.turns[0].text, '直连路径');
});
