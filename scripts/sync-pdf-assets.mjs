import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = path.resolve('public/pdfjs', folder);
  // 先清空再复制：pdfjs 升级后删掉的文件不该继续留在安装包里。
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(source, folder), destination, { recursive: true });
}
