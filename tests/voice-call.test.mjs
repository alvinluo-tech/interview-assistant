import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
const {createVoiceCall}=evaluateFixture('src/lib/voiceCall.ts',{exports:{},Int16Array,AbortController});
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function harness() {
  let pcm,finished,failSpeech,resolveTranscription,opened=0,closed=0,aborted=0;const phases=[],sent=[],errors=[];
  const api=createVoiceCall({open:async(input)=>{pcm=input;opened++;return {close:async()=>{closed++;}};},
    transcribe:(_audio,signal)=>new Promise(resolve=>{resolveTranscription=resolve;signal.addEventListener('abort',()=>aborted++);}),
    send:text=>sent.push(text),speak:(_text,done,failed)=>{finished=done;failSpeech=failed;},stopSpeech:()=>{},cancelAnswer:()=>{},state:value=>phases.push(value),error:error=>errors.push(error)});
  return {api,phases,sent,errors,input:(duration,volume)=>pcm(new Int16Array(duration*16),volume),resolve:text=>resolveTranscription(text),finished:()=>finished?.(),failSpeech:error=>failSpeech?.(error),opened:()=>opened,closed:()=>closed,aborted:()=>aborted};
}
test('voice call automatically detects a turn and resumes only after playback',async()=>{
  const h=harness();h.api.start();await flush();assert.equal(h.api.getPhase(),'listening');
  h.input(400,30);h.input(1300,0);await flush();assert.equal(h.api.getPhase(),'transcribing');assert.equal(h.closed(),1);
  h.resolve('你好');await flush();assert.deepEqual(h.sent,['你好']);assert.equal(h.api.getPhase(),'thinking');
  h.api.answer('你好呀');assert.equal(h.api.getPhase(),'speaking');assert.equal(h.opened(),1);
  h.finished();await flush();assert.equal(h.opened(),2);assert.equal(h.api.getPhase(),'listening');h.api.stop();
});
test('ending while transcribing aborts the request and ignores late transcription',async()=>{
  const h=harness();h.api.start();await flush();h.input(400,30);h.input(1300,0);await flush();h.api.stop();
  assert.equal(h.aborted(),1);h.resolve('过期内容');await flush();assert.equal(h.sent.length,0);assert.equal(h.api.getPhase(),'idle');
});
test('interrupting playback resumes listening and ignores stale completion',async()=>{
  const h=harness();h.api.start();await flush();h.input(400,30);h.input(1300,0);await flush();h.resolve('问题');await flush();h.api.answer('回答');
  h.api.interrupt();await flush();h.finished();await flush();assert.equal(h.opened(),2);assert.equal(h.api.getPhase(),'listening');h.api.stop();
});
test('speech playback failure stops the call with a visible error',async()=>{
  const h=harness();h.api.start();await flush();h.input(400,30);h.input(1300,0);await flush();h.resolve('问题');await flush();h.api.answer('回答');h.failSpeech(new Error('播放失败'));
  assert.equal(h.api.getPhase(),'idle');assert.match(h.errors[0],/播放失败/);
});
test('a microphone opened after the call ends is immediately closed',async()=>{
  let resolve,closed=0;const phases=[];
  const api=createVoiceCall({open:()=>new Promise(done=>{resolve=done;}),transcribe:async()=>'',send:()=>{},speak:()=>{},stopSpeech:()=>{},cancelAnswer:()=>{},state:value=>phases.push(value),error:()=>{}});
  api.start();api.stop();resolve({close:async()=>{closed++;}});await flush();
  assert.equal(closed,1);assert.equal(api.getPhase(),'idle');
});
test('realtime speech sends PCM while talking and finishes without replaying the recording',async()=>{
  let push,preview,resolveFinish;const frames=[],sent=[],previews=[];let fileRequests=0,closed=0;
  const api=createVoiceCall({open:async fn=>{push=fn;return {close:async()=>{}};},
    openRealtime:async onPreview=>{preview=onPreview;return {push:pcm=>frames.push(pcm.length),finish:()=>new Promise(resolve=>{resolveFinish=resolve;}),close:async()=>{closed++;}};},
    preview:text=>previews.push(text),transcribe:async()=>{fileRequests++;return 'wrong';},send:text=>sent.push(text),speak:()=>{},stopSpeech:()=>{},cancelAnswer:()=>{},state:()=>{},error:()=>{}});
  api.start();await flush();push(new Int16Array(6400),30);preview('实时字幕');
  assert.equal(frames.length,1);assert.equal(previews[0],'实时字幕');assert.equal(api.getPhase(),'listening');
  push(new Int16Array(20800),0);await flush();assert.equal(api.getPhase(),'transcribing');
  resolveFinish('最终文字');await flush();assert.deepEqual(sent,['最终文字']);assert.equal(fileRequests,0);
  api.stop();assert.equal(closed,0);
});

test('ending while realtime recognition connects aborts and closes the late connection',async()=>{
  let resolve,aborted=false,closed=0;
  const api=createVoiceCall({open:async()=>{throw Error('microphone should not open');},openRealtime:(_preview,_error,signal)=>new Promise(done=>{resolve=done;signal.addEventListener('abort',()=>{aborted=true;});}),
    transcribe:async()=>'',send:()=>{},speak:()=>{},stopSpeech:()=>{},cancelAnswer:()=>{},state:()=>{},error:()=>{}});
  api.start();api.stop();resolve({push:()=>{},finish:async()=>'',close:async()=>{closed++;}});await flush();
  assert.equal(aborted,true);assert.equal(closed,1);assert.equal(api.getPhase(),'idle');
});
