// Real MockApp/React/store, isolated native IO, synthetic microphone and model replies.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp,delay} from './desktop-cdp.mjs';
await mkdir('artifacts',{recursive:true});
await writeFile('artifacts/mock-room-microphone.ts',`export const openMicrophone=options=>window.__openMic(options);`);
await writeFile('artifacts/mock-room-vite.config.mjs',`import base from '../vite.config.ts';import{fileURLToPath}from'node:url';
export default()=>{const config=base();return {...config,cacheDir:'node_modules/.vite-mock-room',plugins:[...config.plugins,{name:'mock-test-transport',enforce:'pre',transform(_code,id){if(id.replaceAll('\\\\','/').endsWith('/src/lib/aiTransport.ts'))return {code:'export const aiFetch=(url,init)=>window.__fetch(url,init);',map:null};}}],resolve:{...config.resolve,alias:{'@/lib/microphone':fileURLToPath(new URL('./mock-room-microphone.ts',import.meta.url)),...config.resolve.alias}}};};`);
await writeFile('artifacts/mock-room-fixture.html',`<!doctype html><html><meta charset="utf-8"><div id="root"></div><script>
window.__errors=[];addEventListener('error',e=>__errors.push(e.message));addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));
window.__micStarts=0;window.__micCloses=0;window.__openMic=async options=>{__micStarts++;if(window.__micFail){window.__micFail=false;throw Error('合成启动失败');}window.__mic=options;return {close:async()=>{__micCloses++;},setPaused:async()=>{}};};
window.__sttCalls=0;window.__fetch=async(url,init)=>{if(url.endsWith('/audio/transcriptions')){__sttCalls++;return new Promise(resolve=>{window.__finishStt=(fail=false)=>resolve(new Response(JSON.stringify(fail?{error:{message:'合成识别失败'}}:{text:'真实候选人回答'+__sttCalls}),{status:fail?500:200,headers:{'content-type':'application/json'}}));});}return new Response(JSON.stringify({choices:[{message:{content:window.__modelReply||JSON.stringify({question:'你如何验证优化效果？',kind:'CONT'})},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});};
window.__test={callbacks:new Map(),events:new Map(),data:{},settings:{'mock.speechEnabled':false},revision:0};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'mock'},currentWebview:{label:'mock'}},transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),invoke:async(name,args)=>{
if(name==='plugin:event|listen'){__test.events.set(args.event,args.handler);return args.handler;}
if(name==='plugin:store|load')return 1;
if(name==='plugin:store|get')return [__test.settings[args.key],Object.hasOwn(__test.settings,args.key)];
if(name==='plugin:store|set'){__test.settings[args.key]=args.value;return;}
if(name==='cmd_data_commit'){__test.data[args.key]=args.value;return {revision:++__test.revision,data:__test.data};}
if(name==='cmd_data_read')return {revision:__test.revision,data:__test.data};return null;}};
</script><script type="module" src="/artifacts/mock-room-fixture.tsx"></script></html>`);
await writeFile('artifacts/mock-room-fixture.tsx',`import React from 'react';import{createRoot}from'react-dom/client';import '/src/index.css';import{MockApp}from'/src/mock/MockApp.tsx';
import{writeData}from'/src/lib/backend.ts';import{saveAiSettings}from'/src/lib/aiSettings.ts';import{defaultAiSettings}from'/src/lib/aiConfig.ts';
await saveAiSettings({...defaultAiSettings(),providers:[{id:'fixture',name:'测试连接',baseUrl:'http://127.0.0.1:9/v1',apiKey:'',authMode:'none',models:[{id:'test-chat',source:'custom'},{id:'whisper-1',source:'custom'}],lastFetchedAt:null}],routes:{chat:{providerId:'fixture',modelId:'test-chat'},vision:null,stt:{providerId:'fixture',modelId:'whisper-1'},tts:null},speechInputMode:'file'});
await writeData('interviewSessions',[{id:'mock',type:'MOCK_INTERVIEW',title:'合成测试',createdAt:Date.now(),status:'ACTIVE',messages:[{id:'opening',role:'INTERVIEWER',text:'请介绍你最熟悉的项目。',createdAt:Date.now(),metadata:{turnKind:'NEW'}}],metadata:{mock:true,config:{goalName:'后端开发',difficultyLabel:'3–5年',turnBudget:8,basicsRatio:40,assistMode:false}}}]);
window.__setQuestion=text=>writeData('interviewSessions',__test.data.interviewSessions.map(session=>({...session,messages:[{...session.messages[0],text}]})));
createRoot(document.getElementById('root')).render(<MockApp/>);`);
const url='http://127.0.0.1:1442/artifacts/mock-room-fixture.html#mock?sid=mock';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/mock-room-vite.config.mjs','--host','127.0.0.1','--port','1442','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser,cdp;
try {
  let ready=false;
  for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Mock room test server exited');try{if((await fetch(url)).ok){ready=true;break;}}catch{}await delay(100);}
  assert.ok(ready);
  const profile=await mkdtemp(path.resolve('artifacts/mock-room-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run','--no-default-browser-check',`--user-data-dir=${profile}`,'--remote-debugging-port=19402',url],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19402,'mock');await cdp.connect();await cdp.waitFor("!!document.querySelector('.mock-question')");
  const failures=[];
  async function check(name,fn){try{await fn();console.log('PASS:',name);}catch(error){failures.push(name+': '+error.message);console.error('FAIL:',name,error.message);}}
  const space=()=>cdp.evaluate("document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true,cancelable:true}))");
  const isRecording="[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='结束录音')";
  const isReady="[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='空格说话'&&!b.disabled)";
  await check('Space works across three recording/transcription cycles, including recognition failure',async()=>{
    for(let round=1;round<=3;round++){
      await space();await cdp.waitFor(isRecording);
      await cdp.evaluate('__mic.onPcm(new Int16Array(8000).fill(1200),20)');await space();await cdp.waitFor(`__sttCalls===${round}`);
      await space();assert.equal(await cdp.evaluate('__micStarts'),round,'Space during transcription must not start another microphone');
      await cdp.evaluate(`__finishStt(${round===2})`);await cdp.waitFor(isReady);
    }
    assert.equal(await cdp.evaluate('__micStarts'),3);assert.equal(await cdp.evaluate('__micCloses'),3);
    assert.equal(await cdp.evaluate('__test.data.interviewSessions[0].messages.length'),1,'Recognition must fill a draft, never submit a candidate answer or let the interviewer continue automatically');
    assert.match(await cdp.evaluate("document.querySelector('textarea').value"),/真实候选人回答1.*真实候选人回答3/);
  });
  // Recover from a failed pre-fix shortcut so the independent layout test still runs.
  await cdp.evaluate('window.__previousDocument=true');await cdp.command('Page.reload',{});await cdp.waitFor(`!window.__previousDocument&&(${isReady})`);
  await check('Text inputs, held keys, shortcuts with modifiers and the end dialog cannot toggle recording',async()=>{
    await cdp.evaluate(`(()=>{const before=__micStarts;const input=document.querySelector('textarea');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true}));input.blur();for(const extra of [{repeat:true},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{isComposing:true}])document.body.dispatchEvent(new KeyboardEvent('keydown',{code:'Space',key:' ',bubbles:true,...extra}));window.__startsBefore=before;})()`);
    assert.equal(await cdp.evaluate('__micStarts'),await cdp.evaluate('__startsBefore'));
    await cdp.click('结束面试');await space();assert.equal(await cdp.evaluate('__micStarts'),await cdp.evaluate('__startsBefore'));
    await cdp.click('取消');await cdp.evaluate('window.__micFail=true');await space();await cdp.waitFor("document.body.innerText.includes('语音输入启动失败')");await cdp.waitFor(isReady);
    await space();await cdp.waitFor(isRecording);await space();await cdp.waitFor(isReady);
  });
  await check('Long questions and unbroken text remain scrollable without hiding answer controls',async()=>{
    const question='请结合你的经历说明设计依据、关键约束和验证过程。'.repeat(100)+'X'.repeat(1000);
    await cdp.evaluate(`__setQuestion(${JSON.stringify(question)})`);
    for(const [width,height] of [[1280,850],[860,640],[800,600]]){
      await cdp.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(100);
      const box=await cdp.evaluate(`(()=>{const question=document.querySelector('.mock-question'),footer=document.querySelector('.mock-response'),button=[...footer.querySelectorAll('button')].at(-1);const q=question.getBoundingClientRect(),f=footer.getBoundingClientRect(),b=button.getBoundingClientRect();return {questionBottom:q.bottom,footerTop:f.top,buttonBottom:b.bottom,pageWidth:document.documentElement.scrollWidth,scrollable:question.scrollHeight>question.clientHeight&&['auto','scroll'].includes(getComputedStyle(question).overflowY)};})()`);
      assert.ok(box.questionBottom<=box.footerTop+1,`Question overlaps footer at ${width}x${height}: ${JSON.stringify(box)}`);
      assert.ok(box.buttonBottom<=height,`Submit is outside viewport at ${width}x${height}`);
      assert.ok(box.pageWidth<=width,`Unbroken text causes horizontal overflow at ${width}x${height}`);
      assert.ok(box.scrollable,'The whole long question must remain accessible by scrolling');
    }
    const screenshot=await cdp.command('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/mock-room-long-question.png',Buffer.from(screenshot.data,'base64'));
  });
  await check('A model self-answer cannot become an interviewer question, and retry preserves the real answer',async()=>{
    await cdp.evaluate(`__setQuestion('请介绍项目。');window.__modelReply=JSON.stringify({question:'请介绍你自己。\\n你好，我是 AI 助手，没有真实项目经历。',kind:'NEW'});`);
    await cdp.evaluate("(()=>{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'我负责订单系统。');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await cdp.click('提交回答');await cdp.waitFor("document.body.innerText.includes('重试出题')");
    assert.equal(await cdp.evaluate('__test.data.interviewSessions[0].messages.length'),2);
    assert.equal(await cdp.evaluate("document.querySelector('.mock-question').textContent.includes('我是 AI 助手')"),false);
    assert.equal(await cdp.evaluate('__test.data.interviewSessions[0].messages.at(-1).text'),'我负责订单系统。');
    await cdp.evaluate('window.__modelReply=null');await cdp.click('重试出题');await cdp.waitFor("document.querySelector('.mock-question').textContent.includes('你如何验证优化效果？')");
    assert.equal(await cdp.evaluate("__test.data.interviewSessions[0].messages.filter(m=>m.role==='ASSISTANT').length"),1,'Retry must not duplicate the real candidate answer');
  });
  assert.deepEqual(await cdp.evaluate('__errors'),[]);
  assert.deepEqual(failures,[]);
}finally{if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.kill();}
