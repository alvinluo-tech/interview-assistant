import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture, evaluateModuleFixture} from './compile-fixture.mjs';
test('mock interviewer requests forward cancellation to the AI transport', async () => {
  const calls = [];
  const api = evaluateFixture('src/lib/mock.ts', {exports:{}, require: name => {
    if(name==='./i18n')return evaluateModuleFixture('src/lib/i18n.ts');
    if(name==='./speechProfile')return evaluateModuleFixture('src/lib/speechProfile.ts');
    if(name==='./knowledgeContext') return {};
    assert.equal(name,'./ai'); return {chatStream: async options => {calls.push(options); return options.schema ? '{"question":"你好","kind":"NEW"}' : '你好';}};
  }});
  const controller = new AbortController();
  const config = {difficultyLabel:'测试', turnBudget:8, basicsRatio:50, assistMode:false};
  await api.generateOpeningQuestion(config, controller.signal);
  await api.generateNextQuestion(config, [], controller.signal);
  await api.generateHint(config, '问题', controller.signal);
  await api.generateMockReport([], controller.signal);
  assert.equal(calls.length,4);
  calls.forEach(call => assert.equal(call.signal, controller.signal));
});

// Exercise the actual component stop handler without mounting the full room.
// This reproduces the boundary between local level checks and ASR finalization.
async function mockStop({realtime=true,text='这是我的回答',length=192000,voicedMs=0,failure}={}) {
  const {readFileSync}=await import('node:fs');
  const ts=(await import('typescript')).default;
  const vm=await import('node:vm');
  const source=readFileSync('src/mock/MockApp.tsx','utf8');
  const start=source.indexOf('  const stopRec = async () => {');
  const end=source.indexOf('  // 空格键开关麦克风',start);
  assert.ok(start>=0&&end>start);
  const code=ts.transpileModule(source.slice(start,end)+'\nexports.stopRec=stopRec;',{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS},
  }).outputText;
  const calls={finish:0,close:0,micClose:0,transcribe:0};const toasts=[];
  let draft='原回答';
  const rec={stopping:false,length,voicedMs,chunks:realtime?[]:[new Int16Array(length)],controller:new AbortController(),
    capture:{close:async()=>{calls.micClose++;}},
    ...(realtime?{realtime:{finish:async()=>{calls.finish++;if(failure)throw failure;return text;},close:async()=>{calls.close++;}}}:{}),
  };
  const recorderRef={current:rec};
  const sandbox={exports:{},recorderRef,Int16Array,t:evaluateModuleFixture('src/lib/i18n.ts').t,setRecording:()=>{},setMicLevel:()=>{},setSilentSince:()=>{},
    setVoicePreview:()=>{},setVoiceStatus:()=>{},setTranscribing:()=>{},showToast:t=>toasts.push(t),
    setDraft:update=>{draft=update(draft);},encodeWav:x=>x,profileRef:{current:{}},recognitionLanguage:()=> 'zh',
    transcribeAudio:async()=>{calls.transcribe++;return text;},
  };
  vm.runInNewContext(code,sandbox);await sandbox.exports.stopRec();
  return {calls,toasts,draft,recorderRef,rec};
}

test('mock realtime captions finalize even when quiet speech fails the local volume gate',async()=>{
  const h=await mockStop();
  assert.equal(h.calls.finish,1);assert.equal(h.draft,'原回答 这是我的回答');
  assert.equal(h.toasts.length,0);assert.equal(h.calls.close,1);assert.equal(h.recorderRef.current,null);
});
test('a short realtime utterance is finalized and only server-final text enters the draft',async()=>{
  const h=await mockStop({length:1600,text:'简短回答'});
  assert.equal(h.calls.finish,1);assert.equal(h.draft,'原回答 简短回答');
  const empty=await mockStop({text:''});
  assert.equal(empty.draft,'原回答');assert.equal(empty.calls.finish,1);
  assert.equal(empty.toasts[0].title,'没听到你说话，再说一次');
});
test('mock file transcription still rejects silence and transcribes voiced recordings',async()=>{
  const silent=await mockStop({realtime:false});
  assert.equal(silent.calls.transcribe,0);assert.equal(silent.draft,'原回答');
  assert.equal(silent.toasts[0].title,'没听到你说话，再说一次');
  const spoken=await mockStop({realtime:false,voicedMs:1000});
  assert.equal(spoken.calls.transcribe,1);assert.equal(spoken.draft,'原回答 这是我的回答');
});
test('mock realtime finalization errors release resources and do not become silence or answers',async()=>{
  const h=await mockStop({failure:Error('synthetic finalization failure')});
  assert.equal(h.draft,'原回答');assert.equal(h.toasts[0].title,'语音识别失败，请再说一次');
  assert.equal(h.calls.close,1);assert.equal(h.rec.controller.signal.aborted,true);
});
