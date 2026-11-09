/*
 * Python 执行 Worker（经典 Worker，不是 module worker）。
 *
 * 为什么必须是经典 Worker：Pyodide 的加载器在 worker 里靠 `importScripts()` 加载
 * `pyodide.asm.js`；module worker 没有 importScripts，Pyodide 会判定不出运行环境直接报错
 * （它没有 eval 兜底，我们也不想给应用开 unsafe-eval）。
 *
 * 所以这里用 UMD 版 `/pyodide/pyodide.js` + `importScripts`，全程只加载同源经典脚本，
 * 符合应用 CSP（script-src 'self' 'wasm-unsafe-eval'）。
 *
 * 沙箱边界：Pyodide 只有内存文件系统（MEMFS），WASM 本身没有 socket；
 * 加载完成后把 fetch / XMLHttpRequest / WebSocket / importScripts 全部清掉，
 * 避免用户代码借 Pyodide 的 pyfetch 出网。
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
  loadPyodide?: (options: { indexURL: string }) => Promise<PyodideApi>;
  importScripts?: (...urls: string[]) => void;
}

declare function importScripts(...urls: string[]): void;

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
    importScripts('/pyodide/pyodide.js');
    if (typeof scope.loadPyodide !== 'function') throw new Error('pyodide runtime missing');
    const pyodide = await scope.loadPyodide({ indexURL: '/pyodide/' });
    const globals = globalThis as unknown as Record<string, unknown>;
    globals.fetch = undefined;
    globals.XMLHttpRequest = undefined;
    globals.WebSocket = undefined;
    globals.importScripts = undefined;
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
