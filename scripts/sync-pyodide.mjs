/*
 * 把 Pyodide 的运行时文件同步到 public/pyodide，供 Python 执行 Worker 加载。
 * 与 sync-pdf-assets.mjs 同一模式：产物不进仓库，构建前从依赖里复制。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pyodide/package.json'));
const destination = path.resolve('public/pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

// 缺文件时不能让构建通过：运行时才在 Worker 里 404，用户看到的是"Python 执行器直接不可用"。
const missing = files.filter((file) => !existsSync(path.join(source, file)));
if (missing.length > 0) {
  console.error(`[pyodide] 依赖里缺少 ${missing.join('、')}：Python 执行器无法运行，请重新安装依赖后再构建。`);
  process.exit(1);
}
// 先清空目标目录，避免旧版本残留文件被一起打进安装包。
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const file of files) {
  cpSync(path.join(source, file), path.join(destination, file));
}
