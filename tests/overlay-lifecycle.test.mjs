import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(file,modules,extra={}){return evaluateFixture(file,{exports:{},console,AbortController,DOMException,Date,performance,Int16Array,Float32Array,Uint8Array,ArrayBuffer,DataView,Blob,require:name=>{if(!(name in modules))throw Error(`Unmocked ${name}`);return modules[name];},...extra});}

function visibility(){
  const pending=deferred(),effects=[],events={},state=[];let index=0;
  const api=fixture('src/overlay/OverlayApp.tsx',{
    react:{useEffect:fn=>effects.push(fn),useRef:value=>({current:value}),useState:value=>{const at=index++;state[at]=value;return [value,next=>state[at]=typeof next==='function'?next(state[at]):next];}},
    'react/jsx-runtime':{},'@tauri-apps/api/window':{},
    '@/lib/bridge':{onEvent:(name,fn)=>{events[name]=fn;return ()=>delete events[name];},overlayShowSeq:()=>pending.promise},
    '@/lib/store':{useSetting:()=>[{}],getSetting:()=> 'exam'},'@/lib/overlayStyle':{normalizeStyle:value=>value},
    './ExamOverlay':{},'./InterviewOverlay':{},'./platform':{},'./widgets':{},'@/lib/interviewLifecycle':{},'@/ui/primitives':{},
  },{window:{}});
  api.OverlayApp();const close=effects[2]();return {pending,state,events,close};
}
test('a hidden overlay cannot be reactivated by an older visibility snapshot',async()=>{
  const h=visibility();h.events['overlay-shown']({seq:7});h.events['overlay-hidden']();h.pending.resolve(7);await flush();assert.equal(h.state[0],false);h.close();
});
test('a late initial snapshot cannot change a newer shown sequence',async()=>{
  const h=visibility();h.events['overlay-shown']({seq:9});h.pending.resolve(7);await flush();assert.equal(h.state[0],true);assert.equal(h.state[2],9);h.close();
});
test('a disposed visibility effect ignores its pending snapshot',async()=>{
  const h=visibility();h.close();h.pending.resolve(3);await flush();assert.equal(h.state[0],false);
});
test('duplicate native shown events mount the business component only once',async()=>{
  const h=visibility();h.events['overlay-shown']({seq:9});const before=h.state[1];h.events['overlay-shown']({seq:9});assert.equal(h.state[1],before);h.pending.resolve(0);await flush();h.close();
});

function interview({deferSetting=true,createGate,storedSession=false}={}){
  const pending=deferred(),effects=[];let writing=false,micStarts=0,micCloses=0,sessionsCreated=0;
  const stored={id:'restored',type:'INTERVIEW',status:'ACTIVE',messages:[]};
  const settings={getSetting:(key,fallback)=>storedSession&&key==='interview.sessionId'?stored.id:fallback,setSetting:async()=>{}};
  const engine=fixture('src/lib/interviewEngine.ts',{
    './aiSettings':{getAiSettings:()=>({})},'./aiConfig':{resolveAiRoute:()=>({})},
    './bridge':{cmd:async()=>{},stopSystemAudioCapture:async()=>{}},'./ai':{liveSpeechEnabled:()=>false},
    './backend':{readData:(key,fallback)=>storedSession&&key==='interviewSessions'?[stored]:fallback,createSession:async()=>{sessionsCreated++;if(createGate)await createGate.promise;return {id:'synthetic'};},updateSession:async()=>{},completeSession:async()=>{}},
    './examEngine':{prepareExamRun:()=>{},finishInterviewExam:async()=>{}},'./store':settings,'./events':{bus:{emit:()=>{}}},
    './microphone':{openMicrophone:async()=>{micStarts++;return {label:'Synthetic',close:async()=>{micCloses++;}};}},
    './speechProtocol':{},'./knowledgeContext':{captureKnowledge:()=>({})},'./aiContext':{},'./speechPreferences':{getSpeechProfile:()=>({})},'./speechProfile':{},
    './speakerRouting':{AudioTimeline:class{reset(){}}},'./speakerClient':{},'./speechTranslation':{},
  },{window:{}});
  const ui=fixture('src/overlay/InterviewOverlay.tsx',{
    react:{useEffect:fn=>effects.push(fn),useMemo:fn=>fn()},'react/jsx-runtime':{jsx:()=>null},'lucide-react':{},'./GenerationDetails':{},'@/lib/examEngine':{},'@/lib/interviewEngine':engine,
    '@/lib/overlayStyle':{normalizeStyle:value=>value,computeSkin:()=>({})},
    '@/lib/store':{...settings,useSetting:()=>[{}],setSetting:async()=>{writing=true;if(deferSetting)await pending.promise;}},
    '@/lib/ai':{},'@/lib/microphone':{},'@/lib/bridge':{},'@/lib/hotkeys':{},'@/ui/primitives':{},'./Md':{},'./widgets':{},'./platform':{},'@/lib/speechPreferences':{},
  },{window:{__ml_pendingConfig:{goalId:null,resumeId:null,materialIds:[],audioSource:'MICROPHONE'}}});
  const mount=()=>{effects.length=0;ui.InterviewOverlay({preview:false});return effects[1]();};
  return {engine,pending,mount,get writing(){return writing;},get micStarts(){return micStarts;},get micCloses(){return micCloses;},get sessionsCreated(){return sessionsCreated;}};
}
test('ending during session setting persistence cannot reopen a microphone',async()=>{
  const h=interview(),off=h.mount();await flush();assert.equal(h.writing,true);await h.engine.endInterview(false);off?.();h.pending.resolve();await flush();
  assert.equal(h.micStarts,0);assert.equal(h.engine.getInterviewEngineState().status,'ended');assert.equal(h.engine.getInterviewEngineState().sessionId,null);
});
test('unmount before bootstrap runs never creates a session or opens a microphone',async()=>{
  const h=interview();const off=h.mount();off?.();h.pending.resolve();await flush();assert.equal(h.sessionsCreated,0);assert.equal(h.micStarts,0);
});
test('strict effect setup/cleanup/setup starts one live interview',async()=>{
  const h=interview({deferSetting:false});h.mount()?.();const off=h.mount();await flush();assert.equal(h.sessionsCreated,1);assert.equal(h.micStarts,1);off?.();await h.engine.endInterview(false);assert.equal(h.micCloses,1);
});
test('unmount while creating a session cannot install the late session',async()=>{
  const gate=deferred(),h=interview({createGate:gate}),off=h.mount();await flush();assert.equal(h.sessionsCreated,1);off?.();gate.resolve();h.pending.resolve();await flush();assert.equal(h.micStarts,0);assert.equal(h.engine.getInterviewEngineState().sessionId,null);
});
test('restoring an active interview opens a single microphone and reuses its record',async()=>{
  const h=interview({storedSession:true}),off=h.mount();await flush();assert.equal(h.micStarts,1);assert.equal(h.sessionsCreated,0);assert.equal(h.engine.getInterviewEngineState().sessionId,'restored');off?.();await h.engine.endInterview(false);assert.equal(h.micCloses,1);
});
test('a stale caller cannot start capture without an active session',async()=>{
  const h=interview();await h.engine.beginListening('MICROPHONE');await flush();assert.equal(h.micStarts,0);assert.equal(h.engine.getInterviewEngineState().status,'idle');
});
test('an old session owner cannot restart capture in a different session',async()=>{
  const h=interview({storedSession:true});h.engine.resumeInterviewSession('restored',null,null);await h.engine.beginListening('MICROPHONE','previous-session');assert.equal(h.micStarts,0);await h.engine.endInterview(false);
});
