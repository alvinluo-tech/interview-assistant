import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateModuleFixture} from './compile-fixture.mjs';

const {parseExamConstraints, describeConstraints, constraintBrief} = evaluateModuleFixture('src/lib/examConstraints.ts');

test('parses the time and memory limits printed on Chinese judge pages', () => {
  const text = '首尾门牌（25分）\n时间限制：2 秒\n空间限制：262MB\n限定语言：C(clang11)\n数据范围：n ≤ 1e5，每个数 ≤ 1e9';
  const parsed = parseExamConstraints(text);
  assert.equal(parsed.timeMs, 2000);
  assert.equal(parsed.memoryMb, 262);
  assert.equal(parsed.scale, 'n ≤ 1e5，每个数 ≤ 1e9');
  assert.equal(describeConstraints(parsed), '时间限制 2 秒，空间限制 262MB，规模 n ≤ 1e5，每个数 ≤ 1e9');
});

test('handles milliseconds, seconds and gigabytes without guessing', () => {
  assert.equal(parseExamConstraints('时间限制: 1500ms').timeMs, 1500);
  assert.equal(parseExamConstraints('时间限制 1.5 秒').timeMs, 1500);
  assert.equal(parseExamConstraints('内存限制：1GB').memoryMb, 1024);
  assert.equal(JSON.stringify(parseExamConstraints('随便一段说明')), '{}');
  assert.equal(JSON.stringify(parseExamConstraints(undefined)), '{}');
});

test('falls back to a bound written inside the statement', () => {
  const parsed = parseExamConstraints('给定数组，1 <= nums.length <= 100000，请返回和。');
  assert.equal(parsed.timeMs, undefined);
  assert.match(parsed.scale ?? '', /nums\.length/);
});

test('the brief states the limits and demands a complexity self check', () => {
  const brief = constraintBrief({timeMs: 2000, memoryMb: 262});
  assert.match(brief, /时间限制 2 秒/);
  assert.match(brief, /空间限制 262MB/);
  assert.match(brief, /复杂度：时间 O/);
  const loose = constraintBrief({});
  assert.match(loose, /没有写明时间\/空间限制/);
  assert.match(loose, /1e5/);
});
