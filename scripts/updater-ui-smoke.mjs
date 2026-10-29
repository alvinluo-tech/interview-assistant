// Actual updater components with a synthetic native bridge; never installs an OS update.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/updater-ui.html', `<!doctype html><html><meta charset="utf-8"><div id="root"></div>
<div style="position:fixed;right:16px;bottom:12px;z-index:100;font:11px system-ui;color:#526d81">界面预览 · 测试数据</div><script>
window.__errors=[]; addEventListener('error',e=>__errors.push(e.message)); addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
window.__test={calls:[],callbacks:new Map(),listeners:new Map(),state:{phase:'idle',currentVersion:'0.1.2',version:null,date:'2026-10-29T08:48:11Z',notes:'# Mianxu\\n\\n更新体验更清晰，安装时间由你决定。\\n\\n## 本次改进\\n- **更新卡片**：更清晰的版本与更新内容\\n- **下载进度**：实时显示文件大小和完成比例\\n- **安装确认**：会话结束后再重启更新',downloaded:0,busy:false,canInstall:true}};
window.__test.emit = patch => { Object.assign(__test.state,patch); const id=__test.listeners.get('updater-state'); __test.callbacks.get(id)?.({payload:{...__test.state}}); };
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},
transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),
invoke:async(name,args)=>{
  __test.calls.push(name);
  if(name==='plugin:event|listen'){__test.listeners.set(args.event,args.handler);return args.handler;}
  if(name==='plugin:store|load')return 1;
  if(name==='cmd_updater_check')Object.assign(__test.state,{phase:'available',version:'0.1.3',error:null});
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
  await cdp.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await cdp.waitFor('!!document.querySelector("button")');
  await cdp.evaluate('document.querySelector("button").focus()');
  try { await cdp.click('检查更新'); }
  catch (error) { console.error(await cdp.evaluate('({errors:__errors,body:document.body.innerText})')); throw error; }
  await cdp.waitFor("document.body.innerText.includes('发现新版本 0.1.3')");
  await cdp.waitFor("!!document.querySelector('[role=dialog]')");
  assert.equal(await cdp.evaluate("document.querySelector('[role=dialog]').getAttribute('aria-modal')"), 'true');
  assert.equal(await cdp.evaluate("document.querySelector('.update-notes').open"), false);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.update-primary').length"), 1);
  assert.equal(await cdp.evaluate("document.querySelector('.update-highlights').innerText.includes('**')"), false);
  await cdp.waitFor("document.activeElement?.getAttribute('role') === 'dialog'");
  await cdp.evaluate("document.querySelector('.update-footer-meta button').focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))");
  assert.equal(await cdp.evaluate("document.activeElement?.getAttribute('aria-label')"), '关闭更新窗口');
  await cdp.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))");
  assert.equal(await cdp.evaluate("document.activeElement === document.querySelector('.update-footer-meta button')"), true);
  await delay(300);
  const saveScreenshot = async name => {
    const shot = await cdp.command('Page.captureScreenshot', { format: 'png' });
    await writeFile(`artifacts/${name}.png`, Buffer.from(shot.data, 'base64'));
  };
  await saveScreenshot('updater-branded-available');
  await cdp.command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.update-card')).animationName"), 'none');
  await cdp.command('Emulation.setEmulatedMedia', { features: [] });
  await cdp.evaluate("document.documentElement.classList.add('dark')");
  await delay(300);
  assert.equal(await cdp.evaluate("getComputedStyle(document.querySelector('.update-card')).opacity"), '1');
  await saveScreenshot('updater-branded-dark');
  await cdp.evaluate("document.documentElement.classList.remove('dark')");
  await cdp.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await delay(200);
  assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  await saveScreenshot('updater-branded-narrow');
  await cdp.command('Emulation.setDeviceMetricsOverride', { width: 1100, height: 850, deviceScaleFactor: 1, mobile: false });
  await cdp.click('下载更新');
  await cdp.waitFor("!!document.querySelector('[role=progressbar]')");
  await cdp.waitFor("document.body.innerText.includes('重启并安装')");
  assert.equal(await cdp.evaluate("__test.calls.includes('cmd_updater_install')"), false);
  await cdp.click('稍后安装');
  assert.equal(await cdp.evaluate('document.activeElement === document.querySelector("button")'), true);
  await cdp.click('查看更新');
  await cdp.evaluate('__test.emit({busy:true})');
  await delay(100);
  await cdp.click('查看更新');
  assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='重启并安装')?.disabled"), true);
  assert.equal(await cdp.evaluate("__test.calls.includes('cmd_updater_install')"), false);
  await cdp.evaluate('__test.emit({busy:false})');
  await cdp.click('重启并安装');
  assert.equal(await cdp.evaluate("__test.calls.filter(n=>n==='cmd_updater_install').length"), 1);
  assert.equal(await cdp.evaluate("!!document.querySelector('button[aria-label=关闭更新窗口]')"), false);
  await cdp.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  assert.equal(await cdp.evaluate("!!document.querySelector('[role=dialog]')"), true);
  await cdp.evaluate("__test.emit({phase:'error',error:'签名验证失败'})");
  await cdp.waitFor("document.querySelector('[role=alert]')?.textContent.includes('签名验证失败')");
  assert.equal(await cdp.evaluate("document.querySelector('.update-error details').open"), false);
  await saveScreenshot('updater-branded-error');
  await cdp.evaluate("__test.emit({phase:'available',canInstall:true,installMode:'installer',installReason:'当前是开发版，下载并验证后可通过安装向导安装正式版。',error:null})");
  await cdp.waitFor("document.querySelector('.update-primary')?.textContent.includes('下载正式版')");
  await cdp.click('下载正式版');
  await cdp.waitFor("document.querySelector('.update-primary')?.textContent.includes('安装正式版')");
  assert.equal(await cdp.evaluate("__test.calls.filter(n=>n==='cmd_updater_install').length"), 1);
  assert.equal(await cdp.evaluate("__test.calls.some(n=>n.startsWith('plugin:opener|'))"), false);
  assert.equal(await cdp.evaluate("document.querySelector('.update-description').textContent.includes('安装向导')"), true);
  await saveScreenshot('updater-installer-handoff-ready');
  await cdp.evaluate('__test.emit({busy:true})');
  await cdp.waitFor("document.querySelector('.update-primary')?.disabled === true");
  await cdp.evaluate('__test.emit({busy:false})');
  await cdp.waitFor("document.querySelector('.update-primary')?.disabled === false");
  await cdp.click('安装正式版');
  assert.equal(await cdp.evaluate("__test.calls.filter(n=>n==='cmd_updater_install').length"), 2);
  assert.equal(await cdp.evaluate("__test.calls.some(n=>n.startsWith('plugin:opener|'))"), false);
  await cdp.evaluate("__test.emit({phase:'available',canInstall:false,installMode:'unavailable',installReason:'当前平台不支持自动安装',error:null})");
  await cdp.waitFor("document.querySelector('.update-primary')?.textContent.includes('前往发布页')");
  assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='下载更新')"), false);
  assert.deepEqual(await cdp.evaluate('__errors'), []);
  await writeFile('artifacts/updater-ui-results.json', JSON.stringify({ passed: true, explicitConsent: true, busyBlocked: true, installerHandoff: true, noBrowserRedirect: true, manualFallback: true }, null, 2));
  console.log('PASS: actual updater dialog, download progress, explicit installation consent, busy gate, installer handoff without browser redirect, failure display, truthful unsupported fallback.');
} finally {
  if (cdp.socket) { await cdp.command('Browser.close', {}).catch(() => {}); cdp.close(); }
  browser.kill();
}
