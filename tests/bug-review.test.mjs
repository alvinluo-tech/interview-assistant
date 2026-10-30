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
    '@/lib/aiConfig':{usesLiveSpeech:()=>false},'@/lib/dualCamera':{},'./MicrophoneCheck':{},'../CodeVerificationPanel':{},'./DualScreenCard':{},
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
