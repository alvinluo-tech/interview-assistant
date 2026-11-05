// Real assistant-ui/React handlers; isolated synthetic storage and model, never user data.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp,delay} from '../desktop-cdp.mjs';

await mkdir('artifacts/audit',{recursive:true});
await writeFile('artifacts/audit/chat.config.mjs',`import base from '../../vite.config.ts';export default()=>{const c=base();return {...c,cacheDir:'node_modules/.vite-chat-audit',plugins:[...c.plugins,{name:'chat-test-drivers',enforce:'pre',transform(code,id){if(id.endsWith('/src/lib/aiTransport.ts'))return {code:'export const aiFetch=(url,init)=>window.__fetch(url,init);',map:null};if(id.endsWith('/src/lib/microphone.ts'))return {code:'export const openMicrophone=async options=>{window.__mic=options;return {close:async()=>{}};};',map:null};}}]};};`);
await writeFile('artifacts/audit/chat.html',`<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.__test={data:{},settings:{},revision:0,callbacks:new Map(),requests:[],errors:[],responses:[]};
addEventListener('error',e=>__test.errors.push(e.message));addEventListener('unhandledrejection',e=>__test.errors.push(String(e.reason)));
window.__fetch=async(url,init)=>{const body=JSON.parse(init.body);__test.requests.push({body,signal:init.signal});
if(window.__defer)return new Promise((resolve,reject)=>{window.__late=()=>resolve(new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'迟到的私密回答'}}]}),{headers:{'content-type':'application/json'}}));init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});});
const response=__test.responses.shift();if(response==='error')return new Response('{}',{status:503});
return new Response(JSON.stringify(response||{choices:[{finish_reason:'stop',message:{content:'合成正常回答'}}]}),{headers:{'content-type':'application/json'}});};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:fn=>{const id=__test.callbacks.size+1;__test.callbacks.set(id,fn);return id;},unregisterCallback:id=>__test.callbacks.delete(id),invoke:async(name,args)=>{
if(name==='plugin:store|load')return 1;if(name==='plugin:store|get')return [__test.settings[args.key],Object.hasOwn(__test.settings,args.key)];if(name==='plugin:store|set'){__test.settings[args.key]=args.value;return;}
if(name==='plugin:event|listen')return args.handler;
if(name==='cmd_data_commit'){__test.data[args.key]=args.value;return {revision:++__test.revision,data:__test.data};}if(name==='cmd_data_read')return {revision:__test.revision,data:__test.data};return null;}};
</script><script type="module" src="/artifacts/audit/chat.tsx"></script>`);
await writeFile('artifacts/audit/chat.tsx',`import React from'react';import{createRoot}from'react-dom/client';import'/src/index.css';import{FreeChatPage}from'/src/main/sections/FreeChatPage.tsx';import{writeData}from'/src/lib/backend.ts';import{saveAiSettings}from'/src/lib/aiSettings.ts';import{defaultAiSettings}from'/src/lib/aiConfig.ts';
await saveAiSettings({...defaultAiSettings(),providers:[{id:'p',name:'合成服务',baseUrl:'http://127.0.0.1:9/v1',authMode:'none',apiKey:'',models:[{id:'test-chat',source:'custom'},{id:'whisper-1',source:'custom'}]}],routes:{chat:{providerId:'p',modelId:'test-chat'},vision:null,stt:{providerId:'p',modelId:'whisper-1'},tts:null},speechInputMode:'file'});
await writeData('freeChats',[{id:'legacy',title:'旧协议记录',messages:[{role:'user',content:'旧问题'},{role:'assistant',content:'< | | DSML | | calls>内部语法'}],updatedAt:1}]);
await writeData('resumes',[{id:'r1',title:'测试简历',content:'简历正文标记',createdAt:1}]);await writeData('examSessions',[{id:'e1',title:'未授权笔试',questions:[{id:'q1',answer:'不可发送的笔试正文'}],createdAt:1}]);
createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="p-7"><FreeChatPage/></div></React.StrictMode>);`);

const origin='http://127.0.0.1:1448',url=origin+'/artifacts/audit/chat.html';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/audit/chat.config.mjs','--host','127.0.0.1','--port','1448','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser,cdp;const results=[];
const tool=(name,args,id='c1')=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=calls=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:calls}}]});
const click=label=>cdp.evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
const edit=value=>cdp.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const allow=()=>cdp.evaluate("Array.from(document.querySelectorAll('label')).find(e=>e.textContent==='允许查询本地资料').querySelector('input').click()");
const waitIdle=()=>cdp.waitFor("Array.from(document.querySelectorAll('button')).some(e=>e.textContent==='语音通话'&&!e.disabled)");
const waitAnswer=question=>cdp.waitFor(`__test.data.freeChats[0]?.messages.at(-2)?.content===${JSON.stringify(question)} && __test.data.freeChats[0]?.messages.at(-1)?.content==='合成正常回答'`);
async function probe(id,fn){await fn();results.push({id,verdict:'pass'});console.log('PASS '+id);}
try{
  let ready=false;for(let i=0;i<300;i++){if(server.exitCode!==null)throw Error('Chat audit server exited');try{if((await fetch(url)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const profile=await mkdtemp(path.resolve('artifacts/chat-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19412',url],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19412,'main');await cdp.connect();await cdp.waitFor("!!document.querySelector('textarea')");
  await cdp.command('Emulation.setDeviceMetricsOverride',{width:1180,height:900,deviceScaleFactor:1,mobile:false});
  await probe('C01 old leaked tool syntax is replaced at display without rewriting stored history',async()=>{
    await cdp.click('旧协议记录');await cdp.waitFor("document.body.innerText.includes('这条历史回答包含无效')");
    assert.equal(await cdp.evaluate("document.body.innerText.includes('DSML')"),false);
    assert.match(await cdp.evaluate('__test.data.freeChats[0].messages[1].content'),/DSML/);
  });
  await probe('C02 provider failures remain visible, persist and retry the same user turn',async()=>{
    await cdp.click('新对话');await cdp.evaluate("__test.responses=['error']");await edit('失败后重试测试');await click('发送');
    await cdp.waitFor("document.querySelector('[role=alert]')?.textContent.includes('503')");
    await cdp.waitFor("__test.data.freeChats[0].messages.at(-1).status==='failed'");
    await cdp.click('新对话');await cdp.click('失败后重试测试');await cdp.waitFor("document.querySelector('[role=alert]')?.textContent.includes('503')");
    await cdp.click('重试回答');await waitAnswer('失败后重试测试');
    assert.equal(await cdp.evaluate("__test.data.freeChats[0].messages.filter(m=>m.role==='user').length"),1);
    assert.equal(await cdp.evaluate("__test.requests.at(-1).body.messages.some(m=>m.content.includes('503'))"),false);
  });
  await probe('C03 local authorization exposes only selected categories and records actual queries',async()=>{
    await cdp.click('新对话');await cdp.evaluate("Array.from(document.querySelectorAll('summary')).find(e=>e.textContent==='查询范围与数据说明').click();for(const label of document.querySelectorAll('label'))if(['岗位','面试资料','面试记录','笔试记录'].includes(label.textContent.trim()))label.querySelector('input').click()");await delay(80);
    await allow();await cdp.evaluate(`__test.responses=${JSON.stringify([response([tool('read_local_record',{category:'resumes',id:'r1',offset:0}),tool('read_local_record',{category:'exams',id:'e1',offset:0},'c2')])])}`);
    await edit('分析选定的简历');await click('发送');await waitAnswer('分析选定的简历');
    const wire=await cdp.evaluate('__test.requests.at(-1).body');assert.doesNotMatch(JSON.stringify(wire),/不可发送的笔试正文/);assert.match(JSON.stringify(wire),/简历正文标记/);assert.match(JSON.stringify(wire),/未授权/);
    const queries=await cdp.evaluate('__test.data.freeChats[0].messages.at(-1).queries');assert.equal(queries.length,2);assert.equal(queries[0].title,'测试简历');assert.equal(queries[1].status,'error');
    await cdp.waitFor("document.body.innerText.includes('本次查询记录（2）')");
    const permitted=wire.tools.find(t=>t.function.name==='read_local_record').function.parameters.properties.category.enum;assert.deepEqual(permitted,['resumes']);
  });
  await probe('C04 authorization can be revoked during a request and late content is suppressed',async()=>{
    await cdp.evaluate('window.__defer=true');await edit('等待中撤销');await click('发送');await cdp.waitFor("typeof __late==='function'");
    assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('label')).find(e=>e.textContent==='允许查询本地资料').querySelector('input').disabled"),false);
    await allow();await cdp.waitFor('__test.requests.at(-1).signal.aborted');await cdp.evaluate('__late();window.__defer=false');await delay(150);
    assert.equal(await cdp.evaluate("document.body.innerText.includes('迟到的私密回答')"),false);await edit('撤销后继续对话');await click('发送');await waitAnswer('撤销后继续对话');
    assert.equal(await cdp.evaluate("'tools' in __test.requests.at(-1).body"),false);
  });
  await probe('C05 returning from voice retains this conversation grant, switching conversations revokes it',async()=>{
    await waitIdle();await allow();await cdp.click('语音通话');await cdp.waitFor("document.body.innerText.includes('正在聆听')");await cdp.click('结束通话');await cdp.waitFor("!document.querySelector('[role=dialog]')");
    await delay(100);assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('label')).find(e=>e.textContent==='允许查询本地资料').querySelector('input').checked"),true);
    await cdp.click('新对话');assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('label')).find(e=>e.textContent==='允许查询本地资料').querySelector('input').checked"),false);
  });
  await probe('C06 text reply disables manual microphone and switching away aborts pending work',async()=>{
    await cdp.evaluate('window.__defer=true;window.__late=null');await edit('切换会话取消');await click('发送');await cdp.waitFor("typeof __late==='function'");
    assert.equal(await cdp.evaluate("document.querySelector('button[aria-label=语音输入]').disabled"),true);
    await cdp.click('新对话');await cdp.waitFor('__test.requests.at(-1).signal.aborted');await cdp.evaluate('__late();window.__defer=false');await delay(100);
    assert.equal(await cdp.evaluate("document.body.innerText.includes('迟到的私密回答')"),false);
  });
  await probe('C07 malformed output without local authorization yields a retryable error, no raw syntax',async()=>{
    const leak={choices:[{finish_reason:'stop',message:{content:'< | | DSML | | calls>内部协议'}}]};await cdp.evaluate(`__test.responses=[${JSON.stringify(leak)}]`);await edit('普通对话协议泄漏');await click('发送');
    await cdp.waitFor("document.querySelector('[role=alert]')?.textContent.includes('工具标记')");assert.equal(await cdp.evaluate("document.body.innerText.includes('DSML')"),false);
    await cdp.click('重试回答');await waitAnswer('普通对话协议泄漏');
  });
  await probe('C09 a voice failure is saved as a failed turn and can be retried as text',async()=>{
    await waitIdle();await cdp.click('新对话');await cdp.evaluate("__test.responses=['error']");await cdp.click('语音通话');await cdp.waitFor("document.body.innerText.includes('正在聆听')");
    // Supply recognized text through the same transcription transport, then a model failure.
    await cdp.evaluate(`window.__fetchOld=window.__fetch;window.__fetch=async(url,init)=>url.endsWith('/audio/transcriptions')?new Response(JSON.stringify({text:'语音失败测试'}),{headers:{'content-type':'application/json'}}):window.__fetchOld(url,init);__mic.onPcm(new Int16Array(16000),20);__mic.onPcm(new Int16Array(20000),0)`);
    await cdp.waitFor("!document.querySelector('[role=dialog]') && document.querySelector('[role=alert]')?.textContent.includes('503')");
    assert.equal(await cdp.evaluate('__test.data.freeChats[0].messages.at(-1).status'),'failed');await cdp.click('重试回答');await waitAnswer('语音失败测试');
  });
  await probe('C10 voice authorization has an explicit revoke action in the dialog',async()=>{
    await waitIdle();await allow();await cdp.click('语音通话');await cdp.waitFor("document.body.innerText.includes('正在聆听')");
    await cdp.click('关闭资料查询并结束通话');await cdp.waitFor("!document.querySelector('[role=dialog]')");await delay(100);
    assert.equal(await cdp.evaluate("Array.from(document.querySelectorAll('label')).find(e=>e.textContent==='允许查询本地资料').querySelector('input').checked"),false);
  });
  await probe('C11 Enter during manual recording cannot send unfinished voice input',async()=>{
    await click('语音输入');await cdp.waitFor("!!document.querySelector('button[aria-label=结束录音]')");await edit('正在录音的草稿');
    const before=await cdp.evaluate('__test.requests.length');await cdp.evaluate("document.querySelector('textarea').focus()");await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await delay(100);
    assert.equal(await cdp.evaluate('__test.requests.length'),before);await click('结束录音');await cdp.waitFor("document.body.innerText.includes('录音太短')");
  });
  await probe('C12 malformed imported query receipts do not break historical rendering',async()=>{
    await cdp.evaluate(`import('/src/lib/backend.ts').then(m=>m.writeData('freeChats',[{id:'bad-receipts',title:'查询元数据兼容测试',updatedAt:100,messages:[{role:'user',content:'历史问题'},{role:'assistant',content:'历史回答仍可阅读',queries:[null,{name:'wrong-tool',status:'success'}]}]},...__test.data.freeChats]))`);
    await cdp.click('查询元数据兼容测试');await cdp.waitFor("document.body.innerText.includes('历史回答仍可阅读')");assert.equal(await cdp.evaluate("document.body.innerText.includes('本次查询记录（')"),false);
  });
  await probe('C08 no unhandled browser errors',async()=>{assert.deepEqual(await cdp.evaluate('__test.errors'),[]);});
  const screenshot=await cdp.command('Page.captureScreenshot',{format:'png'});await writeFile('artifacts/audit/free-chat-boundaries.png',Buffer.from(screenshot.data,'base64'));
}finally{
  await writeFile('artifacts/audit/free-chat-boundaries.json',JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
  if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.kill();
}
