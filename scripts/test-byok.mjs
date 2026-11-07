import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// 用 bundler 解析编译协议夹具：源码里的相对导入沿用 Vite 习惯不带扩展名，
// NodeNext 会直接报 TS2835 让整条检查失败。编译后把相对导入补成 .js，Node 才能按 ESM 运行。
execFileSync(process.execPath, [
  'node_modules/typescript/bin/tsc', 'src/lib/aiConfig.ts', 'src/lib/aiProtocol.ts', 'src/lib/speechProtocol.ts',
  '--outDir', 'artifacts/byok-tests', '--rootDir', 'src/lib', '--target', 'ES2022',
  '--module', 'ESNext', '--moduleResolution', 'Bundler', '--lib', 'ES2022,DOM',
  '--strict', '--skipLibCheck', '--ignoreConfig',
], { stdio: 'inherit' });

const outDir = path.join('artifacts', 'byok-tests');
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.js')) continue;
  const file = path.join(outDir, name);
  const source = readFileSync(file, 'utf8');
  const patched = source.replace(/(from\s+['"])(\.\.?\/[^'"]+)(['"])/g, (match, prefix, specifier, suffix) =>
    /\.[a-z0-9]+$/i.test(specifier) ? match : `${prefix}${specifier}.js${suffix}`);
  if (patched !== source) writeFileSync(file, patched);
}

execFileSync(process.execPath, ['--test', 'tests/byok.test.mjs', 'tests/speech-protocol.test.mjs'], { stdio: 'inherit' });
