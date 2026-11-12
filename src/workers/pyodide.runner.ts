/*
 * Python 执行 Worker（module worker）。
 *
 * Pyodide 314 的运行时是 ES module（`pyodide.asm.mjs`），官方明确不再支持经典 Worker
 * 的 `importScripts()`，所以这里用 `type: 'module'` 的 Worker + 动态 import 加载
 * `/pyodide/pyodide.mjs`。`/* @vite-ignore *​/` 是必须的：公网目录里的文件不经过 Vite
 * 的模块图，带上这个注释才不会被 dev server 改写成 `?import`。
 *
 * 沙箱边界：Pyodide 只有内存文件系统（MEMFS），WASM 本身没有 socket；
 * 加载完成后把 fetch / XMLHttpRequest / WebSocket 全部清掉，避免用户代码借 Pyodide 的
 * pyfetch 出网。
 */

interface RunRequest { id: number; code: string; stdin: string }
interface RunResponse { id: number; stdout: string; stderr: string; error?: string }

interface PyodideApi {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null;
  postMessage: (message: RunResponse) => void;
}

/** 与 codeRunner 保持一致：输出上限，避免死循环 print 撑爆 Worker 内存。 */
const MAX_OUTPUT_CHARS = 64 * 1024;

function appendOutput(current: string, text: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  return (current + text + '\n').slice(0, MAX_OUTPUT_CHARS);
}

const scope = self as unknown as WorkerScope;
let ready: Promise<PyodideApi> | null = null;

function boot(): Promise<PyodideApi> {
  if (ready) return ready;
  ready = (async () => {
    // 运行时拼出的绝对地址：既让 TypeScript 不做模块解析，也让 Vite 的 import-analysis
    // 无法把这个 URL 改写成 `?import`（public 目录的文件不是模块图的一部分）。
    const runtimeUrl: string = `${location.origin}/pyodide/pyodide.mjs`;
    const runtime = (await import(/* @vite-ignore */ runtimeUrl)) as {
      loadPyodide?: (options: { indexURL: string }) => Promise<PyodideApi>;
    };
    const load = runtime.loadPyodide;
    if (typeof load !== 'function') throw new Error('pyodide runtime missing');
    const pyodide = await load({ indexURL: '/pyodide/' });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.fetch = undefined;
    globals.XMLHttpRequest = undefined;
    globals.WebSocket = undefined;
    return pyodide;
  })();
  return ready;
}

scope.onmessage = async (event: MessageEvent<RunRequest>) => {
  const { id, code, stdin } = event.data;
  let stdout = '';
  let stderr = '';
  try {
    const pyodide = await boot();
    pyodide.setStdout({ batched: (text) => { stdout = appendOutput(stdout, text); } });
    pyodide.setStderr({ batched: (text) => { stderr = appendOutput(stderr, text); } });
    // 把 stdin 换成固定字符串：用户代码里的 input() / sys.stdin.read() 都读它。
    const payload = JSON.stringify(stdin);
    await pyodide.runPythonAsync(`
import io
import sys
sys.stdin = io.StringIO(${payload})
`);
    await pyodide.runPythonAsync(code);
    scope.postMessage({ id, stdout, stderr });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    scope.postMessage({ id, stdout, stderr: stderr || message, error: message });
  }
};
