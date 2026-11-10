/*
 * JavaScript 执行器垫片的集成测试：用 QuickJS 真跑一遍大厂 ACM 的三种读入写法。
 * 垫片写错不会有类型错误，只会静默输出为空（判成「样例未通过」却没有任何报错），
 * 所以这里直接执行一遍，而不是断言字符串。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuickJS } from 'quickjs-emscripten';
import { evaluateModuleFixture } from './compile-fixture.mjs';

const { buildJsPrelude } = evaluateModuleFixture('src/lib/jsRunnerPrelude.ts', { exports: {} });
const STDIN = '3\n1 2 3';

/** 复刻 codeRunner 的执行顺序：前置垫片 → 用户代码 → 抽干微任务。 */
async function execute(code) {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  const context = runtime.newContext();
  let stdout = '';
  let stderr = '';
  const log = context.newFunction('__log', (...args) => { stdout += args.map((arg) => context.dump(arg)).join(' ') + '\n'; });
  const error = context.newFunction('__error', (...args) => { stderr += args.map((arg) => context.dump(arg)).join(' ') + '\n'; });
  context.setProp(context.global, '__log', log);
  context.setProp(context.global, '__error', error);
  log.dispose();
  error.dispose();
  try {
    const prelude = context.evalCode(buildJsPrelude(STDIN), 'prelude.js');
    if (prelude.error) { stderr += JSON.stringify(context.dump(prelude.error)); prelude.error.dispose(); } else prelude.value.dispose();
    const result = context.evalCode(code, 'solution.js');
    if (result.error) { stderr += JSON.stringify(context.dump(result.error)); result.error.dispose(); } else result.value.dispose();
    for (let round = 0; round < 1000 && runtime.hasPendingJob(); round += 1) runtime.executePendingJobs();
  } finally {
    context.dispose();
    runtime.dispose();
  }
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

test('readline listeners fire and readline({input: process.stdin}) does not crash', async () => {
  const { stdout, stderr } = await execute(`
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
rl.on('line', (line) => lines.push(line));
rl.on('close', () => {
  const n = Number(lines[0]);
  console.log(lines[1].split(' ').slice(0, n).map(Number).reduce((a, b) => a + b, 0));
});
`);
  assert.equal(stderr, '');
  assert.equal(stdout, '6');
});

test('process.stdin data/end listeners receive the sample input', async () => {
  const { stdout, stderr } = await execute(`
let buffer = '';
process.stdin.on('data', (chunk) => { buffer += chunk; });
process.stdin.on('end', () => console.log(buffer.replace(/\\n/g, '|')));
`);
  assert.equal(stderr, '');
  assert.equal(stdout, '3|1 2 3');
});

test('process.stdout.write and fs.readFileSync(0) both reach the runner', async () => {
  const viaWrite = await execute(`
const fs = require('fs');
const [n, ...rest] = fs.readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);
process.stdout.write(String(rest.slice(0, n).reduce((a, b) => a + b, 0)) + '\\n');
`);
  assert.equal(viaWrite.stdout, '6');
  assert.equal(viaWrite.stderr, '');
});
