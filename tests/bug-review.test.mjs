import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
const keys = evaluateFixture('src/lib/hotkeys.ts',{exports:{}});

test('recorder rejects modifier-only and unknown physical keys (B18)', () => {
  for(const code of ['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight','OSLeft','Unidentified','']) {
    const result=keys.keyEventToAccelerator({code,ctrlKey:true,shiftKey:true});
    assert.equal(result.accelerator,'',code);
    assert.ok(result.error,code);
  }
  assert.equal(keys.keyEventToAccelerator({code:'KeyA',ctrlKey:true}).accelerator,'Control+A');
  for(const code of ['Escape','NumpadAdd','NumpadSubtract','NumpadMultiply','NumpadDivide','NumpadDecimal','NumpadEnter']) {
    assert.equal(keys.keyEventToAccelerator({code}).accelerator,code);
  }
});

test('exam answer-language preference reaches the actual prompt (B27)', () => {
  const ai=evaluateFixture('src/lib/ai.ts',{exports:{},require:()=>({})});
  assert.match(ai.buildExamUserPrompt({answerLanguage:'en-US'}),/en-US/);
  assert.match(ai.buildExamUserPrompt({answerLanguage:'ja-JP',programmingLanguage:'Python 3'}),/ja-JP/);
  assert.doesNotMatch(ai.buildExamUserPrompt({answerLanguage:'auto'}),/auto/);
});

function workbench(source) {
  const calls=[];
  const componentNames=new Proxy({}, {get:(_target,name)=>name==='showToast'?()=>{}:String(name)});
  const jsx=(type,props)=>({type,props});
  const modules={
    'react':{useEffect(){},useState:initial=>[typeof initial==='function'?initial():initial,()=>{}]},
    'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':componentNames,'@/ui/primitives':componentNames,
    '@/lib/aiSettings':{useAiReady:()=>true,useAiSettings:()=>({routes:{},providers:[]})},
    '@/lib/aiConfig':{usesLiveSpeech:()=>false},'@/lib/dualCamera':{},'./MicrophoneCheck':{},'./OutputExclusions':{},'../CodeVerificationPanel':{},'./DualScreenCard':{},
    '@/lib/bridge':{isTauri:()=>false,overlayShowSeq:async()=>1},
    '@/lib/ai':{ANSWER_STYLES:[]},
    '@/lib/store':{useSetting:(_key,fallback)=>[fallback,()=>{}],setSetting:async()=>{}},
    '@/lib/backend':{useData:(key,fallback)=>[key==='interviewSessions'?[{id:'active',type:'INTERVIEW',status:'ACTIVE'}]:fallback,()=>{}],readData:(_key,fallback)=>fallback,completeSession:async()=>calls.push('complete')},
    '@/lib/examEngine':{EXAM_MODE_ORDER:[],EXAM_MODES:{},customizationSummary:()=>'',startExamSession:async()=>calls.push('create')},
    '@/lib/interviewLifecycle':{requestInterviewStop:async()=>calls.push('engine-stop')},
    '../MainWindow':{startOverlayFlow:async()=>calls.push('show'),recallWorkbench:async()=>calls.push('recall')},
  };
  const api=evaluateFixture(source,{exports:{},console,window:{},crypto:{randomUUID:()=> 'run'},require:name=>{
    if(!(name in modules))throw new Error('Unexpected dependency '+name);return modules[name];
  }});
  function find(node,text){
    if(!node||typeof node!=='object')return;
    const label=value=>typeof value==='string'?value:Array.isArray(value)?value.map(label).join(''):value?.props?label(value.props.children):'';
    if(node.props?.onClick && label(node.props.children).includes(text))return node;
    for(const value of Object.values(node.props||node)){
      if(Array.isArray(value)){for(const child of value){const hit=find(child,text);if(hit)return hit;}}
      else {const hit=find(value,text);if(hit)return hit;}
    }
  }
  return {calls,click:async(name,text)=>{const node=find(api[name]({onNavigate(){}}),text);assert.ok(node,'Action exists: '+text);node.props.onClick();for(let i=0;i<60;i++)await Promise.resolve();}};
}

test('the workbench leaves exam record creation to the overlay (B23)', async()=>{
  const h=workbench('src/main/sections/ExamWorkbench.tsx');await h.click('ExamWorkbench','开始笔试');
  assert.equal(h.calls.filter(call=>call==='create').length,0);
  assert.ok(h.calls.includes('show'));
});

test('ending from the workbench stops the owning interview engine (B24)',async()=>{
  const h=workbench('src/main/sections/InterviewWorkbench.tsx');await h.click('InterviewWorkbench','结束面试');
  assert.ok(h.calls.includes('engine-stop'));
});


function examOverlay(body, clipboardFails=false) {
  const notifications=[], bindings=new Map();
  const jsx=(type,props)=>({type,props});
  const names=new Proxy({}, {get:(_target,key)=>key==='showToast'?message=>notifications.push(message):String(key)});
  const state={mode:'quick',phase:'done',pendingScreenshots:[],turns:body?[{id:'turn',body,followUpOptions:['Why this result?']}]:[],elapsedSec:0};
  const modules={
    'react':{useEffect:fn=>fn(),useMemo:fn=>fn(),useReducer:()=>[0,()=>{}],useRef:()=>({current:null}),useState:initial=>[initial,()=>{}]},
    'react/jsx-runtime':{jsx,jsxs:jsx},'lucide-react':names,'@/ui/primitives':names,'./Md':{},
    '@/lib/overlayStyle':{normalizeStyle:style=>style,computeSkin:()=>({vars:{}})},
    '@/lib/store':{DEFAULT_OVERLAY_STYLE:{examWidth:420,examHeight:520},useSetting:(_key,fallback)=>[fallback,()=>{}],getSetting:(_key,fallback)=>fallback},
    '@/lib/examEngine':{getSolverState:()=>state,subscribeSolver:()=>()=>{},extractLastCodeBlock:()=>null,stripMarkdown:text=>text,examModeInfo:()=>({shortLabel:'quick',maxScreenshotPages:4})},
    '@/lib/bridge':{setOverlaySize:async()=>{},setSessionActive:async()=>{}},
    '@/lib/env':{isMac:()=>false,BRAND:'fixture'},'@/lib/hotkeys':{effectiveHotkeys:()=>({})},
    './widgets':new Proxy({registerOverlayList(){}},{get:(target,key)=>key in target?target[key]:String(key)}),
    './platform':{usePlatform:()=>({bindHotkey:(name,fn)=>{bindings.set(name,fn);return()=>{};}})},
    '@tauri-apps/plugin-clipboard-manager':{writeText:async()=>{if(clipboardFails)throw new Error('clipboard unavailable');}},
    '@/lib/events':{bus:{emit:(_event,message)=>notifications.push(message)}},
  };
  const api=evaluateFixture('src/overlay/ExamOverlay.tsx',{exports:{},console,require:name=>{if(!(name in modules))throw new Error(name);return modules[name];}});
  const element=api.ExamOverlay({preview:false});
  return {notifications,copy:async()=>{bindings.get('copy-code')();for(let i=0;i<30;i++)await Promise.resolve();},shell:()=>element.type(element.props)};
}

test('copy reports success, empty answers and clipboard errors (B10)', async()=>{
  for(const [body,fails,type] of [['answer',false,'success'],['',false,'info'],['answer',true,'error']]){
    const h=examOverlay(body,fails);await h.copy();assert.equal(h.notifications.at(-1)?.type,type);
  }
});

test('parsed suggestions have visible follow-up actions (B29)',()=>{
  const tree=examOverlay('answer').shell();
  assert.ok(JSON.stringify(tree).includes('Why this result?'));
});

test('global error diagnostics keep only the latest 400 entries (B35)',async()=>{
  const handlers=new Map(),win={addEventListener:(name,handler)=>handlers.set(name,handler)};
  const jsx=()=>({});
  const modules={react:{default:{StrictMode:'StrictMode'}},'react/jsx-runtime':{jsx,jsxs:jsx},'react-dom/client':{createRoot:()=>({render(){}})},'./index.css':{},'./lib/i18n':{applyDocumentLang(){},windowScene:()=> 'main'},'./lib/bridge':{isTauri:()=>false},'./lib/store':{},'./lib/backend':{},'./lib/aiSettings':{},'./App':{App(){}}};
  evaluateFixture('src/main.tsx',{exports:{},window:win,document:{getElementById:()=>({}),documentElement:{classList:{toggle(){}}},body:{classList:{toggle(){}}}},console:{error(){}},require:name=>{if(!(name in modules))throw new Error(name);return modules[name];}});
  for(let i=0;i<1000;i++)handlers.get('error')({message:'error '+i});
  assert.equal(win.__errors.length,400);
  assert.equal(win.__errors.at(-1),'error 999');
});


test('stale-session cleanup clears recovery ids but preserves mock interviews (B13)',async()=>{
  const data=new Map([['interviewSessions',[{id:'old',type:'INTERVIEW',status:'ACTIVE'},{id:'mock',type:'MOCK_INTERVIEW',status:'ACTIVE'}]]]);
  const settings={'interview.sessionId':'old'};
  const store={get:async key=>data.get(key),set:async(key,value)=>data.set(key,value),save:async()=>{}};
  const api=evaluateFixture('src/lib/backend.ts',{exports:{},window:{},console,require:name=>{
    if(name==='react')return {};
    if(name==='@tauri-apps/plugin-store')return {load:async()=>store};
    if(name==='@tauri-apps/api/event')return {emit:async()=>{}};
    if(name==='./store')return {getSetting:(key,fallback)=>settings[key]??fallback,setSetting:async(key,value)=>{settings[key]=value;}};
    throw new Error(name);
  }});
  await api.hydrateData();await api.closeStaleActiveSessions();
  assert.equal(settings['interview.sessionId'],null);
  assert.equal(data.get('interviewSessions').find(s=>s.id==='mock').status,'ACTIVE');
});

test('engine toasts reach the mounted notification viewport',()=>{
  const updates=[];
  const bus=evaluateFixture('src/lib/events.ts',{exports:{},console}).bus;
  const jsx=(type,props)=>({type,props});
  const api=evaluateFixture('src/ui/primitives.tsx',{exports:{},window:{setTimeout(){}},require:name=>{
    if(name==='react')return {createContext:()=>({}),useEffect:fn=>fn(),useState:initial=>[initial,value=>updates.push(value)]};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='lucide-react')return {};
    if(name==='../lib/events'||name==='@/lib/events')return {bus};
    throw new Error(name);
  }});
  api.ToastViewport();bus.emit('toast',{type:'error',title:'save failure'});
  assert.equal(updates.at(-1)?.at(-1)?.title,'save failure');
});
