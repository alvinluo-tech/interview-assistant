import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function harness(initial = []) {
  const settings = { 'memory.facts': initial };
  const writes = [];
  const api = evaluateFixture('src/lib/memory.ts', {
    exports: {},
    console,
    require: name => {
      if (name === './store') return {
        getSetting: (key, fallback) => (key in settings ? JSON.parse(JSON.stringify(settings[key])) : fallback),
        setSetting: async (key, value) => { writes.push(JSON.parse(JSON.stringify(value))); settings[key] = JSON.parse(JSON.stringify(value)); },
      };
      throw Error(name);
    },
  });
  return { api, settings, writes };
}

test('facts can be added, edited and removed', async () => {
  const { api, settings } = harness();
  const added = await api.addMemory(['  三年后端，主要用 Go  ', '目标岗位是平台工程']);
  assert.equal(added.length, 2);
  assert.equal(added[0].text, '三年后端，主要用 Go');
  assert.equal(settings['memory.facts'].length, 2);

  const edited = await api.updateMemory(added[0].id, '四年后端，主要用 Go 和 PostgreSQL');
  assert.equal(edited[0].text, '四年后端，主要用 Go 和 PostgreSQL');

  const left = await api.deleteMemory(added[1].id);
  assert.equal(left.length, 1);
  assert.equal(settings['memory.facts'][0].text, '四年后端，主要用 Go 和 PostgreSQL');
});

test('the same sentence is stored once', async () => {
  const { api } = harness();
  await api.addMemory(['目标岗位是平台工程']);
  const again = await api.addMemory([' 目标岗位是平台工程 ', '目标岗位是平台工程']);
  assert.equal(again.length, 1);
});

test('editing to empty removes the entry', async () => {
  const { api } = harness();
  const [fact] = await api.addMemory(['临时记录']);
  assert.equal((await api.updateMemory(fact.id, '   ')).length, 0);
});

test('old facts are dropped once the list is full', async () => {
  const { api } = harness();
  const many = Array.from({ length: api.MEMORY_LIMITS.MAX_FACTS + 5 }, (_, i) => `事实 ${i}`);
  const stored = await api.addMemory(many);
  assert.equal(stored.length, api.MEMORY_LIMITS.MAX_FACTS);
  assert.equal(stored[0].text, '事实 5');
});

test('the block lists facts newest first and stays inside its budget', async () => {
  const { api } = harness();
  assert.equal(api.memoryBlock(), '');
  await api.addMemory(['短事实一', '短事实二']);
  const block = api.memoryBlock();
  assert.match(block, /^【用户长期记忆/);
  assert.ok(block.indexOf('短事实二') < block.indexOf('短事实一'), 'newest fact should come first');
  assert.ok(block.length < api.MEMORY_LIMITS.INJECT_BUDGET + 120);

  const long = Array.from({ length: 20 }, (_, i) => `第 ${i} 条很长的记忆条目`.repeat(8));
  const crowded = harness(long.map((text, i) => ({ id: `f${i}`, text, createdAt: i, updatedAt: i })));
  const trimmed = crowded.api.memoryBlock();
  assert.match(trimmed, /另有 \d+ 条较早记忆因长度限制未列出/);
  assert.ok(trimmed.length < api.MEMORY_LIMITS.INJECT_BUDGET + 400);
});

test('a restarted process reads the stored facts back', async () => {
  const { api } = harness();
  await api.addMemory(['目标岗位是平台工程']);
  api.resetMemory();
  assert.equal(api.listMemory()[0].text, '目标岗位是平台工程');
});

test('malformed stored data is ignored instead of crashing', () => {
  const { api } = harness([{ id: 'a', text: '正常' }, null, { id: 'b' }, { id: 'c', text: '   ' }]);
  assert.deepEqual(api.listMemory().map(fact => fact.text), ['正常']);
});
