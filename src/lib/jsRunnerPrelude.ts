/*
 * JavaScript 本地执行器的前置垫片：在用户代码之前注入 console / print / require / process。
 *
 * 大厂 ACM 的 JS 题解有三种主流读入写法，垫片必须让三种都能跑：
 * 1. require('readline').createInterface({ input: process.stdin })
 * 2. require('fs').readFileSync(0, 'utf8')
 * 3. process.stdin.on('data' | 'end')
 * 第 1、3 种都引用 process，缺失时直接 ReferenceError；这里给出只读的最小实现，
 * 真正的输入内容由 readline 与 fs 垫片提供（process.stdin 只用来接住调用，不重复喂数据）。
 *
 * 单独成文件是为了能在测试里用 QuickJS 真跑一遍：垫片写错了不会有类型错误，
 * 只会静默输出为空，必须靠执行才能真正验证。
 */

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

const PROCESS_SHIM = `
var __stdinData = [];
var __stdinEnd = [];
var __stdinScheduled = false;
function __scheduleStdin() {
  if (__stdinScheduled) return;
  __stdinScheduled = true;
  // The runner drains the microtask queue after user code finishes, so by the
  // time this fires every data/end listener has been registered.
  Promise.resolve().then(function () {
    __stdinData.forEach(function (fn) { fn(__stdin); });
    __stdinEnd.forEach(function (fn) { fn(); });
  });
}
globalThis.process = {
  stdin: {
    on: function (event, handler) {
      if (event === 'data' && handler) __stdinData.push(handler);
      if (event === 'end' && handler) __stdinEnd.push(handler);
      __scheduleStdin();
      return this;
    },
    once: function (event, handler) { return this.on(event, handler); },
    resume: function () { return this; },
    pause: function () { return this; },
    setEncoding: function () { return this; },
    read: function () { return null; },
    isTTY: false,
  },
  stdout: { write: function (chunk) { __log(String(chunk).replace(/\\n$/, '')); return true; } },
  stderr: { write: function (chunk) { __error(String(chunk).replace(/\\n$/, '')); } },
  argv: ['node', 'solution.js'],
  env: {},
  exit: function (code) { throw new Error('process.exit(' + (code === undefined ? 0 : code) + ')'); },
};
`;

/** 生成完整的执行前置代码；stdin 会被读取它的垫片按需返回。 */
export function buildJsPrelude(stdin: string): string {
  return `
      const __stdin = ${JSON.stringify(stdin)};
      globalThis.console = {
        log: (...a) => __log(...a), info: (...a) => __log(...a), debug: (...a) => __log(...a),
        warn: (...a) => __error(...a), error: (...a) => __error(...a),
      };
      globalThis.print = (...a) => __log(...a);
      ${PROCESS_SHIM}
      ${READLINE_SHIM}
    `;
}
