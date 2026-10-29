// Actual updater components with a synthetic native bridge; never installs an OS update.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/updater-ui.html', `<!doctype html><html><meta charset="utf-8"><div id="root"></div>
<script>
window.__errors=[]; addEventListener('error',e=>__errors.push(e.message)); addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
window.__test={calls:[],callbacks:new Map(),listeners:new Map(),state:{phase:'idle',currentVersion:'0.1.1',version:null,notes:'Synthetic release notes',downloaded:0,busy:false,canInstall:true}};
window.__test.emit = patch => { Object.assign(__test.state,patch); const id=__test.listeners.get('updater-state'); __test.callbacks.get(id)?.({payload:{...__test.state}}); };
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),
invoke:async(name,args)=>{
  __test.calls.push(name);
  if(name==='plugin:event|listen'){__test.listeners.set(args.event,args.handler);return args.handler;}
  if(name==='plugin:store|load')return 1;
  if(name==='cmd_updater_check')Object.assign(__test.state,{phase:'available',version:'0.1.2',error:null});
  if(name==='cmd_updater_download'){
    __test.emit({phase:'downloading',downloaded:524288,total:1048576,error:null});
    await new Promise(resolve=>setTimeout(resolve,400));
    __test.emit({phase:'ready',downloaded:1048576});
  }
  if(name==='cmd_updater_install')__test.emit({phase:'installing'});
  return name.startsWith('cmd_updater_') ? {...__test.state} : null;
}};
</script><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import '/src/index.css';
import {UpdateNotice,UpdateStatusButton} from '/src/main/UpdateNotice.tsx';
createRoot(document.getElementById('root')).render(React.createElement(React.Fragment,null,React.createElement(UpdateStatusButton),React.createElement(UpdateNotice)));
</script></html>`);

const url = new URL('/artifacts/updater-ui.html', process.env.UPDATER_TEST_URL || 'http://127.0.0.1:1438').href;
const profile = await mkdtemp(path.resolve('artifacts/updater-ui-browser-'));
const port = 19399;
const executable = process.env.UI_TEST_BROWSER || path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe');
const browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, url], { windowsHide: true, stdio: 'ignore' });
const cdp = new DesktopCdp(port);
try {
  await cdp.connect();
  try { await cdp.click('检查更新'); }
  catch (error) { console.error(await cdp.evaluate('({errors:__errors,body:document.body.innerText})')); throw error; }
  await cdp.waitFor("document.body.innerText.includes('发现新版本 0.1.2')");
  await cdp.click('下载更新');
  await cdp.waitFor("!!document.querySelector('progress')");
  await cdp.waitFor("document.body.innerText.includes('重启并安装')");
  assert.equal(await cdp.evaluate("__test.calls.includes('cmd_updater_install')"), false);
  await cdp.click('稍后安装');
  await cdp.click('查看更新');
  await cdp.evaluate('__test.emit({busy:true})');
  await delay(100);
  await cdp.click('查看更新');
  assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重启并安装')?.disabled"), true);
  assert.equal(await cdp.evaluate("__test.calls.includes('cmd_updater_install')"), false);
  await cdp.evaluate('__test.emit({busy:false})');
  await cdp.click('重启并安装');
  assert.equal(await cdp.evaluate("__test.calls.filter(n=>n==='cmd_updater_install').length"), 1);
  assert.equal(await cdp.evaluate("!!document.querySelector('button[aria-label=关闭]')"), false);
  await cdp.evaluate("__test.emit({phase:'error',error:'签名验证失败'})");
  await cdp.waitFor("document.querySelector('[role=alert]')?.textContent.includes('签名验证失败')");
  await cdp.evaluate("__test.emit({phase:'available',canInstall:false,installReason:'免安装版请手动更新',error:null})");
  await cdp.waitFor("document.body.innerText.includes('免安装版请手动更新')");
  assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='下载更新')"), false);
  assert.deepEqual(await cdp.evaluate('__errors'), []);
  await writeFile('artifacts/updater-ui-results.json', JSON.stringify({ passed: true, explicitConsent: true, busyBlocked: true, manualFallback: true }, null, 2));
  console.log('PASS: actual updater dialog, download progress, explicit installation consent, busy gate, failure display, portable fallback.');
} finally {
  if (cdp.socket) { await cdp.command('Browser.close', {}).catch(() => {}); cdp.close(); }
  browser.kill();
}
