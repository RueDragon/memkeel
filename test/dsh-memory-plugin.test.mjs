import test from 'node:test';
import assert from 'node:assert/strict';
import { assistantReplyOf, promptOf } from '../dsh-memory-plugin.mjs';

const text = (value) => ({ type: 'text', text: value });

test('promptOf ignores assistant messages and plugin-injected user context', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [text('真实问题')] },
    { role: 'user', source: { kind: 'plugin', plugin: 'agent-memory-hooks' }, content: [text('记忆插件反馈')] },
    { role: 'assistant', content: [text('旧回复')] },
  ];
  assert.equal(promptOf(messages), '真实问题');
});

test('promptOf uses the latest real user message only', () => {
  const messages = [
    { role: 'user', source: { kind: 'user' }, content: [text('上一轮')] },
    { role: 'assistant', content: [text('上一轮回复')] },
    { role: 'user', source: { kind: 'user' }, content: [text('当前轮')] },
  ];
  assert.equal(promptOf(messages), '当前轮');
});

test('assistantReplyOf uses the latest assistant message', () => {
  const messages = [
    { role: 'assistant', content: [text('旧回复')] },
    { role: 'user', source: { kind: 'user' }, content: [text('当前问题')] },
    { role: 'assistant', content: [text('当前回复'), { type: 'tool-call', name: 'x' }] },
  ];
  assert.equal(assistantReplyOf(messages), '当前回复');
});
