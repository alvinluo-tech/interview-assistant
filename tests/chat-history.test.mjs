import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateModuleFixture} from './compile-fixture.mjs';

const load = () => evaluateModuleFixture('src/lib/chatHistory.ts');

test('history is assembled whole turns from the newest backwards', () => {
  const { selectChatTurns } = load();
  const messages = [
    { role: 'user', content: '早'.repeat(400) },
    { role: 'assistant', content: '答'.repeat(400) },
    { role: 'user', content: '新问题' },
    { role: 'assistant', content: '新回答' },
  ];
  const result = selectChatTurns(messages, 1000);
  assert.equal(result.omitted, 0);
  assert.equal(result.recent.length, 4);
});

test('a budget overflow drops whole older turns and reports how much was left out', () => {
  const { selectChatTurns } = load();
  const messages = [
    { role: 'user', content: '旧'.repeat(3000) },
    { role: 'assistant', content: '旧答'.repeat(3000) },
    { role: 'user', content: '最近的问题' },
    { role: 'assistant', content: '最近的回答' },
  ];
  const result = selectChatTurns(messages, 800);
  assert.equal(result.omitted, 2);
  assert.ok(result.omittedChars > 6000);
  assert.deepEqual(JSON.parse(JSON.stringify(result.recent.map(message => message.content))), ['最近的问题', '最近的回答']);
});

test('the newest turn survives even when it alone exceeds the budget', () => {
  const { selectChatTurns } = load();
  const result = selectChatTurns([{ role: 'user', content: '长'.repeat(9000) }], 100);
  assert.equal(result.recent.length, 1);
  assert.equal(result.omitted, 0);
});

test('one oversized paste is clamped instead of rejected', () => {
  const { clampMessage, MAX_MESSAGE_CHARS } = load();
  const text = 'x'.repeat(MAX_MESSAGE_CHARS + 50);
  const clamped = clampMessage(text);
  assert.ok(clamped.length < text.length);
  assert.match(clamped, /已截断/);
  assert.equal(clampMessage('short'), 'short');
});
