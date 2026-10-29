import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, [
  '--test', '--experimental-test-coverage',
  '--test-coverage-include=**/artifacts/test-compiled/updatePresentation.cjs',
  '--test-coverage-lines=80', '--test-coverage-branches=80', '--test-coverage-functions=80',
  'tests/update-presentation.test.mjs', 'tests/installer-branding.test.mjs',
], { stdio: 'inherit' });
