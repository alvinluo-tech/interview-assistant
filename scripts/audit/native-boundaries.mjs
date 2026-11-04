// Requires an isolated debug binary built with artifacts/audit-native.conf.json.
// Never launches an installer, captures personal audio/screens or contacts an AI provider.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,copyFile,mkdir,chmod} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp,delay} from '../desktop-cdp.mjs';
const identifier='com.mianxu.audit.boundaries20261104';
const executable=path.resolve('src-tauri/target/debug/Mianxu.exe');
if(process.argv.includes('--build')){
  await mkdir('artifacts/audit-native-frontend',{recursive:true});await mkdir('artifacts/audit',{recursive:true});
  await writeFile('artifacts/audit-native.conf.json',JSON.stringify({identifier,build:{beforeBuildCommand:'',frontendDist:'../artifacts/audit-native-frontend'},bundle:{active:false}},null,2));
  await writeFile('artifacts/audit-native-frontend/index.html',`<!doctype html><meta charset="utf-8"><title>Isolated native audit</title><body>Independent synthetic audit profile.</body><script>window.__auditErrors=[];addEventListener('error',e=>__auditErrors.push(e.message));addEventListener('unhandledrejection',e=>__auditErrors.push(String(e.reason)));</script>`);
  const output=[];const builder=spawn(process.execPath,['node_modules/@tauri-apps/cli/tauri.js','build','--debug','--no-bundle','--config','artifacts/audit-native.conf.json'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  builder.stdout.on('data',bytes=>output.push(bytes));builder.stderr.on('data',bytes=>output.push(bytes));
  const code=await new Promise((resolve,reject)=>{builder.on('error',reject);builder.on('exit',resolve);});await writeFile('artifacts/audit/native-build.txt',Buffer.concat(output));assert.equal(code,0,'Isolated native build failed; inspect artifacts/audit/native-build.txt');
}
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)),'Refusing to launch a binary without the isolated audit identifier');
await mkdir('artifacts/audit',{recursive:true});
const results=[];let layout,initial;
const child=spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19405'}});
const desktop=new DesktopCdp(19405,'main');
async function check(id,invariant,fn){try{const value=await fn();results.push({id,invariant,...value});console.log(`${value.verdict.toUpperCase()} ${id}: ${JSON.stringify(value.observed)}`);}catch(error){results.push({id,invariant,verdict:'probe-error',observed:String(error.stack||error)});console.error('PROBE ERROR',id,error.message);}}
const read=()=>desktop.invoke('cmd_data_read');
const commit=(key,expected,value)=>desktop.invoke('cmd_data_commit',{key,expected,value});
try{
  await desktop.connect();await desktop.invoke('cmd_hide_main');layout=await desktop.invoke('cmd_storage_layout');
  assert.ok(layout.data.includes(identifier),'Native data directory must belong to the audit profile');
  initial=await read();await commit('resumes',initial.data.resumes||[],[]);
  await check('N01','Native storage merges concurrent additions and independent fields, and rejects conflicting fields',async()=>{
    const a={id:'a',title:'A',content:'body'},b={id:'b',title:'B',content:'body'};
    await Promise.all([commit('resumes',[],[a]),commit('resumes',[],[b])]);
    const base=(await read()).data.resumes;assert.equal(base.length,2);
    await Promise.all([commit('resumes',base,base.map(row=>row.id==='a'?{...row,title:'changed'}:row)),commit('resumes',base,base.map(row=>row.id==='a'?{...row,content:'edited'}:row))]);
    const changed=(await read()).data.resumes.find(row=>row.id==='a');assert.equal(changed.title,'changed');assert.equal(changed.content,'edited');
    await assert.rejects(commit('resumes',base,base.map(row=>row.id==='a'?{...row,title:'conflict'}:row)));
    return {verdict:'pass',observed:{mergedRows:2,independentFieldsPreserved:true,conflictRejected:true}};
  });
  await check('N02','A real read-only data file cannot result in a successful commit or changed memory',async()=>{
    const before=await read(),dataPath=path.join(layout.data,'data.json'),diskBefore=await readFile(dataPath,'utf8');
    await chmod(dataPath,0o444);let rejected=false;
    try{await commit('resumes',before.data.resumes,[...before.data.resumes,{id:'must-not-save',title:'failed'}]);}catch{rejected=true;}finally{await chmod(dataPath,0o666);}
    assert.ok(rejected);assert.equal(await readFile(dataPath,'utf8'),diskBefore);assert.deepEqual((await read()).data.resumes,before.data.resumes);
    return {verdict:'pass',observed:{rejected,memoryAndDiskUnchanged:true}};
  });
  await check('N03','Manual backup restoration preserves committed records and increases the revision',async()=>{
    await desktop.invoke('cmd_data_backup',{restore:false});const base=await read();await commit('resumes',base.data.resumes,[]);const deleted=await read();
    const restored=await desktop.invoke('cmd_data_backup',{restore:true});assert.equal(restored.data.resumes.length,2);assert.ok(restored.revision>deleted.revision);
    assert.equal(JSON.parse(await readFile(path.join(layout.data,'data.json'),'utf8')).resumes.length,2);
    return {verdict:'pass',observed:{restoredRows:2,revisionMonotonic:true}};
  });
  await check('N04','Unknown collections, duplicate IDs and invalid attachment references must fail closed',async()=>{
    await assert.rejects(commit('unknown',null,[]));await assert.rejects(commit('resumes',null,[{id:'same'},{id:'same'}]));
    for(const reference of ['../data.json','/etc/passwd','a/b/../../store.json','a/b/file.exe'])await assert.rejects(desktop.invoke('cmd_exam_read_image',{reference}));
    return {verdict:'pass',observed:{invalidCollectionsAndIdsRejected:true,traversalReferencesRejected:4}};
  });
  await check('N05','A stored screenshot can be read back without allowing more than six pages',async()=>{
    const image=await desktop.evaluate("(()=>{const c=document.createElement('canvas');c.width=16;c.height=16;const x=c.getContext('2d');x.fillStyle='#176675';x.fillRect(0,0,16,16);return c.toDataURL('image/png');})()");
    const refs=await desktop.invoke('cmd_exam_store_images',{sessionId:'synthetic',turnId:'turn',images:[image]});assert.equal(refs.length,1);
    const restored=await desktop.invoke('cmd_exam_read_image',{reference:refs[0]});assert.match(restored,/^data:image\/(png|jpeg);base64,/);
    await assert.rejects(desktop.invoke('cmd_exam_store_images',{sessionId:'synthetic',turnId:'too-many',images:Array(7).fill(image)}));
    return {verdict:'pass',observed:{storedAndRead:true,seventhPageRejected:true}};
  });
  await check('N06','Valid JSON with a broken nested record shape should be rejected at the native boundary',async()=>{
    const base=(await read()).data.interviewSessions||[];let rejected=false;
    try{await commit('interviewSessions',base,[{id:'malformed',type:'INTERVIEW',status:'ACTIVE',messages:'not-an-array'}]);}catch{rejected=true;}
    const persisted=(await read()).data.interviewSessions?.[0]?.messages;await commit('interviewSessions',(await read()).data.interviewSessions||[],base);
    return {verdict:rejected?'pass':'finding',observed:{rejected,persistedMessagesType:typeof persisted}};
  });
  await check('N07','Synthetic API keys round-trip through protected storage without plaintext on disk',async()=>{
    const key='audit-only-not-a-real-api-key';
    const config={version:2,providers:[{id:'synthetic',name:'Synthetic',baseUrl:'https://example.invalid/v1',authMode:'bearer',apiKey:key,models:[{id:'test',source:'custom'}]}],routes:{chat:{providerId:'synthetic',modelId:'test'},vision:null,stt:null,tts:null},timeoutMs:5000,ttsVoice:'alloy',speechInputMode:'file'};
    await desktop.invoke('cmd_ai_save_settings',{config});const restored=await desktop.invoke('cmd_ai_load_settings');assert.equal(restored.providers[0].apiKey,key);
    const store=await readFile(path.join(layout.settings,'store.json'),'utf8');assert.equal(store.includes(key),false);
    return {verdict:'pass',observed:{roundTrip:true,plaintextOnDisk:false}};
  });
  await check('N08','Local phone pairing requires an exact token and becomes unavailable after stop',async()=>{
    const pair=await desktop.invoke('cmd_dual_start'),base=`http://127.0.0.1:${pair.port}`;
    try{
      assert.equal((await fetch(base+'/?token=invalid')).status,403);
      assert.equal((await fetch(base+'/?token='+pair.token)).status,200);
      const socket=new WebSocket(`ws://127.0.0.1:${pair.port}/ws?token=${pair.token}`);
      await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});assert.equal(await desktop.invoke('cmd_dual_peer_count'),1);
      await desktop.invoke('cmd_dual_stop');await delay(100);assert.equal(await desktop.invoke('cmd_dual_peer_count'),0);socket.close();
      return {verdict:'pass',observed:{wrongTokenStatus:403,correctTokenStatus:200,peerAfterStop:0,transport:'http/ws'}};
    }finally{await desktop.invoke('cmd_dual_stop');}
  });
  await check('N09','The updater must refuse installation without a verified download',async()=>{
    const state=await desktop.invoke('cmd_updater_status');const refused=await desktop.invoke('cmd_updater_install');
    assert.equal(refused.phase,'error');assert.match(refused.error,/下载|验证/);
    return {verdict:'pass',observed:{initialPhase:state.phase,resultPhase:refused.phase,installationRejected:true,networkRequests:0}};
  });
  await check('N10','Code execution uses a local Linux engine and bounded synthetic execution',async()=>{
    let status;try{status=await desktop.invoke('cmd_code_check');}catch(error){return {verdict:'not-verified',observed:{reason:String(error),executed:false}};}
    if(!status.includes('python'))return {verdict:'not-verified',observed:{reason:'Local Python image is unavailable; no image was pulled',executed:false}};
    const normal=await desktop.invoke('cmd_code_run',{language:'python',code:"print('synthetic-audit')",stdin:'',expected:'synthetic-audit'});assert.equal(normal.passed,true);
    const timeout=await desktop.invoke('cmd_code_run',{language:'python',code:'while True: pass',stdin:'',expected:''});assert.equal(timeout.timedOut,true);
    return {verdict:'pass',observed:{normalPassed:true,infiniteLoopTimedOut:true}};
  });
  await check('N11','Settings disk failures roll back shared native memory as well as the durable file',async()=>{
    await desktop.invoke('cmd_set_setting',{key:'overlay.mode',value:'exam'});
    const file=path.join(layout.settings,'store.json'),before=await readFile(file,'utf8');let rejected=false;
    await chmod(file,0o444);
    try{await desktop.invoke('cmd_set_setting',{key:'overlay.mode',value:'interview'});}catch{rejected=true;}finally{await chmod(file,0o666);}
    assert.equal(await readFile(file,'utf8'),before);
    const rid=await desktop.invoke('plugin:store|load',{path:'store.json',options:{autoSave:false}});
    const [value]=await desktop.invoke('plugin:store|get',{rid,key:'overlay.mode'});assert.equal(value,'exam');assert.ok(rejected);
    return {verdict:'pass',observed:{rejected,memoryValue:value,diskUnchanged:true}};
  });
  await check('N12','Invalid nested records in a backup cannot replace valid live data',async()=>{
    const file=path.join(layout.backups,'data.manual-backup.json'),backup=await readFile(file),before=await readFile(path.join(layout.data,'data.json'),'utf8');
    try{await writeFile(file,JSON.stringify({interviewSessions:[{id:'bad',messages:false}]}));await assert.rejects(desktop.invoke('cmd_data_backup',{restore:true}));assert.equal(await readFile(path.join(layout.data,'data.json'),'utf8'),before);}
    finally{await writeFile(file,backup);}
    return {verdict:'pass',observed:{invalidRestoreRejected:true,liveDataUnchanged:true}};
  });
  await check('N13','Bundled native content enforces CSP while IPC and trusted bootstrap scripts work',async()=>{
    const observed=await desktop.evaluate(`(async()=>{window.__cspInjected=false;const element=document.createElement('script');element.textContent='window.__cspInjected=true';document.head.append(element);await new Promise(resolve=>setTimeout(resolve,50));element.remove();return {inlineBlocked:!window.__cspInjected,bootstrapLoaded:Array.isArray(window.__auditErrors),nativeIpcAvailable:typeof __TAURI_INTERNALS__.invoke==='function'};})()`);
    assert.equal(observed.inlineBlocked,true);assert.equal(observed.bootstrapLoaded,true);assert.equal(observed.nativeIpcAvailable,true);
    return {verdict:'pass',observed};
  });
  assert.deepEqual(await desktop.evaluate('__auditErrors'),[]);
}finally{
  await writeFile(`artifacts/audit/${process.argv.includes('--verify')?'fixed-':''}native-boundaries.json`,JSON.stringify({createdAt:new Date().toISOString(),identifier,results},null,2));
  if(desktop.socket){await desktop.invoke('cmd_exit_app').catch(()=>{});desktop.close();}child.kill();
}
if(results.some(result=>result.verdict==='probe-error'||(process.argv.includes('--verify')&&result.verdict==='finding')))process.exitCode=1;
