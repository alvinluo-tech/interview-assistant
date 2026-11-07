/*
 * 代码执行器：把「模型生成的答案 + 题面样例」真的跑一遍，给出 passed / failed / unverified。
 *
 * 设计取舍：
 * - JavaScript 用 QuickJS（WASM 解释器）在主线程跑，带内存上限与中断回调：
 *   不用 new Function / eval（应用 CSP 没有 unsafe-eval），用户代码也碰不到宿主全局。
 * - Python 用 Pyodide（CPython→WASM）在 Worker 里跑：Pyodide 的 eval 是同步阻塞的，
 *   超时只能 terminate Worker，所以每次超时就丢弃实例、下次重新初始化。
 * - 跑不了的语言（Java/C/C++/Go）一律返回 unverified，由调用方给出「复制可运行代码」的兜底。
 *
 * 判定口径：只有「题面明确给了样例输出」且「所有样例都通过」才算 passed；
 * 没有样例、执行器不可用、超时、崩溃都归为 unverified 或 failed，不猜。
 */
import { getQuickJS } from 'quickjs-emscripten';
import { normalizeOutput, type CodeSample } from './codeQuestion';
import { matchesExpected } from './codeScaffold';

export type Verdict = 'passed' | 'failed' | 'unverified';

export interface SampleOutcome {
  index: number;
  ok: boolean;
  expected: string;
  actual: string;
  timedOut: boolean;
  error?: string;
}

export interface CodeVerdict {
  verdict: Verdict;
  runner: 'javascript' | 'python' | '';
  passed: number;
  total: number;
  outcomes: SampleOutcome[];
  note?: 'no-samples' | 'unsupported' | 'timeout' | 'error';
}

const MAX_SAMPLES = 5;
const JS_TIMEOUT_MS = 5000;
const PY_TIMEOUT_MS = 12000;

/** 只保留有期望输出的样例：没有期望输出只能跑通，不能判定。 */
export function judgedSamples(samples: CodeSample[]): CodeSample[] {
  return samples.filter((sample) => sample.output.trim()).slice(0, MAX_SAMPLES);
}

// ---------------- JavaScript：QuickJS ----------------

const READLINE_SHIM = `
globalThis.require = function (name) {
  if (name === 'fs') {
    return { readFileSync: function () { return __stdin; } };
  }
  if (name === 'readline') {
    return {
      createInterface: function () {
        var lineHandlers = [];
        var closeHandlers = [];
        var api = {
          on: function (event, handler) {
            if (event === 'line') lineHandlers.push(handler);
            if (event === 'close') closeHandlers.push(handler);
            return api;
          },
          close: function () {},
          question: function (_q, cb) { cb(__stdin); },
        };
        Promise.resolve().then(function () {
          __stdin.split('\\n').forEach(function (line) { lineHandlers.forEach(function (fn) { fn(line); }); });
          closeHandlers.forEach(function (fn) { fn(); });
        });
        return api;
      },
    };
  }
  throw new Error("require('" + name + "') is not available in the local runner");
};
`;

async function runJavaScript(code: string, stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) { timedOut = true; return true; }
    return false;
  });
  const context = runtime.newContext();
  let stdout = '';
  let stderr = '';
  try {
    const log = context.newFunction('__log', (...args) => {
      stdout += args.map((arg) => context.dump(arg)).map(formatValue).join(' ') + '\n';
    });
    const error = context.newFunction('__error', (...args) => {
      stderr += args.map((arg) => context.dump(arg)).map(formatValue).join(' ') + '\n';
    });
    context.setProp(context.global, '__log', log);
    context.setProp(context.global, '__error', error);
    log.dispose();
    error.dispose();
    const prelude = `
      const __stdin = ${JSON.stringify(stdin)};
      globalThis.console = {
        log: (...a) => __log(...a), info: (...a) => __log(...a), debug: (...a) => __log(...a),
        warn: (...a) => __error(...a), error: (...a) => __error(...a),
      };
      globalThis.print = (...a) => __log(...a);
      ${READLINE_SHIM}
    `;
    const preludeResult = context.evalCode(prelude, 'prelude.js');
    if (preludeResult.error) {
      const dumped = context.dump(preludeResult.error);
      preludeResult.error.dispose();
      throw new Error(`runner prelude failed: ${formatValue(dumped)}`);
    }
    preludeResult.value.dispose();
    const result = context.evalCode(code, 'solution.js');
    if (result.error) {
      const dumped = context.dump(result.error);
      result.error.dispose();
      stderr += formatValue(dumped) + '\n';
    } else {
      result.value.dispose();
    }
  } catch (caught) {
    stderr += (caught instanceof Error ? caught.message : String(caught)) + '\n';
  } finally {
    context.dispose();
    runtime.dispose();
  }
  return { stdout, stderr, timedOut };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------- Python：Pyodide Worker ----------------

interface Pending { resolve: (value: { stdout: string; stderr: string; timedOut: boolean }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

let pyWorker: Worker | null = null;
let pySeq = 0;
const pyPending = new Map<number, Pending>();

function disposePython() {
  pyWorker?.terminate();
  pyWorker = null;
  for (const [, pending] of pyPending) {
    clearTimeout(pending.timer);
    pending.reject(new Error('runner restarted'));
  }
  pyPending.clear();
}

function pythonWorker(): Worker {
  if (pyWorker) return pyWorker;
  const worker = new Worker(new URL('../workers/pyodide.runner.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<{ id: number; stdout: string; stderr: string }>) => {
    const pending = pyPending.get(event.data.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pyPending.delete(event.data.id);
    pending.resolve({ stdout: event.data.stdout, stderr: event.data.stderr, timedOut: false });
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'python runner error');
    for (const [, pending] of pyPending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pyPending.clear();
    disposePython();
  };
  pyWorker = worker;
  return worker;
}

function runPython(code: string, stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; timedOut: boolean }> {
  const worker = pythonWorker();
  const id = ++pySeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pyPending.delete(id);
      // 超时无法中断 Pyodide 的同步 eval，只能丢弃实例；下次执行重新初始化。
      disposePython();
      reject(new Error('timeout'));
    }, timeoutMs);
    pyPending.set(id, { resolve, reject, timer });
    worker.postMessage({ id, code, stdin });
  });
}

// ---------------- 统一入口 ----------------

export async function verifyCode(options: {
  language: string;
  code: string;
  samples: CodeSample[];
  timeoutMs?: number;
}): Promise<CodeVerdict> {
  const samples = judgedSamples(options.samples);
  const language = options.language;
  if (!samples.length) {
    return { verdict: 'unverified', runner: '', passed: 0, total: 0, outcomes: [], note: 'no-samples' };
  }
  if (language !== 'javascript' && language !== 'python') {
    return { verdict: 'unverified', runner: '', passed: 0, total: samples.length, outcomes: [], note: 'unsupported' };
  }
  const timeoutMs = options.timeoutMs ?? (language === 'python' ? PY_TIMEOUT_MS : JS_TIMEOUT_MS);
  const outcomes: SampleOutcome[] = [];
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    try {
      const result = language === 'python'
        ? await runPython(options.code, sample.input, timeoutMs)
        : await runJavaScript(options.code, sample.input, timeoutMs);
      const actual = result.stdout;
      outcomes.push({
        index,
        ok: !result.timedOut && matchesExpected(actual, sample.output),
        expected: normalizeOutput(sample.output),
        actual: normalizeOutput(actual),
        timedOut: result.timedOut,
        error: result.stderr.trim() ? result.stderr.trim().slice(0, 800) : undefined,
      });
      if (result.timedOut) break;
    } catch (error) {
      const message = String((error as Error)?.message ?? error);
      const timedOut = /timeout/i.test(message);
      outcomes.push({
        index,
        ok: false,
        expected: normalizeOutput(sample.output),
        actual: '',
        timedOut,
        error: message.slice(0, 800),
      });
      // 超时是「代码本身有问题」，但执行器启动/通信失败不是：那种情况不能判用户代码错。
      if (!timedOut) {
        return { verdict: 'unverified', runner: language as 'javascript' | 'python', passed: 0, total: samples.length, outcomes, note: 'error' };
      }
      break;
    }
  }
  const passed = outcomes.filter((outcome) => outcome.ok).length;
  const runner = language as 'javascript' | 'python';
  if (passed === samples.length) return { verdict: 'passed', runner, passed, total: samples.length, outcomes };
  return { verdict: 'failed', runner, passed, total: samples.length, outcomes };
}

/** 执行器是否可用（用于 UI 提前说明，不触发加载）。 */
export function runnerSupports(language: string): boolean {
  return language === 'javascript' || language === 'python';
}
