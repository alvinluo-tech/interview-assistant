// Windows desktop integration check. Compile a dedicated smoke identifier first;
// this script never opens or changes the normal application's data directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const executable = path.resolve(process.argv[2] ?? 'artifacts/privacy-smoke.exe');
const identifier = 'com.mianlingai.clone.smoke';
const root = path.join(process.env.APPDATA, identifier);
const port = 19387;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const copiedExecutables = [];
let socket;
let sequence = 0;
let pending = new Map();

async function connect() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === 'page' && !p.url.includes('#overlay'));
      if (page?.webSocketDebuggerUrl) {
        const candidate = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { candidate.onopen = resolve; candidate.onerror = reject; });
        socket = candidate;
        pending = new Map();
        socket.onmessage = (e) => {
          const data = JSON.parse(e.data);
          if (data.id && pending.has(data.id)) {
            const { resolve, reject, timer } = pending.get(data.id);
            clearTimeout(timer);
            pending.delete(data.id);
            if (data.error) reject(new Error(JSON.stringify(data.error))); else resolve(data.result);
          }
        };
        const label = await evaluate('window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label');
        if (label === 'main') return;
        socket.close();
      }
    } catch { /* WebView2 may still be starting or replacing the old process. */ }
    await delay(250);
  }
  throw new Error('Timed out connecting to the isolated desktop client');
}

function cdp(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 12000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result?.value;
}
const invoke = (command, args = {}) => evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
async function waitFor(expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await delay(200);
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}
async function check(name, action) {
  await action();
  results.push(name);
  console.log(`PASS ${name}`);
}
async function restart() {
  await evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('cmd_relaunch'), 50); 'scheduled'");
  socket.close();
  await delay(1800);
  await connect();
}
function exited(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child ${child.pid} did not exit`)), 10000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}
function guardParent(exitCode) {
  const parent = spawn(process.execPath, ['-e', `setTimeout(() => process.exit(${exitCode}), 1000)`], { windowsHide: true, stdio: 'ignore' });
  return spawn(executable, [`--guardian=${parent.pid}`], {
    windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  });
}

await mkdir(root, { recursive: true });
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)), 'Use a binary compiled with the isolated smoke identifier');
await writeFile(path.join(root, 'store.json'), JSON.stringify({
  'notice.usageAcknowledged.v2': true, 'onboarding.skipped': true,
  'capture.excluded': true, 'disguise.enabled': false,
}));
const processHandle = spawn(executable, [], {
  windowsHide: true, stdio: 'ignore',
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
});
processHandle.on('error', (e) => console.error(e));
try {
  await connect();
  await check('startup protects both HWNDs', async () => {
    const state = await invoke('cmd_get_capture_status');
    assert.equal(state.supported, true);
    assert.equal(state.demoVisible, false);
    assert.equal(state.windows.length, 2);
    assert.ok(state.windows.every((w) => w.affinity === 0x11 && w.error === null));
  });
  await check('settings controls read native state and toggle capture', async () => {
    await waitFor("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '设置')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '设置').click()");
    await waitFor("Array.from(document.querySelectorAll('button')).some(b => b.textContent.trim() === '隐蔽')");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '隐蔽').click()");
    const control = 'document.querySelector(\'[aria-label="反屏幕捕获"]\')';
    await waitFor(`${control} && !${control}.disabled`);
    assert.equal(await evaluate(`${control}.getAttribute('aria-checked')`), 'true');
    await evaluate(`${control}.click()`);
    await waitFor(`${control}.getAttribute('aria-checked') === 'false' && !${control}.disabled`);
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0));
    await evaluate(`${control}.click()`);
    await waitFor(`${control}.getAttribute('aria-checked') === 'true' && !${control}.disabled`);
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0x11));
  });
  await check('demo mode clears both HWNDs and survives page reload', async () => {
    await invoke('cmd_set_demo_visible_mode', { enable: true });
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0));
    await evaluate("location.reload(); 'scheduled'");
    await delay(1200);
    const state = await invoke('cmd_get_capture_status');
    assert.equal(state.demoVisible, true);
    assert.ok(state.windows.every((w) => w.affinity === 0));
    await invoke('cmd_set_demo_visible_mode', { enable: false });
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0x11));
  });
  await check('global capture switch persists and individual override stays local', async () => {
    await invoke('cmd_set_capture_excluded', { enable: false });
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0));
    assert.equal(JSON.parse(await readFile(path.join(root, 'store.json')))['capture.excluded'], false);
    await invoke('cmd_set_capture_excluded', { enable: true, label: 'overlay' });
    const state = await invoke('cmd_get_capture_status');
    assert.equal(state.windows.find((w) => w.label === 'main').affinity, 0);
    assert.equal(state.windows.find((w) => w.label === 'overlay').affinity, 0x11);
    await invoke('cmd_set_capture_excluded', { enable: true });
  });
  await check('invalid process name is rejected without changing config', async () => {
    await assert.rejects(() => invoke('cmd_set_disguise', { config: { enabled: true, processName: '../escape', windowTitle: 'Helper' } }));
    assert.equal((await invoke('cmd_get_disguise_status')).config.enabled, false);
  });
  await check('identity updates live and restart adopts renamed copy', async () => {
    const state = await invoke('cmd_set_disguise', { config: { enabled: true, processName: 'PrivacySmokeHelper.exe', windowTitle: 'Privacy Smoke Helper' } });
    assert.equal(state.config.processName, 'PrivacySmokeHelper');
    assert.equal(state.restartRequired, true);
    await invoke('cmd_set_demo_visible_mode', { enable: true });
    await restart();
    const next = await invoke('cmd_get_disguise_status');
    assert.equal(next.runningDisguised, true);
    assert.equal(next.restartRequired, false);
    assert.match(next.currentExe, /PrivacySmokeHelper\.exe$/);
    copiedExecutables.push(next.currentExe);
    assert.equal((await invoke('cmd_get_capture_status')).demoVisible, false);
    assert.ok((await invoke('cmd_get_capture_status')).windows.every((w) => w.affinity === 0x11));
  });
  await check('second name change restarts successfully', async () => {
    await invoke('cmd_set_disguise', { config: { enabled: true, processName: 'PrivacySmokeHelper2', windowTitle: 'Privacy Smoke Helper 2' } });
    await restart();
    const next = await invoke('cmd_get_disguise_status');
    assert.match(next.currentExe, /PrivacySmokeHelper2\.exe$/);
    copiedExecutables.push(next.currentExe);
  });
  await check('disabling identity returns to original executable', async () => {
    await invoke('cmd_set_disguise', { config: { enabled: false, processName: 'PrivacySmokeHelper2', windowTitle: 'Privacy Smoke Helper 2' } });
    await restart();
    const state = await invoke('cmd_get_disguise_status');
    assert.equal(state.runningDisguised, false);
    assert.equal(state.restartRequired, false);
    assert.equal(path.resolve(state.currentExe).toLowerCase(), executable.toLowerCase());
  });
  await evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('cmd_exit_app'), 50); 'scheduled'");
  socket.close();
  await delay(1200);
  await check('guardian does not relaunch a normal exit', async () => {
    assert.equal(await exited(guardParent(0)), 0);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    assert.ok(!pages.some(p => p.type === 'page'));
  });
  await check('guardian relaunches an abnormal exit', async () => {
    assert.equal(await exited(guardParent(7)), 0);
    await connect();
    assert.equal((await invoke('cmd_get_disguise_status')).runningDisguised, false);
    await evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('cmd_exit_app'), 50); 'scheduled'");
  });
  const report = { passed: results.length, results, identifier, executable, copiedExecutables };
  await writeFile(path.join(path.dirname(executable), 'privacy-smoke-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { await evaluate("setTimeout(() => window.__TAURI_INTERNALS__.invoke('cmd_exit_app'), 20); 'scheduled'"); } catch { /* Already exited. */ }
  socket?.close();
}
