// Run against an isolated Vite server using OVERLAY_TEST_URL (default port 1438).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const url = process.env.OVERLAY_TEST_URL || 'http://127.0.0.1:1438/#overlay';
const port = 19398;
const profile = path.resolve('artifacts/overlay-ui-browser');
await mkdir(profile, { recursive: true });
const executable = process.env.UI_TEST_BROWSER || path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe');
const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, url], { windowsHide: true, stdio: 'ignore' });
browser.on('error', error => console.error(error.message));
const cdp = new DesktopCdp(port);
try {
  const deadline = Date.now() + 20000;
  while (!cdp.socket && Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find(p => p.url === url);
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
  await cdp.waitFor('!!window.__errors');
  await delay(1500);
  const backgrounds = await cdp.evaluate("[document.documentElement,document.body,document.getElementById('root')].map(el=>getComputedStyle(el).backgroundColor)");
  assert.deepEqual(backgrounds, ['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)'], 'All document layers must be transparent, otherwise opacity controls cannot reveal the desktop');
  await cdp.evaluate("document.documentElement.classList.add('dual-takeover')");
  assert.equal(await cdp.evaluate("getComputedStyle(document.getElementById('root')).opacity"), '0', 'Phone takeover must visually hide the computer overlay');
  await cdp.evaluate("document.documentElement.classList.remove('dual-takeover');document.documentElement.classList.add('ov-palette-capturing')");
  assert.equal(await cdp.evaluate("getComputedStyle(document.getElementById('root')).opacity"), '0', 'Palette capture must hide its own UI');
  await cdp.evaluate("document.documentElement.classList.remove('ov-palette-capturing')");
  assert.equal(await cdp.evaluate("getComputedStyle(document.getElementById('root')).opacity"), '1');
  assert.deepEqual(await cdp.evaluate('window.__errors'), []);
  await writeFile('artifacts/overlay-ui-results.json', JSON.stringify({ passed: true, backgrounds, takeoverHidden: true, paletteCaptureHidden: true }, null, 2));
  console.log('PASS: real overlay entry has transparent document layers; phone takeover and palette capture hide the UI.');
} finally {
  if (cdp.socket) { await cdp.command('Browser.close', {}).catch(() => {}); cdp.close(); }
  browser.kill();
}
