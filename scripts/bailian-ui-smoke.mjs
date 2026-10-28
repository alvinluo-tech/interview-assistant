// Run against Vite on 1432 with MIANSHI_UI_SMOKE=1 for an isolated dependency cache.
// Uses a fresh headless browser profile and synthetic credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const url = 'http://127.0.0.1:1432/tests/fixtures/bailian-ui.html';
const port = 19396;
const profile = path.resolve('artifacts/bailian-ui-browser');
await mkdir(profile, { recursive: true });
const browser = spawn(process.env.BAILIAN_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ['--headless=new', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, url],
  { windowsHide: true, stdio: 'ignore' });
const cdp = new DesktopCdp(port);
try {
  const deadline = Date.now() + 20000;
  while (!cdp.socket && Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(page => page.url === url);
      if (page?.webSocketDebuggerUrl) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
        cdp.socket = socket;
        socket.onmessage = event => {
          const message = JSON.parse(event.data), task = cdp.pending.get(message.id);
          if (!task) return;
          clearTimeout(task.timer); cdp.pending.delete(message.id);
          message.error ? task.reject(new Error(JSON.stringify(message.error))) : task.resolve(message.result);
        };
      }
    } catch { /* Browser startup. */ }
    if (!cdp.socket) await delay(100);
  }
  assert.ok(cdp.socket, 'Headless browser started');
  await cdp.waitFor("!!document.querySelector('[data-testid=ai-services]')");
  await cdp.click('连接并获取模型');
  await cdp.waitFor("document.body.innerText.includes('已从接口获取 2 个模型')");
  assert.equal(await cdp.evaluate('window.__bailianUiTest.requests.length'), 2);
  assert.ok(await cdp.evaluate("document.body.innerText.includes('fun-asr-realtime')"));
  const providerId = await cdp.evaluate('window.__bailianUiTest.getAiSettings().providers[0].id');
  await cdp.select('#ai-route-stt', JSON.stringify({ providerId, modelId: 'fun-asr-realtime' }));
  await cdp.evaluate("document.querySelector('details').open = true");
  await cdp.select('#ai-speech-mode', 'realtime');
  const selector = '[aria-label="实时 ASR WSS 地址"]';
  assert.deepEqual(await cdp.evaluate(`({value:document.querySelector('${selector}').value, placeholder:document.querySelector('${selector}').placeholder})`),
    { value: '', placeholder: 'wss://ws-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference' });
  await cdp.click('保存配置');
  await cdp.waitFor("document.body.innerText.includes('配置已同步')");
  assert.equal(await cdp.evaluate('window.__bailianUiTest.getAiSettings().routes.stt.modelId'), 'fun-asr-realtime');
  await cdp.input(selector, 'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  await cdp.click('保存配置');
  await cdp.waitFor("document.body.innerText.includes('地域不一致')");
  assert.equal(await cdp.evaluate('window.__bailianUiTest.getAiSettings().realtimeEndpoint'), undefined);
  await cdp.input(selector, '');
  await cdp.waitFor("document.body.innerText.includes('配置已同步')");
  assert.equal(await cdp.evaluate('window.__bailianUiTest.getAiSettings().realtimeEndpoint'), undefined);
  const shot = await cdp.command('Page.captureScreenshot', { format: 'png' });
  await writeFile('artifacts/bailian-ui.png', Buffer.from(shot.data, 'base64'));
  await writeFile('artifacts/bailian-ui-results.json', JSON.stringify({ passed: true,
    checks: ['existing Singapore connection', 'paginated audio model discovery', 'STT assignment', 'automatic WSS endpoint', 'save configuration', 'region mismatch rejected', 'clear override restores saved configuration'] }, null, 2));
  console.log('PASS 7 Bailian UI checks (synthetic catalog, no external requests)');
} finally {
  if (cdp.socket) { await cdp.command('Browser.close', {}).catch(() => {}); cdp.close(); }
  browser.kill();
}
