/*
 * Python 执行 Worker：用 Pyodide（CPython → WASM）在 Web Worker 里跑用户代码。
 *
 * 为什么必须在 Worker 里：Pyodide 的 eval 是同步阻塞的，主线程跑会卡死界面；
 * 而 Pyodide 的「中断」依赖 SharedArrayBuffer（需要 COOP/COEP 响应头，Tauri 资源协议上很别扭），
 * 所以超时只能靠主线程 terminate() 这个 Worker，下次执行再重新初始化。
 *
 * 沙箱边界：Pyodide 只有内存文件系统（MEMFS），没有宿主 fs；WASM 本身没有 socket。
 * 这里额外把 fetch / XMLHttpRequest / WebSocket / importScripts 清掉，避免用户代码
 * 通过 Pyodide 的 pyfetch 走 JS 的 fetch 出去。
 */

interface RunRequest { id: number; code: string; stdin: string }
interface RunResponse { id: number; stdout: string; stderr: string; error?: string }

interface PyodideApi {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RunRequest>) => void) | null;
  postMessage: (message: RunResponse) => void;
};

let ready: Promise<PyodideApi> | null = null;

function boot(): Promise<PyodideApi> {
  if (ready) return ready;
  ready = (async () => {
    // 只允许同源加载 Pyodide 自身的资源；加载完成后立即封掉出网能力。
    const moduleUrl = '/pyodide/pyodide.mjs';
    const module = await import(/* @vite-ignore */ moduleUrl) as { loadPyodide: (options: { indexURL: string }) => Promise<PyodideApi> };
    const pyodide = await module.loadPyodide({ indexURL: '/pyodide/' });
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
    pyodide.setStdout({ batched: (text) => { stdout += text + '\n'; } });
    pyodide.setStderr({ batched: (text) => { stderr += text + '\n'; } });
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
