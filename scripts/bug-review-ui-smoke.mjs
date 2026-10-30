// Real overlay components, isolated browser, synthetic native calls and records.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp, delay} from './desktop-cdp.mjs';
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/bug-review-fixture.html', `<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.__test={callbacks:new Map(),events:new Map(),calls:[],data:{},revision:0,errors:[]};
addEventListener('error',e=>__test.errors.push(e.message));addEventListener('unhandledrejection',e=>__test.errors.push(String(e.reason)));
window.__fire=(name,payload)=>{for(const id of [...(__test.events.get(name)||[])]) __test.callbacks.get(id)?.({payload});};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'overlay'},currentWebview:{label:'overlay'}},transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),invoke:async(name,args)=>{
__test.calls.push({name,args});
if(name==='plugin:event|listen'){const set=__test.events.get(args.event)||new Set();set.add(args.handler);__test.events.set(args.event,set);return args.handler;}
if(name==='plugin:event|unlisten'){__test.events.get(args.event)?.delete(args.eventId);return;}
if(name==='plugin:store|load')return 1;
if(name==='plugin:window|scale_factor')return 1;
if(name==='plugin:window|outer_position')return {x:0,y:0};
if(name==='plugin:window|outer_size')return {width:560,height:600};
if(name==='plugin:window|available_monitors')return [{name:'fixture',position:{x:0,y:0},size:{width:1920,height:1080},workArea:{position:{x:0,y:0},size:{width:1920,height:1080}},scaleFactor:1}];
if(name==='plugin:window|current_monitor')return {name:'fixture',position:{x:0,y:0},size:{width:1920,height:1080},workArea:{position:{x:0,y:0},size:{width:1920,height:1080}},scaleFactor:1};
if(name==='cmd_data_commit'){__test.data[args.key]=args.value;return {revision:++__test.revision,data:__test.data};}
if(name==='cmd_data_read')return {revision:__test.revision,data:__test.data};
return null;}};
</script><script type="module" src="/artifacts/bug-review-fixture.tsx"></script>`);
await writeFile('artifacts/bug-review-fixture.tsx', `import React from 'react';import{createRoot}from'react-dom/client';
import '/src/index.css';import{InterviewOverlay}from'/src/overlay/InterviewOverlay.tsx';import{OverlayPlatformProvider}from'/src/overlay/platform.tsx';
import{OverlayApp,useOverlayStyleHotkeys}from'/src/overlay/OverlayApp.tsx';import{getSetting,setSetting,DEFAULT_OVERLAY_STYLE}from'/src/lib/store.ts';
import{readData,writeData}from'/src/lib/backend.ts';import{resumeInterviewSession}from'/src/lib/interviewEngine.ts';
window.__settings=setSetting;window.__read=getSetting;
await setSetting('overlay.mode','interview-preview');await setSetting('overlay.style',{...DEFAULT_OVERLAY_STYLE,interviewBgOpacity:0.2});
await setSetting('interview.showHotkeyHints',false);await setSetting('interview.followNewRound',false);
let count=0;window.__append=async()=>{count++;await writeData('interviewSessions',[{id:'fixture',type:'INTERVIEW',status:'ACTIVE',createdAt:0,messages:Array.from({length:40+count},(_,i)=>({id:'m'+i,role:i%2?'ASSISTANT':'INTERVIEWER',text:('Synthetic message '+i+' ').repeat(15),createdAt:i}))}]);resumeInterviewSession('fixture',null,null);};
function Fixture(){useOverlayStyleHotkeys(getSetting('overlay.style',DEFAULT_OVERLAY_STYLE),'interview');return <OverlayPlatformProvider mode="interview"><InterviewOverlay preview/></OverlayPlatformProvider>;}
const root=createRoot(document.getElementById('root'));root.render(<Fixture/>);window.__fullOverlay=()=>root.render(<OverlayApp/>);await window.__append();
`);
const url='http://127.0.0.1:1443/artifacts/bug-review-fixture.html#overlay';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1443','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser;const cdp=new DesktopCdp(19403,'overlay');
const results=[];
try {
  for(let i=0;i<150;i++){try{if((await fetch(url)).ok)break;}catch{}if(server.exitCode!==null)throw new Error('Fixture server failed');await delay(100);}
  const profile=await mkdtemp(path.resolve('artifacts/bug-review-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19403',url],{windowsHide:true,stdio:'ignore'});
  await cdp.connect();await cdp.waitFor('!!document.querySelector("[data-overlay-theme]")');
  await cdp.command('Emulation.setDeviceMetricsOverride',{width:560,height:600,deviceScaleFactor:1,mobile:false});await delay(300);
  const check=async(name,fn)=>{try{await fn();results.push({name,passed:true});}catch(error){results.push({name,passed:false,error:error.message});}};
  await check('B16: disabling hints removes hotkey badges',async()=>assert.equal(await cdp.evaluate("document.querySelectorAll('.shrink-0.whitespace-nowrap').length"),0));
  await check('B4: two rapid style actions preserve both steps',async()=>{
    await cdp.evaluate("__fire('action-hotkeys',{action:'opacity-up',pressed:true});__fire('action-hotkeys',{action:'opacity-up',pressed:true})");await delay(150);
    assert.ok(Math.abs(await cdp.evaluate("__read('overlay.style',{}).interviewBgOpacity")-0.4)<0.001);
  });
  await check('B7: disabled follow leaves the reading position intact',async()=>{
    await cdp.evaluate("document.querySelector('div.overflow-y-auto.px-1').scrollTop=0;__append()");await delay(200);
    assert.equal(await cdp.evaluate("document.querySelector('div.overflow-y-auto.px-1').scrollTop"),0);
  });
  await check('B8: hovering the edge scrolls without a click',async()=>{
    await cdp.evaluate("document.querySelector('div.overflow-y-auto.px-1').scrollTop=0;__fire('cursor-zone',{zoneId:'scroll-down'})");await delay(450);
    assert.ok(await cdp.evaluate("document.querySelector('div.overflow-y-auto.px-1').scrollTop>0"));await cdp.evaluate("__fire('cursor-zone',{zoneId:null})");
  });
  await check('B30: first palette dwell requires confirmation before capture',async()=>{
    await cdp.evaluate("__test.calls.length=0;__fire('cursor-zone',{zoneId:'iv-auto-palette'})");await delay(1800);
    assert.equal(await cdp.evaluate("__test.calls.some(c=>c.name==='cmd_check_screen_capture_permission')"),false);
    assert.ok(await cdp.evaluate("document.body.innerText.includes('确认配色')"));await cdp.evaluate("__fire('cursor-zone',{zoneId:null})");
  });
  await check('B3: dwell can restore mouse interaction from passthrough',async()=>{
    await cdp.evaluate("__test.calls.length=0;__fire('cursor-zone',{zoneId:'iv-mode'})");await delay(2500);
    assert.ok(await cdp.evaluate("__test.calls.some(c=>c.name==='cmd_set_overlay_interactive'&&c.args.interactive===true)"));
  });
  await cdp.evaluate("__settings('overlay.position',{x:99999,y:99999});__fullOverlay()");await delay(150);
  await cdp.evaluate("__fire('overlay-shown',{seq:1})");await delay(250);
  await check('B6: restored window position stays inside a connected work area',async()=>{
    assert.ok(await cdp.evaluate("__test.calls.some(c=>c.name==='cmd_position_overlay'&&c.args.pos.x<=1360&&c.args.pos.y<=480)"));
  });
  await check('B5: resize events persist logical dimensions',async()=>{
    await cdp.evaluate("__fire('tauri://resize',{width:640,height:480})");await delay(700);
    assert.equal(await cdp.evaluate("__read('overlay.style',{}).interviewWidth"),640);
    assert.equal(await cdp.evaluate("__read('overlay.style',{}).interviewHeight"),480);
  });
  console.log(JSON.stringify(results,null,2));
  await writeFile('artifacts/bug-review-ui-results.json',JSON.stringify(results,null,2));
  assert.ok(results.every(result=>result.passed),'All overlay bug reproducers must pass');
} finally {cdp.close();browser?.kill();server.kill();}
