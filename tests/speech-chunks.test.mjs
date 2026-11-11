import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
const {takeSentences}=evaluateFixture('src/lib/speechChunks.ts',{exports:{}});
test('a streamed answer is split at sentence ends',()=>{
  const first=takeSentences('第一句。第二');
  assert.deepEqual([...first.ready],['第一句。']);
  assert.equal(first.rest,'第二');
  const second=takeSentences(first.rest+'句！第三');
  assert.deepEqual([...second.ready],['第二句！']);
  assert.equal(second.rest,'第三');
});
test('code fences are never read aloud',()=>{
  const {ready,rest}=takeSentences('看这段。\n```python\nprint(1)\n```\n结束。');
  assert.deepEqual([...ready],['看这段。','结束。']);
  assert.equal(rest,'');
});
test('a long paragraph is cut at a comma so audio starts sooner',()=>{
  const long='这是一个很长的句子，'.repeat(20);
  const {ready}=takeSentences(long+'完。');
  assert.ok(ready.length>1);
  assert.ok(ready.every(part=>part.length<=160));
});
