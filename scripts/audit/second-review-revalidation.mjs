// Read-only follow-up. Reuses the isolated UI fixture from browser-boundaries.mjs.
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {evaluateFixture} from '../../tests/compile-fixture.mjs';
import {DesktopCdp,delay} from '../desktop-cdp.mjs';
await mkdir('artifacts/audit',{recursive:true});
if(!existsSync('artifacts/audit/ui.html')){
  const setup=spawnSync(process.execPath,['scripts/audit/browser-boundaries.mjs','--verify'],{encoding:'utf8',windowsHide:true});assert.equal(setup.status,0,setup.stdout+setup.stderr);
}
const fixEvidence=JSON.parse(readFileSync('docs/audit/2026-11-04-fix-evidence.json','utf8'));
const production=fixEvidence.sourceHashes.filter(row=>row.file.startsWith('src/')||row.file.startsWith('src-tauri/src/'));
const changes=production.filter(row=>createHash('sha256').update(readFileSync(row.file)).digest('hex')!==row.sha256).map(row=>row.file);
if(process.argv.includes('--baseline'))assert.deepEqual(changes,[],'Original audit baseline changed');
const results=[];
// Invoke the real hook with a controlled effect scheduler to inspect cleanup order.
let cleanup;const timers=[],listeners=new Set(),pendingTimers=new Set();
const api=evaluateFixture('src/ui/primitives.tsx',{exports:{},window:{setTimeout:fn=>{timers.push(fn);pendingTimers.add(fn);return fn;},clearTimeout:fn=>pendingTimers.delete(fn)},document:{addEventListener:(_event,fn)=>listeners.add(fn),removeEventListener:(_event,fn)=>listeners.delete(fn)},require:name=>{
  if(name==='react')return {createContext:()=>({}),useRef:value=>({current:value}),useEffect:effect=>{cleanup=effect();}};
  if(name==='../lib/events')return {bus:{}};
  if(['lucide-react','react/jsx-runtime','react-dom','./useModalFocus'].includes(name))return {};
  throw Error(name);
}});
api.useClickOutside(()=>{});cleanup();for(const timer of timers)timer();
results.push({id:'R02',status:listeners.size||pendingTimers.size?'confirmed-latent':'fixed',activeListenerCountAfterCleanup:listeners.size,pendingTimers:pendingTimers.size,productionCallSites:0,scope:'Unused hook; cleanup checked even if a cancelled timer fires late'});
const url='http://127.0.0.1:1444/artifacts/audit/ui.html';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/audit/vite.config.mjs','--host','127.0.0.1','--port','1444','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser,cdp;
try{
  let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Port 1444 is unavailable');try{if((await fetch(url)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const profile=await mkdtemp(path.resolve('artifacts/second-review-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19406',url],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19406,'main');await cdp.connect();await cdp.waitFor("typeof __view==='function'");await cdp.evaluate("__view('resources')");await cdp.click('新建岗位');
  await cdp.evaluate("(()=>{const input=document.querySelector('input[placeholder=岗位名称]');window.__ordinaryDialog=input.closest('.relative.z-10');input.focus();})()");
  let escaped=false,focus;
  for(let i=0;i<15;i++){
    await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    focus=await cdp.evaluate("({inside:__ordinaryDialog.contains(document.activeElement),tag:document.activeElement.tagName,label:document.activeElement.getAttribute('aria-label'),text:document.activeElement.textContent?.trim().slice(0,40)})");
    if(!focus.inside){escaped=true;break;}
  }
  const semantics=await cdp.evaluate("!!document.querySelector('[role=dialog][aria-modal=true]')");
  results.push({id:'R01',status:escaped||!semantics?'confirmed-active':'fixed',scenario:'Resource page / new goal dialog / Tab',focus,semantics,voiceDialogPreviouslyFixed:true});
  const shot=await cdp.command('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/audit/second-review-dialog.png',Buffer.from(shot.data,'base64'));
}finally{
  if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.kill();
}
const evidence={createdAt:new Date().toISOString(),productionCodeUnchangedSinceFixEvidence:changes.length===0,changedProductionFiles:changes,checkedProductionFiles:production.length,results};
await writeFile('artifacts/audit/second-review-revalidation.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
if(process.argv.includes('--verify')&&results.some(row=>row.status!=='fixed'))process.exitCode=1;
