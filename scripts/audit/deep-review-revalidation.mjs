// Audit probes: execute production functions with synthetic drivers and controlled scheduling.
// Findings are evidence, not passing regression invariants. No real audio, credentials or user data.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {evaluateFixture} from '../../tests/compile-fixture.mjs';
const results=[];
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function probe(id,run){try{const result=await run();results.push({id,...result});console.log(`${result.status} ${id}: ${JSON.stringify(result.observed)}`);}catch(error){results.push({id,status:'probe-error',error:String(error.stack||error)});console.error(id,error);}}
function fixture(file,modules,extra={}){return evaluateFixture(file,{exports:{},console,structuredClone,AbortController,DOMException,setTimeout,clearTimeout,Date,performance,Int16Array,Float32Array,Uint8Array,ArrayBuffer,DataView,Blob,require:name=>{if(!(name in modules))throw Error(`Unmocked ${name}`);return modules[name];},...extra});}

await probe('D01-event-registration-cleanup',async()=>{
  const pending=deferred();let delivered=0,released=0,callback;
  const api=fixture('src/lib/bridge.ts',{'@tauri-apps/api/core':{},'@tauri-apps/api/event':{listen:(_name,handler)=>{callback=handler;return pending.promise;}}},{window:{__TAURI_INTERNALS__:{}}});
  const off=api.onEvent('synthetic',()=>delivered++);off();callback({payload:1});pending.resolve(()=>released++);await flush();
  assert.equal(delivered,0);assert.equal(released,1);
  return {status:'pass',observed:{deliveredAfterDispose:delivered,lateRegistrationReleased:released}};
});

await probe('D02-request-scope-cleanup',async()=>{
  const pending=new Set(),listeners=new Set();
  const signal={aborted:false,addEventListener:(_name,fn)=>listeners.add(fn),removeEventListener:(_name,fn)=>listeners.delete(fn)};
  const api=fixture('src/lib/aiProtocol.ts',{'./aiConfig.js':{},'./ttsConfig.js':{}},{setTimeout:fn=>{pending.add(fn);return fn;},clearTimeout:fn=>pending.delete(fn)});
  for(let i=0;i<100;i++)api.requestScope(1000,signal).cleanup();
  assert.equal(pending.size,0);assert.equal(listeners.size,0);
  return {status:'pass',observed:{cycles:100,remainingTimers:pending.size,remainingAbortListeners:listeners.size}};
});

await probe('D03-overlay-hidden-versus-late-snapshot',async()=>{
  const pending=deferred(),effects=[],events={},state=[];let stateIndex=0;
  const api=fixture('src/overlay/OverlayApp.tsx',{
    react:{useEffect:fn=>effects.push(fn),useRef:value=>({current:value}),useState:value=>{const index=stateIndex++;state[index]=value;return [value,next=>state[index]=typeof next==='function'?next(state[index]):next];}},
    'react/jsx-runtime':{},'@tauri-apps/api/window':{},
    '@/lib/bridge':{onEvent:(name,fn)=>{events[name]=fn;return ()=>delete events[name];},listenEvent:async(name,fn)=>{events[name]=fn;return ()=>delete events[name];},overlayShowSeq:()=>pending.promise},
    '@/lib/store':{useSetting:()=>[{}],getSetting:()=> 'exam'},'@/lib/overlayStyle':{normalizeStyle:value=>value},
    './ExamOverlay':{},'./InterviewOverlay':{},'./platform':{},'./widgets':{},'@/lib/interviewLifecycle':{},'@/ui/primitives':{},
  },{window:{}});
  api.OverlayApp();const cleanup=effects[2]();await flush();
  events['overlay-shown']({seq:7});events['overlay-hidden']();assert.equal(state[0],false);
  pending.resolve(7);await flush();const reactivated=state[0];cleanup();
  return {status:reactivated?'confirmed-active-path':'fixed',finding:'R03',observed:{hiddenBeforeResponse:true,activeAfterLateResponse:reactivated,showSeq:state[2]},scope:'Production root effect; controlled IPC response ordering, no OS window or audio opened'};
});

await probe('D04-interview-end-during-bootstrap-setting-write',async()=>{
  // Real component -> real engine, with only storage/audio/platform/AI dependencies replaced.
  const pending=deferred(),effects=[],records=[];let writing=false,micStarts=0,micCloses=0;
  const modules={
    './aiSettings':{getAiSettings:()=>({})},'./aiConfig':{resolveAiRoute:()=>({})},
    './bridge':{cmd:async()=>{},stopSystemAudioCapture:async()=>{}},
    './ai':{liveSpeechEnabled:()=>false},
    './backend':{readData:(_key,fallback)=>fallback,createSession:async()=>({id:'synthetic-deep-review'}),updateSession:async()=>{},completeSession:async()=>{}},
    './examEngine':{prepareExamRun:()=>{},finishInterviewExam:async()=>{}},
    './store':{getSetting:(_key,fallback)=>fallback,setSetting:async()=>{}},'./events':{bus:{emit:()=>{}}},
    './microphone':{openMicrophone:async()=>{micStarts++;return {label:'Synthetic',close:async()=>{micCloses++;}};}},
    './speechProtocol':{},'./knowledgeContext':{captureKnowledge:()=>({})},'./aiContext':{},
    './speechPreferences':{getSpeechProfile:()=>({})},'./speechProfile':{},
    './speakerRouting':{AudioTimeline:class{reset(){}}},'./speakerClient':{},'./speechTranslation':{},
  };
  const win={__ml_pendingConfig:{goalId:null,resumeId:null,materialIds:[],audioSource:'MICROPHONE'}};
  const engine=fixture('src/lib/interviewEngine.ts',modules,{window:win});
  const ui=fixture('src/overlay/InterviewOverlay.tsx',{
    react:{useEffect:fn=>effects.push(fn),useMemo:fn=>fn()},'react/jsx-runtime':{jsx:()=>null},
    'lucide-react':{},'./GenerationDetails':{},'@/lib/examEngine':{},'@/lib/interviewEngine':engine,
    '@/lib/overlayStyle':{normalizeStyle:value=>value,computeSkin:()=>({})},
    '@/lib/store':{useSetting:()=>[{}],getSetting:(_key,fallback)=>fallback,setSetting:()=>{writing=true;return pending.promise;}},
    '@/lib/ai':{},'@/lib/microphone':{},'@/lib/bridge':{},'@/lib/hotkeys':{},'@/ui/primitives':{},'./Md':{},'./widgets':{},'./platform':{},'@/lib/speechPreferences':{},
  },{window:win});
  ui.InterviewOverlay({preview:false});const cleanup=effects[1]();await flush();assert.equal(writing,true);
  await engine.endInterview(false);assert.equal(engine.getInterviewEngineState().status,'ended');assert.equal(micStarts,0);
  cleanup?.();pending.resolve();await flush();
  const current=engine.getInterviewEngineState();records.push({status:current.status,sessionId:current.sessionId,micStarts,micCloses});
  await engine.endInterview(false);assert.equal(micCloses,micStarts);
  return {status:micStarts?'confirmed-active-path':'fixed',finding:'R04',observed:records[0],scope:'Production component and engine; delayed setting persistence and synthetic microphone. Real device not accessed'};
});

await probe('D05-ai-read-and-save-ordering',async()=>{
  const calls=[];
  const api=fixture('src/lib/aiSettings.ts',{react:{},'@tauri-apps/api/event':{},'./aiConfig':{defaultAiSettings:()=>({name:'initial'}),validateAiSettings:value=>value},'@tauri-apps/api/core':{invoke:name=>{const pending=deferred();calls.push({name,...pending});return pending.promise;}}},{window:{__TAURI_INTERNALS__:{}}});
  const old=api.reloadAiSettings(),saving=api.saveAiSettings({name:'saved'});calls[1].resolve();await saving;calls[0].resolve({name:'old'});await old;
  assert.equal(api.getAiSettings().name,'saved');
  const older=api.reloadAiSettings(),newer=api.reloadAiSettings();calls[3].resolve({name:'newest'});await newer;calls[2].reject('synthetic old read failure');await older;
  assert.equal(api.getAiSettings().name,'newest');assert.equal(api.getAiLoadError(),'');
  return {status:'pass',observed:{afterStaleSuccess:'saved',afterStaleError:api.getAiSettings().name,loadError:api.getAiLoadError()}};
});

await probe('D06-desktop-appearance-lifetime',async()=>{
  let storeListeners=0,mediaListeners=0;
  const api=fixture('src/lib/desktopAppearance.ts',{'./store':{getSetting:(_key,fallback)=>fallback,subscribeStore:()=>storeListeners++}},
    {window:{matchMedia:()=>({matches:false,addEventListener:()=>mediaListeners++})},document:{documentElement:{style:{},classList:{toggle(){}}}},localStorage:{getItem:()=>null}});
  for(let i=0;i<100;i++)api.initDesktopAppearance();assert.equal(storeListeners,1);assert.equal(mediaListeners,1);
  return {status:'pass',observed:{initializationCalls:100,storeListeners,systemThemeListeners:mediaListeners},scope:'Intentional document-lifetime subscription; guarded against duplicate initialization'};
});

await mkdir('artifacts/audit',{recursive:true});
const receipt=JSON.parse(readFileSync('docs/audit/2026-11-04-fix-evidence.json','utf8'));
const files=receipt.sourceHashes.filter(row=>row.file.startsWith('src/')||row.file.startsWith('src-tauri/src/'));
const changed=files.filter(row=>createHash('sha256').update(readFileSync(row.file)).digest('hex')!==row.sha256).map(row=>row.file);
if(process.argv.includes('--baseline'))assert.deepEqual(changed,[],'Original audit baseline changed');
await writeFile('artifacts/audit/deep-review-revalidation.json',JSON.stringify({createdAt:new Date().toISOString(),productionFilesChecked:files.length,productionFilesChanged:changed,results},null,2));
if(results.some(row=>row.status==='probe-error'))process.exitCode=1;
if(process.argv.includes('--verify')&&results.some(row=>row.status.startsWith('confirmed')))process.exitCode=1;
