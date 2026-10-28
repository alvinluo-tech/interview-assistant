import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

async function withMock(args, run) {
  const child = spawn(process.execPath, ['tests/fixtures/mock-ai.mjs', '0', ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const port = await new Promise((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('Mock service did not start')), 5000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/127\.0\.0\.1:(\d+)\/v1/);
        if (match) { clearTimeout(timer); resolve(Number(match[1])); }
      });
    });
    await run(`http://127.0.0.1:${port}`);
  } finally { child.kill(); }
}

test('mock service identifies itself and refuses fixed transcripts by default', async () => {
  await withMock([], async url => {
    const status = await fetch(`${url}/__mianshi_test__/status`);
    assert.equal(status.headers.get('x-mianshi-test-service'), 'mock-ai');
    assert.equal((await status.json()).realTranscription, false);
    const response = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: 'silent input' });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).text, undefined);
  });
});
test('explicitly enabled developer fixtures still carry a detectable test marker', async () => {
  await withMock(['--allow-fixtures'], async url => {
    const response = await fetch(`${url}/v1/audio/transcriptions`, { method: 'POST', body: 'fixture input' });
    assert.equal(response.headers.get('x-mianshi-test-service'), 'mock-ai');
    assert.equal(response.status, 200);
  });
});
