/*
 * 把 Pyodide 的运行时文件同步到 public/pyodide，供 Python 执行 Worker 加载。
 * 与 sync-pdf-assets.mjs 同一模式：产物不进仓库，构建前从依赖里复制。
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pyodide/package.json'));
const destination = path.resolve('public/pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

mkdirSync(destination, { recursive: true });
for (const file of files) {
  const from = path.join(source, file);
  if (!existsSync(from)) {
    console.warn(`[pyodide] 缺少 ${file}，Python 执行器将不可用`);
    continue;
  }
  cpSync(from, path.join(destination, file));
}
