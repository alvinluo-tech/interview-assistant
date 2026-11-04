// Real UI and React handlers with synthetic native storage, microphone and model transport.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp,delay} from '../desktop-cdp.mjs';
await mkdir('artifacts/audit',{recursive:true});
await writeFile('artifacts/audit/microphone.ts',`export const openMicrophone=options=>window.__openMic(options);`);
await writeFile('artifacts/audit/vite.config.mjs',`import base from '../../vite.config.ts';import{fileURLToPath}from'node:url';export default()=>{const c=base();return {...c,cacheDir:'node_modules/.vite-audit',plugins:[...c.plugins,{name:'audit-transport',enforce:'pre',transform(_code,id){if(id.endsWith('/src/lib/aiTransport.ts'))return {code:'export const aiFetch=(url,init)=>window.__fetch(url,init);',map:null};}}],resolve:{...c.resolve,alias:{'@/lib/microphone':fileURLToPath(new URL('./microphone.ts',import.meta.url)),...c.resolve.alias}}};};`);
await writeFile('artifacts/audit/ui.html',`<!doctype html><meta charset="utf-8"><div id="root"></div><script>
window.__audit={errors:[],events:new Map(),callbacks:new Map(),data:{},settings:{},revision:0,mics:0,micStarts:0,requests:[],failWrites:false};
addEventListener('error',e=>__audit.errors.push(e.message));addEventListener('unhandledrejection',e=>__audit.errors.push(String(e.reason)));
window.__openMic=async options=>{__audit.mics++;__audit.micStarts++;__audit.mic=options;let closed=false;return {close:async()=>{if(!closed){closed=true;__audit.mics--;}}};};
window.__fetch=async(url,init)=>{__audit.requests.push({url,body:typeof init.body==='string'?JSON.parse(init.body):null,signal:init.signal});if(url.endsWith('/audio/transcriptions'))return new Promise(resolve=>{window.__finishStt=()=>resolve(new Response(JSON.stringify({text:'识别出来的文字'}),{headers:{'content-type':'application/json'}}));});if(window.__deferChat)return new Promise((resolve,reject)=>{window.__finishChat=text=>resolve(new Response(JSON.stringify({choices:[{message:{content:text},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}}));init.signal.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});});return new Response(JSON.stringify({choices:[{message:{content:window.__bankReply||'合成回答：可以从项目约束开始分析。'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});};
window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:fn=>{const id=__audit.callbacks.size+1;__audit.callbacks.set(id,fn);return id;},unregisterCallback:id=>__audit.callbacks.delete(id),invoke:async(name,args)=>{
if(name==='plugin:store|load')return 1;if(name==='plugin:store|get')return [__audit.settings[args.key],Object.hasOwn(__audit.settings,args.key)];if(name==='plugin:store|set'){__audit.settings[args.key]=args.value;return;}
if(name==='plugin:event|listen'){const set=__audit.events.get(args.event)||new Set();set.add(args.handler);__audit.events.set(args.event,set);return args.handler;}if(name==='plugin:event|unlisten'){__audit.events.get(args.event)?.delete(args.eventId);return;}
if(name==='cmd_data_commit'){if(__audit.failWrites)throw Error('synthetic disk full');__audit.data[args.key]=args.value;return {revision:++__audit.revision,data:__audit.data};}if(name==='cmd_data_read')return {revision:__audit.revision,data:__audit.data};return null;}};
</script><script type="module" src="/artifacts/audit/ui.tsx"></script>`);
await writeFile('artifacts/audit/startup.html',(await readFile('artifacts/audit/ui.html','utf8')).replace('failWrites:false','failWrites:true').replace('/artifacts/audit/ui.tsx','/src/main.tsx'));
await writeFile('artifacts/audit/ui.tsx',`import React,{useState}from'react';import{createRoot}from'react-dom/client';import'/src/index.css';import{FreeChatPage}from'/src/main/sections/FreeChatPage.tsx';import{RecordsPage}from'/src/main/sections/RecordsPage.tsx';import{ExamWorkbench}from'/src/main/sections/ExamWorkbench.tsx';import{ResourcePage}from'/src/main/sections/ResourcePage.tsx';import{QuestionBankPage}from'/src/main/sections/QuestionBankPage.tsx';import{ErrorBoundary}from'/src/ErrorBoundary.tsx';import{Md}from'/src/overlay/Md.tsx';import{ToastViewport}from'/src/ui/primitives.tsx';import{writeData}from'/src/lib/backend.ts';import{saveAiSettings}from'/src/lib/aiSettings.ts';import{defaultAiSettings}from'/src/lib/aiConfig.ts';window.__errors=__audit.errors;
await saveAiSettings({...defaultAiSettings(),providers:[{id:'p',name:'合成连接',baseUrl:'http://127.0.0.1:9/v1',authMode:'none',apiKey:'',models:[{id:'test-chat',source:'custom'},{id:'whisper-1',source:'custom'}]}],routes:{chat:{providerId:'p',modelId:'test-chat'},vision:null,stt:{providerId:'p',modelId:'whisper-1'},tts:null},speechInputMode:'file'});
await writeData('freeChats',[]);window.__seed=(key,value)=>writeData(key,value);window.__md='';
function Fixture(){const[view,setView]=useState('chat');window.__view=setView;return <div className="p-7"><button onClick={()=>setView('chat')}>测试导航</button>{view==='chat'?<FreeChatPage/>:view==='resources'?<ResourcePage/>:view==='bank'?<QuestionBankPage/>:view==='exam'?<ExamWorkbench onNavigate={()=>{}}/>:view==='md'?<Md text={window.__md}/>:<RecordsPage/>}<ToastViewport/></div>;}createRoot(document.getElementById('root')).render(<ErrorBoundary scene="main"><Fixture/></ErrorBoundary>);`);
const url='http://127.0.0.1:1444/artifacts/audit/ui.html';
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--config','artifacts/audit/vite.config.mjs','--host','127.0.0.1','--port','1444','--strictPort'],{windowsHide:true,stdio:'ignore'});
let browser,cdp;const results=[];
async function probe(id,invariant,fn){try{const result=await fn();results.push({id,invariant,...result});console.log(`${result.verdict.toUpperCase()} ${id}: ${JSON.stringify(result.observed)}`);}catch(error){results.push({id,invariant,verdict:'probe-error',observed:String(error.stack||error)});console.error('PROBE ERROR',id,error.message);}}
try{
  let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Audit Vite exited');try{if((await fetch(url)).ok){ready=true;break;}}catch{}await delay(100);}assert.ok(ready);
  const profile=await mkdtemp(path.resolve('artifacts/audit-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19404',url],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19404,'main');await cdp.connect();await cdp.waitFor("!!document.querySelector('textarea')");
  await cdp.command('Emulation.setDeviceMetricsOverride',{width:1180,height:760,deviceScaleFactor:1,mobile:false});
  const edit=text=>cdp.evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click=label=>cdp.evaluate(`document.querySelector('button[aria-label=${JSON.stringify(label)}]').click()`);
  await probe('B01','A completed text reply is persisted with the actual user message',async()=>{
    await edit('请分析项目约束');await click('发送');await cdp.waitFor("__audit.data.freeChats[0]?.messages.length===2");
    assert.equal(await cdp.evaluate('__audit.data.freeChats[0].messages[0].content'),'请分析项目约束');
    return {verdict:'pass',observed:{savedMessages:await cdp.evaluate('__audit.data.freeChats[0].messages.length')}};
  });
  await probe('B02','Cancelling a pending reply aborts the transport and preserves only the submitted user message',async()=>{
    await cdp.click('新对话');await cdp.evaluate('window.__deferChat=true');await edit('取消测试');await click('发送');await cdp.waitFor("typeof __finishChat==='function'");
    await click('停止生成');await cdp.waitFor('__audit.requests.at(-1).signal.aborted');await delay(100);
    assert.equal(await cdp.evaluate('__audit.data.freeChats[0].messages.length'),1);await cdp.evaluate('window.__deferChat=false');
    return {verdict:'pass',observed:{aborted:true,savedMessages:1}};
  });
  await probe('B03','The voice dialog must retain keyboard focus instead of exposing background actions',async()=>{
    await cdp.click('语音通话');await cdp.waitFor("document.body.innerText.includes('正在聆听')");
    await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    const observed=await cdp.evaluate(`({focusInside:document.querySelector('[role=dialog]').contains(document.activeElement),focusedTag:document.activeElement.tagName,focusedText:document.activeElement.textContent?.slice(0,30)})`);
    return {verdict:observed.focusInside?'pass':'finding',observed};
  });
  await probe('B04','An active voice call must not allow a second background recording',async()=>{
    for(let i=0;i<30;i++){
      if(await cdp.evaluate("document.activeElement.getAttribute('aria-label')==='语音输入'"))break;
      await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});await cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
    }
    const disabled=await cdp.evaluate("document.querySelector('button[aria-label=语音输入]').disabled");
    if(disabled)await cdp.evaluate("document.querySelector('button[aria-label=语音输入]').click()");
    else{await cdp.command('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32});await cdp.command('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32});}
    await delay(100);
    const activeMicrophones=await cdp.evaluate('__audit.mics');
    await cdp.evaluate("document.querySelector('.voice-end').click()");await cdp.waitFor("!document.querySelector('[role=dialog]')");await delay(100);
    assert.equal(await cdp.evaluate('__audit.mics'),0);
    await cdp.evaluate("document.querySelector('button[aria-label=语音输入]').click()");await cdp.waitFor('__audit.mics===1');
    const callDisabled=await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='语音通话').disabled");
    await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='语音通话').click()");assert.equal(await cdp.evaluate('__audit.mics'),1);
    await cdp.evaluate("document.querySelector('button[aria-label=结束录音]').click()");await cdp.waitFor('__audit.mics===0');
    return {verdict:activeMicrophones===1&&disabled&&callDisabled?'pass':'finding',observed:{activeMicrophones,backgroundRecordingDisabled:disabled,callDisabledDuringManualRecording:callDisabled,remainingAfterEnd:0}};
  });
  await probe('B05','Editing a draft while transcription is pending must not be overwritten by the old draft',async()=>{
    await edit('初始草稿');await click('语音输入');await cdp.waitFor('__audit.mics===1');await cdp.evaluate('__audit.mic.onPcm(new Int16Array(16000),25)');await click('结束录音');await cdp.waitFor("typeof __finishStt==='function'");
    await edit('等待识别时的新编辑');await cdp.evaluate('__finishStt()');await cdp.waitFor("document.querySelector('textarea').value.includes('识别出来的文字')");
    const text=await cdp.evaluate("document.querySelector('textarea').value");return {verdict:text.includes('等待识别时的新编辑')?'pass':'finding',observed:{draft:text}};
  });
  await probe('B06','Failed initial chat persistence must prevent the model request and keep a visible error',async()=>{
    await cdp.click('新对话');const before=await cdp.evaluate('__audit.requests.length');await cdp.evaluate('__audit.failWrites=true');await edit('不能丢失的输入');await click('发送');await cdp.waitFor("document.body.innerText.includes('对话保存失败')");
    assert.equal(await cdp.evaluate('__audit.requests.length'),before);await cdp.evaluate('__audit.failWrites=false');
    return {verdict:'pass',observed:{modelRequestsAfterSaveFailure:0,errorVisible:true}};
  });
  await probe('B10','Resource creation and a real PDF import preserve local text without a model request',async()=>{
    await cdp.evaluate("__view('resources')");await cdp.click('新建岗位');await cdp.input('input[placeholder="岗位名称"]','合成后端岗位');await cdp.click('保存');await cdp.waitFor("__audit.data.goals?.length===1");
    const content='BT /F1 12 Tf 50 750 Td (Synthetic resume: Java engineer, order service, local evidence.) Tj ET';
    const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
    let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const before=await cdp.evaluate('__audit.requests.length');
    await cdp.evaluate(`(()=>{const f=new File([Uint8Array.from(atob(${JSON.stringify(Buffer.from(pdf).toString('base64'))}),c=>c.charCodeAt(0))],'synthetic-resume.pdf',{type:'application/pdf'});const dt=new DataTransfer();dt.items.add(f);const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await cdp.waitFor("document.querySelector('textarea[aria-label=文档正文]')?.value.includes('Synthetic resume')");await cdp.click('确认正文并保存');await cdp.waitFor("__audit.data.resumes?.length===1");
    assert.equal(await cdp.evaluate('__audit.requests.length'),before);assert.equal(await cdp.evaluate('__audit.data.resumes[0].document.method'),'pdf');
    return {verdict:'pass',observed:{goalCreated:true,realPdfTextSaved:true,modelRequestsForPdf:0}};
  });
  await probe('B11','A failed resource save must provide a user-visible failure rather than only an unhandled rejection',async()=>{
    await cdp.click('新建岗位');await cdp.input('input[placeholder="岗位名称"]','不能保存的岗位');await cdp.evaluate('__audit.failWrites=true');const before=await cdp.evaluate('__audit.errors.length');await cdp.click('保存');await delay(150);
    const observed=await cdp.evaluate(`({unhandledRejection:__audit.errors.length>${before},errorVisible:[...document.querySelectorAll('[role=alert]')].some(e=>/保存失败|disk full/.test(e.textContent)),savedGoals:__audit.data.goals.length,draftPresent:document.querySelector('input[placeholder=岗位名称]').value==='不能保存的岗位'})`);
    await cdp.evaluate('__audit.failWrites=false');await cdp.click('保存');await cdp.waitFor('__audit.data.goals.length===2');return {verdict:observed.errorVisible&&!observed.unhandledRejection&&observed.draftPresent?'pass':'finding',observed:{...observed,retriedSuccessfully:true}};
  });
  await probe('B12','Question-bank generation, favorites and saving reference answers retain model origin',async()=>{
    await cdp.evaluate(`window.__bankReply=JSON.stringify({questions:[{question:'合成题：如何设计缓存？',answer:'合成参考答案。',category:'job_skill',probability:'high'}]});__view('bank')`);await cdp.click('生成我的面试准备');await cdp.waitFor("document.body.innerText.includes('合成题：如何设计缓存？')");
    await cdp.evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('合成题：如何设计缓存？')).click()");await cdp.click('收藏');await cdp.waitFor("__audit.data.questionBanks?.[0]?.favorites.length===1");await cdp.click('存进面试资料');await cdp.waitFor("__audit.data.materials?.[0]?.entries?.length===1");
    assert.equal(await cdp.evaluate('__audit.data.materials[0].entries[0].origin'),'model_generated');await cdp.evaluate('window.__bankReply=null');
    return {verdict:'pass',observed:{questionSaved:true,favoriteSaved:true,materialOrigin:'model_generated'}};
  });
  await probe('B07','Markdown HTML and javascript links must not execute scripts',async()=>{
    await cdp.evaluate(`window.__pwned=false;window.__md='<img src=x onerror="window.__pwned=true">\\n[bad](javascript:alert(1))';__view('md');`);await cdp.waitFor("!!document.querySelector('.overlay-md')");
    assert.equal(await cdp.evaluate('window.__pwned'),false);assert.equal(await cdp.evaluate("document.querySelectorAll('.overlay-md img').length"),0);
    return {verdict:'pass',observed:{executed:false,rawHtmlElements:0}};
  });
  await probe('B13','An unfinished exam has a recovery entry even before an interrupted flag can be saved',async()=>{
    await cdp.evaluate("(async()=>{await __seed('examSessions',[{id:'recover',title:'未完成合成笔试',status:'ACTIVE',createdAt:Date.now(),questions:[]}]);__view('exam');})()");
    await cdp.waitFor("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='恢复上次笔试')");
    const observed=await cdp.evaluate("({recoveryAvailable:[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='恢复上次笔试'&&!b.disabled),warningVisible:document.body.innerText.includes('请勿退出应用')})");
    return {verdict:observed.recoveryAvailable&&observed.warningVisible?'pass':'finding',observed};
  });
  await probe('B08','Model-controlled nested Markdown must have a safe rendering depth',async()=>{
    await cdp.evaluate("__view('chat')");await cdp.waitFor("!!document.querySelector('textarea')");await cdp.evaluate("window.__md='>'.repeat(3500)+' nested';__view('md')");await delay(300);
    const observed=await cdp.evaluate("({rendered:!!document.querySelector('.overlay-md'),stackOverflow:__audit.errors.some(e=>e.includes('Maximum call stack')),recoveryScreen:document.body.innerText.includes('重新加载'),errorCount:__audit.errors.length})");
    return {verdict:observed.stackOverflow||!observed.rendered?'finding':'pass',observed};
  });
  await probe('B09','First-launch disk failure must render a recoverable error instead of a blank window',async()=>{
    await cdp.command('Page.navigate',{url:'http://127.0.0.1:1444/artifacts/audit/startup.html'});
    await cdp.waitFor("window.__audit?.errors.some(e=>e.includes('synthetic disk full'))||document.body.innerText.includes('重试启动')");
    const observed=await cdp.evaluate("({rootChildren:document.getElementById('root').childElementCount,bodyText:document.body.innerText.trim(),errorCount:__audit.errors.length})");
    if(observed.bodyText.includes('重试启动')){await cdp.evaluate('__audit.failWrites=false');await cdp.click('重试启动');await cdp.waitFor('__audit.data.resumes?.length===1');}
    return {verdict:observed.rootChildren>0&&observed.bodyText.includes('重试启动')&&observed.errorCount===0?'pass':'finding',observed:{...observed,retriedSuccessfully:await cdp.evaluate('__audit.data.resumes?.length===1')}};
  });
  const screenshot=await cdp.command('Page.captureScreenshot',{format:'png'});await writeFile(`artifacts/audit/${process.argv.includes('--verify')?'fixed-':''}browser-last-state.png`,Buffer.from(screenshot.data,'base64'));
}finally{
  await writeFile(`artifacts/audit/${process.argv.includes('--verify')?'fixed-':''}browser-boundaries.json`,JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
  if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.kill();
}
if(results.some(result=>result.verdict==='probe-error'||(process.argv.includes('--verify')&&result.verdict!=='pass')))process.exitCode=1;
