// Isolated Vite port 1441. Native calls/data/audio are synthetic; no personal app state.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DesktopCdp, delay } from './desktop-cdp.mjs';
await mkdir('artifacts', {recursive:true});
await writeFile('artifacts/mock-lifecycle-fixture.ts', `export {mockMeta, askedQuestionCount} from '../src/lib/mock';
export async function generateOpeningQuestion(_config,signal) {if(!window.__deferOpening)return '合成开场问题';window.__openingCalls=(window.__openingCalls||0)+1;window.__openingSignal=signal;return new Promise(resolve=>{window.__finishOpening=resolve;});}
export async function generateNextQuestion(_config, _messages, signal) {window.__questionSignal=signal;return new Promise(resolve=>{window.__finishQuestion=resolve;});}
export async function generateMockReport() {return '合成复盘：回答已保留。';}
export async function generateHint() {return '合成辅助提示';}
`);
await writeFile('artifacts/experience-vite.config.mjs', `import base from '../vite.config.ts';import{fileURLToPath}from'node:url';
export default()=>{const config=base();return {...config,cacheDir:'node_modules/.vite-experience-ui',plugins:[...config.plugins,{name:'synthetic-speech-transport',enforce:'pre',transform(_code,id){if(id.replaceAll('\\\\','/').endsWith('/src/lib/aiTransport.ts'))return {code:'export const aiFetch=(url,init)=>window.__ttsFetch(url,init);',map:null};}}],resolve:{...config.resolve,alias:{'@/lib/mock':fileURLToPath(new URL('./mock-lifecycle-fixture.ts',import.meta.url)),...config.resolve.alias}}};};`);
await writeFile('artifacts/experience-fixture.html', `<!doctype html><html><meta charset="utf-8"><div id="root"></div><script>
window.__errors=[]; addEventListener('error',e=>__errors.push(e.message)); addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
window.__ttsCalls=[];window.__audioStarts=0;window.__ttsFetch=async(url,init)=>{if(url.endsWith('/chat/completions')&&!JSON.parse(init.body).audio)return new Response(JSON.stringify({choices:[{message:{content:'合成参考回答：沿用缓存方案。'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});__ttsCalls.push({url,init});return new Response(new ReadableStream({start(controller){window.__ttsStream=controller;},cancel(){window.__ttsCancelled=true;}}),{headers:{'content-type':'text/event-stream'}});};
window.AudioContext=class{state='running';get currentTime(){return performance.now()/1000;}destination={};resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}createBuffer(_channels,length,rate){return {length,duration:length/rate,getChannelData:()=>new Float32Array(length)};}createBufferSource(){return {connect(){},disconnect(){},start(){__audioStarts++;this.timer=setTimeout(()=>this.onended?.(),80);},stop(){clearTimeout(this.timer);}};}};
window.__test={callbacks:new Map(),events:new Map(),calls:[],data:{},revision:0};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'mock'},currentWebview:{label:'mock'}},transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),invoke:async(name,args)=>{
__test.calls.push({name,args});
if(name==='plugin:event|listen'){__test.events.set(args.event,args.handler);return args.handler;}
if(name==='plugin:store|load')return 1;
if(name==='plugin:store|get')return [__test.settings?.[args.key],Object.hasOwn(__test.settings||{},args.key)];
if(name==='plugin:store|set'){(__test.settings||={})[args.key]=args.value;return;}
if(name==='plugin:store|delete'){delete (__test.settings||{})[args.key];return;}
if(name==='cmd_data_commit'){__test.data[args.key]=args.value;return {revision:++__test.revision,data:__test.data};}
if(name==='cmd_data_read')return {revision:__test.revision,data:__test.data};
if(name==='cmd_system_speech'){const handler=__test.callbacks.get(__test.events.get('system-speech-state'));handler?.({payload:{id:args.id,speaking:true}});setTimeout(()=>handler?.({payload:{id:args.id,speaking:false}}),60);}
if(name==='cmd_exam_read_image')return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhUAAAAASUVORK5CYII=';
if(name==='cmd_storage_layout')return {data:'<app>/data',attachments:'<app>/attachments',backups:'<app>/data/backups',cache:'<cache>',logs:'<logs>',settings:'<settings>'};
return null;}};
</script><script type="module" src="/artifacts/experience-fixture.tsx"></script></html>`);
await writeFile('artifacts/experience-fixture.tsx', `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import '/src/index.css';import{MockApp}from'/src/mock/MockApp.tsx';import{RecordsPage}from'/src/main/sections/RecordsPage.tsx';
import{PromptWorkbench}from'/src/main/sections/PromptWorkbench.tsx';import{InterviewOverlay}from'/src/overlay/InterviewOverlay.tsx';import{SimulatedPlatform}from'/src/overlay/platform.tsx';import*as engine from'/src/lib/interviewEngine.ts';window.__engine=engine;import{DeveloperInfo}from'/src/main/sections/DeveloperInfo.tsx';import{StorageSettings}from'/src/main/sections/StorageSettings.tsx';import{AiServicesTab}from'/src/main/sections/AiServicesTab.tsx';
import{writeData}from'/src/lib/backend.ts';import{saveAiSettings}from'/src/lib/aiSettings.ts';import{defaultAiSettings}from'/src/lib/aiConfig.ts';import{setSetting}from'/src/lib/store.ts';
await saveAiSettings({...defaultAiSettings(),providers:[{id:'fixture',name:'测试连接',baseUrl:'http://127.0.0.1:9/v1',apiKey:'',authMode:'none',models:[{id:'test-chat',name:'测试模型',source:'custom'}],lastFetchedAt:null}],routes:{chat:{providerId:'fixture',modelId:'test-chat'},vision:null,stt:null,tts:null}});
await writeData('interviewSessions',[{id:'mock_session',type:'MOCK_INTERVIEW',title:'模拟面试样例',createdAt:Date.now()-62000,status:'ACTIVE',messages:[{id:'opening',role:'INTERVIEWER',text:'你好，我们开始吧。能结合你最熟悉的项目，讲讲一次性能优化的经历吗？',createdAt:Date.now(),metadata:{turnKind:'NEW'}}],metadata:{mock:true,config:{goalName:'后端开发',company:'项目深挖',difficultyLabel:'3–5 年',turnBudget:8,basicsRatio:40,assistMode:false}}},{id:'real',type:'INTERVIEW',title:'真实面试样例',status:'COMPLETED',createdAt:Date.now(),messages:[]}]);
await writeData('examSessions',[{id:'exam',title:'笔试样例',status:'COMPLETED',createdAt:Date.now(),questions:Array.from({length:7},(_,i)=>({id:'q'+i,questionText:'原题 '+(i+1)+'：求两个整数之和。',answer:'答案 '+(i+1)+'：a + b',createdAt:Date.now(),screenshotRefs:['exam/turn/image.png']}))}]);
window.__resetOpening=()=>writeData('interviewSessions',window.__test.data.interviewSessions.map(s=>s.id==='mock_session'?{...structuredClone(s),messages:[],status:'ACTIVE'}:s));
window.__refreshOpening=()=>writeData('interviewSessions',window.__test.data.interviewSessions.map(s=>s.id==='mock_session'?{...structuredClone(s),title:'刷新后的模拟面试'}:s));
window.__ttsRoom=async()=>{await setSetting('mock.speechEnabled',true);return writeData('interviewSessions',window.__test.data.interviewSessions.map(s=>s.id==='mock_session'?{...structuredClone(s),status:'ACTIVE',messages:[{id:'tts-question',role:'INTERVIEWER',text:'请介绍项目中的技术难题。',createdAt:Date.now()}]}:s));};
function Fixture(){const[view,setView]=useState('room');window.__view=setView;return view==='room'?<MockApp/>:<div className="min-h-screen bg-background p-6">{view==='records'?<RecordsPage/>:view==='about'?<DeveloperInfo/>:view==='storage'?<StorageSettings/>:view==='prompts'?<PromptWorkbench/>:view==='interview'?<SimulatedPlatform mode="interview"><InterviewOverlay preview/></SimulatedPlatform>:<AiServicesTab/>}</div>;}createRoot(document.getElementById('root')).render(<Fixture/>);
`);
const url = 'http://127.0.0.1:1441/artifacts/experience-fixture.html#mock?sid=mock_session';
const server = spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/experience-vite.config.mjs','--host','127.0.0.1','--port','1441','--strictPort'],{windowsHide:true,stdio:'ignore'});
try {
  let ready = false;
  for (let i=0;i<100;i++) {
    if (server.exitCode !== null) throw new Error('Isolated Vite server failed to start; check port 1441.');
    try {if ((await fetch(url)).ok) {ready=true;break;}} catch {}
    await delay(100);
  }
  assert.ok(ready, 'Isolated Vite server started');
} catch (error) {server.kill();throw error;}
const profile = await mkdtemp(path.resolve('artifacts/experience-browser-'));
const browser = spawn(process.env.UI_TEST_BROWSER || path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  ['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=19401',url], {windowsHide:true,stdio:'ignore'});
const cdp = new DesktopCdp(19401, 'mock');
try {
  await cdp.connect(); await cdp.waitFor("!!document.querySelector('.mock-question')");
  await cdp.command('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
  await delay(500);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.mock-participant').length"), 2);
  assert.ok(await cdp.evaluate("__test.calls.some(c=>c.name==='cmd_system_speech')"), 'An unconfigured TTS route must use native system speech');
  await cdp.evaluate("document.querySelector('button[aria-label=关闭面试官语音]').click()");
  await delay(100);
  assert.ok(await cdp.evaluate("__test.calls.some(c=>c.name==='cmd_system_speech_stop')"));
  const screenshot = await cdp.command('Page.captureScreenshot',{format:'png'});
  await writeFile('artifacts/mock-room-preview.png', Buffer.from(screenshot.data,'base64'));
  await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'我先测量慢查询，再分析执行计划。');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await cdp.click('提交回答'); await cdp.waitFor("typeof window.__finishQuestion === 'function'");
  await cdp.click('结束面试'); await cdp.click('结束并复盘');
  await cdp.waitFor("document.body.innerText.includes('模拟面试复盘')");
  assert.equal(await cdp.evaluate('__questionSignal.aborted'), true);
  await cdp.evaluate("__finishQuestion({question:'不应追加的迟到问题',turnKind:'NEW'})"); await delay(100);
  assert.equal(await cdp.evaluate("__test.data.interviewSessions.find(s=>s.id==='mock_session').messages.filter(m=>m.role==='INTERVIEWER').length"),1);
  await cdp.evaluate("__view('records')"); await cdp.waitFor("document.body.innerText.includes('真实面试样例')");
  assert.equal(await cdp.evaluate("document.body.innerText.includes('模拟面试样例')"), false);
  await cdp.evaluate("document.querySelector('button[title=重命名]').click()"); await cdp.input('input','改名后的真实面试'); await cdp.click('保存');
  assert.equal(await cdp.evaluate('__test.data.interviewSessions.length'), 2, 'Renaming one category must preserve other categories');
  await cdp.click('模拟面试'); await cdp.waitFor("document.body.innerText.includes('模拟面试样例')");
  assert.equal(await cdp.evaluate("document.body.innerText.includes('改名后的真实面试')"), false);
  await cdp.click('笔试记录'); await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('笔试样例')).click()");
  await cdp.waitFor("document.body.innerText.includes('原题 7')");
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('查看原图')).length"), 7);
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('查看原图')).click()");
  await cdp.waitFor("!!document.querySelector('img[alt=\"原题截图 1\"]')"); await cdp.click('放大查看');
  await cdp.evaluate("__view('about')"); await cdp.waitFor("document.body.innerText.includes('Alvin Luo')"); await cdp.click('个人网站');
  assert.ok(await cdp.evaluate("__test.calls.some(c=>c.args?.url==='https://alvin-luo.me')"));
  await cdp.evaluate("__view('ai')"); await cdp.waitFor("document.body.innerText.includes('系统默认语音')");
  await cdp.evaluate("__view('storage')"); await cdp.waitFor("document.body.innerText.includes('<app>/attachments')");
  await cdp.evaluate("(async()=>{window.__deferOpening=true;await __resetOpening();__view('room');})()");
  await cdp.waitFor('window.__openingCalls===1');
  await cdp.evaluate('__refreshOpening()');
  await delay(250);
  assert.equal(await cdp.evaluate('window.__openingCalls'),2,'Refreshing a pending opening must release its request ownership and restart it');
  await cdp.evaluate("__finishOpening('刷新后仍能显示的开场问题')");
  await cdp.waitFor("document.querySelector('.mock-question')?.textContent.includes('刷新后仍能显示的开场问题')");
  // Configure MiMo through the settings UI; networking and audio remain synthetic.
  await cdp.evaluate("__view('ai')");await cdp.waitFor("!!document.getElementById('ai-preset')");
  await cdp.evaluate("(()=>{const select=document.getElementById('ai-preset');select.value='mimo';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await cdp.click('添加连接');await cdp.input('#ai-api-key','synthetic-tts-key');
  await cdp.evaluate("(()=>{const select=document.getElementById('ai-route-tts');select.value=[...select.options].find(option=>option.textContent.includes('mimo-v2.5-tts')).value;select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await cdp.waitFor("document.getElementById('ai-tts-voice')?.value==='苏打'");await cdp.click('保存配置');
  await cdp.waitFor("[...document.querySelectorAll('button')].some(button=>button.textContent==='试听语音'&&!button.disabled)");
  await cdp.click('试听语音');await cdp.waitFor("document.body.innerText.includes('正在连接语音服务')");
  await cdp.click('停止试听');await cdp.waitFor("__ttsCalls.at(-1).init.signal.aborted");
  await cdp.evaluate("(async()=>{await __ttsRoom();__view('room');})()");
  await cdp.waitFor("document.body.innerText.includes('正在准备语音')&&__ttsCalls.length===2");
  await cdp.evaluate("__ttsStream.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{audio:{data:btoa(String.fromCharCode(...new Uint8Array(4800)))}}}]})+'\\n\\n'))");
  await cdp.waitFor("__audioStarts===1&&document.body.innerText.includes('正在提问')");
  assert.equal(await cdp.evaluate('__ttsCalls.at(-1).init.signal.aborted'),false);
  await cdp.evaluate("__ttsStream.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));__ttsStream.close()");
  await cdp.waitFor("!!document.querySelector('button[aria-label=朗读当前问题]')");
  await cdp.evaluate("document.querySelector('button[aria-label=朗读当前问题]').click()");await cdp.waitFor('__audioStarts===2');
  assert.equal(await cdp.evaluate('__ttsCalls.length'),2,'Replaying a completed question must not repeat the cloud request');
  await cdp.evaluate("document.querySelector('button[aria-label=关闭面试官语音]').click()");
  await cdp.waitFor("!!document.querySelector('button[aria-label=开启面试官语音]')");
  await cdp.evaluate("__view('ai')");await cdp.waitFor("!!document.getElementById('ai-preset')");
  await cdp.evaluate("(()=>{const select=document.getElementById('ai-preset');select.value='dashscope-sg';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await cdp.click('添加连接');await cdp.input('#ai-api-key','synthetic-aliyun-key');
  await cdp.evaluate("(()=>{const select=document.getElementById('ai-route-tts');select.value=[...select.options].find(option=>option.textContent.includes('qwen3-tts-flash')).value;select.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await cdp.waitFor("document.getElementById('ai-tts-voice')?.value==='Cherry'");await cdp.click('保存配置');
  await cdp.evaluate("(async()=>{await __ttsRoom();__view('room');})()");
  await cdp.waitFor("document.body.innerText.includes('正在准备语音')&&__ttsCalls.length===3");
  assert.ok(await cdp.evaluate("__ttsCalls.at(-1).url.startsWith('https://dashscope-intl.aliyuncs.com/api/v1/')"));
  await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'我先定位瓶颈，再做对照验证。');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await cdp.click('提交回答');await cdp.waitFor('__ttsCalls.at(-1).init.signal.aborted');
  assert.deepEqual(await cdp.evaluate('__errors'), []);
  // New AI controls use isolated stores and fixed transport replies, without microphone access.
  await cdp.evaluate("__view('prompts')");await cdp.waitFor("document.body.innerText.includes('基础规则')");
  await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'先给结论，再解释取舍。');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await cdp.click('保存本任务');await cdp.waitFor("Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='保存本任务')?.disabled");
  await cdp.evaluate("__view('ai')");await cdp.waitFor("document.body.innerText.includes('模型兼容选项')");
  assert.ok(await cdp.evaluate("document.querySelector('input[aria-label=\"上下文窗口\"]')!==null"));
  await cdp.evaluate("(async()=>{await __engine.startInterview({goalId:null,resumeId:null,materialIds:[],audioSource:'PHONE'});await __engine.answerQuestion('原来的问题');__view('interview');})()");
  await cdp.waitFor("document.body.innerText.includes('更正并重答')");await cdp.click('更正并重答');
  await cdp.waitFor("!!document.querySelector('textarea')");
  await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'更正后的问题');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await cdp.click('更正并重新回答');await cdp.waitFor("document.body.innerText.includes('更正前的参考答案')&&document.body.innerText.includes('更正后的问题')");
  assert.ok(await cdp.evaluate("__engine.getInterviewEngineState().messages.some(message=>message.metadata?.revision===2)"));
  await cdp.click('补充我的实际回答');await cdp.waitFor("!!document.querySelector('textarea')");
  await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'我实际采用本地缓存');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await cdp.click('保存补充');await cdp.waitFor("document.body.innerText.includes('我的实际回答')");
  await cdp.evaluate("__engine.endInterview()");assert.deepEqual(await cdp.evaluate('__errors'),[]);
  // Phone transport uses synthetic sockets, so there is no LAN traffic.
  await cdp.command('Page.enable', {});
  await cdp.command('Page.addScriptToEvaluateOnNewDocument', {source:`window.confirm=()=>true;window.__phone={sent:[]};window.WebSocket=class{constructor(url){this.readyState=1;if(url.includes('/ws?'))__phone.socket=this;setTimeout(()=>this.onopen?.(),0)}send(value){__phone.sent.push(JSON.parse(value))}close(){this.readyState=3;this.onclose?.()}addEventListener(){}};`});
  await cdp.command('Page.navigate',{url:'http://127.0.0.1:1441/src-tauri/src/dual_page.html?token=synthetic'});
  await cdp.waitFor("typeof window.__phone?.socket?.onmessage === 'function'");
  const snapshot = {modeLabel:'快速',turns:Array.from({length:7},(_,i)=>({id:`q${i}`,md:`answer ${i+1}`,tsText:'12:00'})),followUps:[]};
  await cdp.evaluate(`__phone.snapshot=${JSON.stringify(snapshot)};__phone.socket.onmessage({data:JSON.stringify({t:'state',data:__phone.snapshot})})`);
  assert.equal(await cdp.evaluate("document.querySelectorAll('.turn').length"),7);
  await cdp.evaluate("__phone.socket.onmessage({data:JSON.stringify({t:'hover',id:'solve',duration:1200})})");
  assert.equal(await cdp.evaluate("document.querySelector('.dwell-target')?.getAttribute('data-zone')"),'solve');
  await cdp.evaluate("document.getElementById('back').click();__phone.socket.onmessage({data:JSON.stringify({t:'desktop'})})");
  assert.equal(await cdp.evaluate('__phone.socket.readyState'),1);
  assert.equal(await cdp.evaluate("document.getElementById('back').textContent"),'继续副屏');
  await cdp.evaluate("document.getElementById('back').click()"); assert.equal(await cdp.evaluate('__phone.sent.at(-1).t'),'resume');
  await cdp.evaluate("__phone.socket.onmessage({data:JSON.stringify({t:'state',data:__phone.snapshot})});document.getElementById('end').click()");
  assert.equal(await cdp.evaluate('__phone.sent.at(-1).id'),'end-session');
  await cdp.evaluate("__phone.socket.onmessage({data:JSON.stringify({t:'ended'})})"); assert.equal(await cdp.evaluate('__phone.socket.readyState'),3);
  console.log('PASS: task preference save; provider capability controls; question correction UI; actual-answer supplement; mock room/system speech; MiMo and Aliyun voice defaults; cancellable speech preparation; streamed playback; cached replay; answer interrupts speech; separate history; seven source/answer/image records; storage; phone return/resume/end.');
} finally {if(cdp.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser.kill();server.kill();}
