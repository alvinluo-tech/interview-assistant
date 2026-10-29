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
  // Exercise the actual embedded phone page with a synthetic socket; no LAN or user data.
  await cdp.command('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.confirm = () => true;
    window.__phone = { sent: [] };
    window.WebSocket = class {
      constructor() { this.readyState = 1; window.__phone.socket = this; setTimeout(() => this.onopen?.(), 0); }
      send(text) { window.__phone.sent.push(JSON.parse(text)); }
      close() { this.readyState = 3; this.onclose?.(); }
    };
  ` });
  const phoneUrl = new URL('/src-tauri/src/dual_page.html?token=synthetic', url).href;
  await cdp.command('Page.navigate', { url: phoneUrl });
  await cdp.waitFor('!!window.__phone?.socket');
  assert.ok(await cdp.evaluate("!!document.querySelector('[data-zone=end-session]')"), 'Phone needs a separate end-session control');
  assert.equal(await cdp.evaluate("document.getElementById('b-solve').disabled"), true, 'Do not enable actions before a desktop state snapshot arrives');
  await cdp.evaluate(`window.__phone.socket.onmessage({data:JSON.stringify({t:'state',data:{modeLabel:'快速',turns:[{md:'Synthetic answer',tsText:'12:00'}],followUps:[{intent:'simplify',label:'继续简化'}]}})})`);
  await cdp.evaluate("document.querySelector('#followups button').click()");
  assert.equal(await cdp.evaluate('window.__phone.sent.at(-1).id'), 'followup:simplify', 'Transmit stable action IDs rather than display labels');
  await cdp.evaluate("document.querySelector('[data-zone=end-session]').click()");
  assert.equal(await cdp.evaluate('window.__phone.sent.at(-1).id'), 'end-session');
  await cdp.evaluate("window.__phone.socket.onmessage({data:JSON.stringify({t:'ended'})})");
  assert.equal(await cdp.evaluate("document.getElementById('main').innerText.includes('Synthetic answer')"), false, 'Clear answer content after ending or releasing the session');
  assert.equal(await cdp.evaluate('window.__phone.socket.readyState'), 3);
  await writeFile('artifacts/overlay-ui-results.json', JSON.stringify({ passed: true, backgrounds, takeoverHidden: true, paletteCaptureHidden: true }, null, 2));
  console.log('PASS: overlay transparency, takeover hiding, phone waiting state, end-session control, stable action IDs and answer cleanup.');
} finally {
  if (cdp.socket) { await cdp.command('Browser.close', {}).catch(() => {}); cdp.close(); }
  browser.kill();
}
