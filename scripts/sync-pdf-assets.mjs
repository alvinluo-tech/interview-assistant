import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const source = path.dirname(require.resolve('pdfjs-dist/package.json'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = path.resolve('public/pdfjs', folder);
  mkdirSync(destination, { recursive: true });
  cpSync(path.join(source, folder), destination, { recursive: true });
}
