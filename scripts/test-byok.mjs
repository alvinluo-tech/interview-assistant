import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, [
  'node_modules/typescript/bin/tsc', 'src/lib/aiConfig.ts', 'src/lib/aiProtocol.ts', 'src/lib/speechProtocol.ts',
  '--outDir', 'artifacts/byok-tests', '--rootDir', 'src/lib', '--target', 'ES2022',
  '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM',
  '--strict', '--skipLibCheck', '--ignoreConfig',
], { stdio: 'inherit' });
execFileSync(process.execPath, ['--test', 'tests/byok.test.mjs', 'tests/speech-protocol.test.mjs'], { stdio: 'inherit' });
