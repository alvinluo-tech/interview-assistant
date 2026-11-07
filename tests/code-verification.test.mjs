/*
 * 笔试题解析与可运行脚手架的单测：
 * 覆盖主流平台的题面格式（牛客/LeetCode 中文/华为机考/HackerRank）、
 * 两种评测模式（ACM / 核心代码）以及样例比对的边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateModuleFixture } from './compile-fixture.mjs';

const question = () => evaluateModuleFixture('src/lib/codeQuestion.ts', { exports: {} });
const scaffold = () => evaluateModuleFixture('src/lib/codeScaffold.ts', { exports: {} });

test('parses Nowcoder style samples (输入例子/输出例子)', () => {
  const { parseSamples } = question();
  const text = [
    '题目描述',
    '求两个数的和。',
    '输入描述:',
    '第一行一个整数 a，第二行一个整数 b。',
    '输出描述:',
    '输出一个整数。',
    '输入例子1:',
    '1',
    '2',
    '输出例子1:',
    '3',
  ].join('\n');
  const samples = parseSamples(text);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].input, '1\n2');
  assert.equal(samples[0].output, '3');
});

test('parses LeetCode Chinese samples (示例/输入：/输出：) and keeps argument lists', () => {
  const { parseSamples } = question();
  const text = [
    '示例 1：',
    '输入：nums = [2,7,11,15], target = 9',
    '输出：[0,1]',
    '解释：因为 nums[0] + nums[1] == 9。',
    '示例 2：',
    '输入：nums = [3,2,4], target = 6',
    '输出：[1,2]',
  ].join('\n');
  const samples = parseSamples(text);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].input, 'nums = [2,7,11,15], target = 9');
  assert.equal(samples[0].output, '[0,1]');
  assert.equal(samples[1].output, '[1,2]');
});

test('parses Huawei style (样例1 输入:/输出:) and English Sample Input/Output', () => {
  const { parseSamples } = question();
  const huawei = ['样例1', '输入:2', '输出:20'].join('\n');
  const english = ['Sample Input 0', '5', 'Sample Output 0', '10'].join('\n');
  assert.equal(question().parseSamples(huawei).map((s) => s.output).join('|'), '20');
  assert.equal(question().parseSamples(english).map((s) => s.output).join('|'), '10');
  assert.equal(parseSamples('没有样例的题目描述。').length, 0);
});

test('picks the longest tagged code block and normalizes language aliases', () => {
  const { extractCodeBlock, normalizeLanguage } = question();
  const answer = [
    '思路：先排序。',
    '```js',
    'const a = 1;',
    '```',
    '```python',
    'def solve():\n    return 1',
    '```',
  ].join('\n');
  const block = extractCodeBlock(answer);
  assert.equal(block.language, 'python');
  assert.match(block.code, /def solve/);
  assert.equal(normalizeLanguage('C++'), 'cpp');
  assert.equal(normalizeLanguage('node'), 'javascript');
  assert.equal(extractCodeBlock('没有代码'), null);
});

test('separates ACM mode from core-code mode', () => {
  const { detectRunMode, detectLanguage } = question();
  assert.equal(detectRunMode('import sys\nprint(int(sys.stdin.read()))'), 'acm');
  assert.equal(detectRunMode('class Solution:\n    def twoSum(self, nums, target):\n        return []'), 'core');
  assert.equal(detectRunMode('function solve(){}', '核心代码模式，实现 solve 函数'), 'core');
  assert.equal(detectLanguage({ language: '', code: '#include <iostream>\nint main(){}' }), 'cpp');
  assert.equal(detectLanguage({ language: '', code: 'public class Main { public static void main(String[] a){} }' }), 'java');
});

test('scaffold keeps ACM answers as-is and adds a driver for core-code Python', () => {
  const { buildScaffold } = scaffold();
  const acm = buildScaffold({
    language: 'python',
    code: 'import sys\nprint(sys.stdin.read().strip())',
    mode: 'acm',
    samples: [{ input: '1 2', output: '1 2' }],
  });
  assert.equal(acm.runnable, true);
  assert.match(acm.content, /Sample 1 input:/);

  const core = buildScaffold({
    language: 'python',
    code: 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]',
    mode: 'core',
    samples: [{ input: 'nums = [2,7], target = 9', output: '[0,1]' }],
  });
  assert.equal(core.runnable, true);
  assert.match(core.content, /__mianxu_main/);
  assert.match(core.content, /Solution\(\)\.twoSum/);

  const java = buildScaffold({
    language: 'java',
    code: 'class Solution { int f(int x) { return x; } }',
    mode: 'core',
    samples: [{ input: '1', output: '1' }],
  });
  assert.equal(java.runnable, false);
  assert.equal(java.note, 'no-driver-for-language');
});

test('expected output matching tolerates JSON spacing but not different values', () => {
  const { matchesExpected } = scaffold();
  assert.equal(matchesExpected('[0,1]\n', '[0, 1]'), true);
  assert.equal(matchesExpected('3\n', '3'), true);
  assert.equal(matchesExpected('[0,2]', '[0,1]'), false);
  assert.equal(matchesExpected('abc', 'abd'), false);
});
