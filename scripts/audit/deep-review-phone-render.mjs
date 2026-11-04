// Real phone HTML in an isolated browser; no LAN server, pairing or real WebSocket.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp,delay} from '../desktop-cdp.mjs';
const origin='http://127.0.0.1:1445';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/audit/vite.config.mjs','--host','127.0.0.1','--port','1445','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser,cdp;
try{
  let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Audit port unavailable');try{if((await fetch(origin+'/artifacts/audit/ui.html')).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const profile=await mkdtemp(path.resolve('artifacts/deep-phone-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19407',origin+'/artifacts/audit/ui.html'],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19407,'main');await cdp.connect();
  await cdp.command('Page.enable',{});
  await cdp.command('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{const Native=window.WebSocket;window.__payloadExecuted=0;window.__phoneErrors=[];addEventListener('error',e=>__phoneErrors.push(e.message));window.WebSocket=class extends EventTarget{constructor(url,protocols){super();if(!String(url).includes('/ws?token='))return new Native(url,protocols);this.readyState=1;window.__phoneSocket=this;queueMicrotask(()=>this.onopen?.());}send(){}close(){this.readyState=3;}};})();`});
  await cdp.command('Page.navigate',{url:origin+'/src-tauri/src/dual_page.html?token=synthetic-audit-only'});
  try{await cdp.waitFor('!!window.__phoneSocket?.onmessage');}catch(error){console.error(await cdp.evaluate('({url:location.href,errors:window.__phoneErrors,body:document.body?.textContent.slice(0,500),intercepted:window.__payloadExecuted})'));throw error;}
  const payload='<img src=x onerror="window.__payloadExecuted++"><svg onload="window.__payloadExecuted++"></svg><script>window.__payloadExecuted++</script>';
  await cdp.evaluate(`__phoneSocket.onmessage({data:JSON.stringify({t:'state',data:{brand:${JSON.stringify(payload)},modeLabel:${JSON.stringify(payload)},turns:[{md:${JSON.stringify(payload+'\n```html\n'+payload+'\n```')},tsText:'合成时间'}],followUps:[{intent:'simplify',label:${JSON.stringify(payload)}}]}})});true`);
  await delay(250);
  const observed=await cdp.evaluate("({executed:__payloadExecuted,activeElements:document.querySelectorAll('#main img,#main svg,#main script,#followups img,#brand img').length,bodyLiteral:document.getElementById('main').textContent.includes('<img'),labelLiteral:document.getElementById('brand').textContent.includes('<img')})");
  assert.equal(observed.executed,0);assert.equal(observed.activeElements,0);assert.equal(observed.bodyLiteral,true);assert.equal(observed.labelLiteral,true);
  await writeFile('artifacts/audit/deep-review-phone-render.json',JSON.stringify({createdAt:new Date().toISOString(),status:'pass',observed,scope:'Real dual_page.html; model text/code blocks/brand/mode/follow-up label escaped. Does not prove all fields, CSP safety or network confidentiality.'},null,2));
  console.log(JSON.stringify(observed));
}finally{if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.kill();}
