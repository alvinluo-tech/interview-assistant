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

test('parses colon-less and compact ACM statements from Chinese job platforms', () => {
  const { parseSamples } = question();
  // 字节/美团题面：标记单独一行、不带冒号
  const bytedance = ['样例输入', '3', '1 2 3', '样例输出', '6'].join('\n');
  // 沙箱里的数组跨 realm，assert.deepEqual 会因原型不同失败，所以比字符串。
  const pairs = (text) => parseSamples(text).map((sample) => `${sample.input} => ${sample.output}`).join(' | ');
  assert.equal(pairs(bytedance), '3\n1 2 3 => 6');
  // 截图转写常见的紧凑写法：标题 + 标记 + 内容挤在同一行
  assert.equal(pairs('示例1：输入：5\n输出：3'), '5 => 3');
  assert.equal(pairs(['输入示例', '1 2', '输出示例', '3'].join('\n')), '1 2 => 3');
  // 不能把「样例输入说明」这种正文当成标记
  assert.equal(parseSamples('样例输入说明：本题没有样例。').length, 0);
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

test('an ACM statement wins over a class-shaped answer', () => {
  const { detectRunMode } = question();
  const statement = ['输入描述：第一行一个整数 n。', '输出描述：输出这 n 个数的和。'].join('\n');
  const classAnswer = 'class Solution:\n    def solve(self, nums):\n        return sum(nums)';
  // 只按代码特征判会得到 core，接着拿「参数表」去解析整段 stdin，必然判失败。
  assert.equal(detectRunMode(classAnswer, statement), 'acm');
  // 题面明说核心代码时仍然让给 core
  assert.equal(detectRunMode(classAnswer, '核心代码模式：实现 solve 函数，输入描述见函数签名。'), 'core');
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

test('expected output matching accepts LeetCode quoted string answers', () => {
  const { matchesExpected } = scaffold();
  // LeetCode 把字符串答案印成带引号的字面量，程序 stdout 不带引号
  assert.equal(matchesExpected('bab\n', '"bab"'), true);
  assert.equal(matchesExpected('bb\n', '"bb"'), true);
  assert.equal(matchesExpected('line1\nline2\n', '"line1\\nline2"'), true);
  assert.equal(matchesExpected('it\'s', "'it\\'s'"), true);
  // 值不同仍然不通过
  assert.equal(matchesExpected('aba', '"bab"'), false);
  assert.equal(matchesExpected('', '"bab"'), false);
  // 不是「整段一个字面量」时不做去引号
  assert.equal(matchesExpected('ab', '"a" + "b"'), false);
});

test('expected output matching normalizes booleans and decimal floats only', () => {
  const { matchesExpected } = scaffold();
  assert.equal(matchesExpected('True', 'true'), true);
  assert.equal(matchesExpected('false', 'False'), true);
  assert.equal(matchesExpected('3', '3.00000'), true);
  assert.equal(matchesExpected('2.9999999', '3.00000'), true);
  assert.equal(matchesExpected('3.5', '3.00000'), false);
  // 没有小数点的期望值按字符串严格比，避免把 007 当成 7
  assert.equal(matchesExpected('7', '007'), false);
  assert.equal(matchesExpected('1e3', '1000'), false);
  assert.equal(matchesExpected('1e3', '1.000e3'), true);
});
