import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluateFixture } from './compile-fixture.mjs';

const cache = new Map();
function load(source) {
  source = path.resolve(source);
  if (cache.has(source)) return cache.get(source);
  const api = evaluateFixture(source, {exports:{}, Error, AbortController, DOMException, setTimeout, clearTimeout,
    URL, URLSearchParams, performance, Response, ReadableStream, TextDecoder, TextEncoder, Uint8Array, Float32Array, ArrayBuffer, DataView, atob,
    require: name => load(path.resolve(path.dirname(source), name.replace(/\.js$/, '.ts')))});
  cache.set(source, api); return api;
}
const provider = (baseUrl = 'https://api.xiaomimimo.com/v1') => ({id:'test',name:'测试',baseUrl,authMode:'bearer',apiKey:'fake-secret',models:[],lastFetchedAt:null});
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const pcm = Buffer.from([0,0,255,127,0,128,0,0]).toString('base64');
const sse = text => new Response(text, {headers:{'content-type':'text/event-stream'}});

test('MiMo speaks assistant text with nested voice and streams PCM before the response ends', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts');
  const chunks = []; let streamController, responseEnded = false;
  const response = new Response(new ReadableStream({start(controller) {streamController = controller;}}), {headers:{'content-type':'text/event-stream'}});
  const pending = requestSpeech(provider(), 'mimo-v2.5-tts', '请介绍一下自己。', '苏打', async (url, init) => {
    assert.equal(url, 'https://api.xiaomimimo.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    assert.equal(body.messages.at(-1).role, 'assistant'); assert.equal(body.messages.at(-1).content, '请介绍一下自己。');
    assert.equal(body.audio.voice, '苏打'); assert.equal(body.audio.format, 'pcm16'); assert.equal(body.stream, true);
    assert.equal(init.redirect,'error'); return response;
  }, 1000, undefined, chunk => {assert.equal(responseEnded,false); chunks.push(chunk);});
  streamController.enqueue(new TextEncoder().encode(frame({choices:[{delta:{audio:{data:pcm}}}]})));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(chunks.length, 1);
  responseEnded = true; streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); streamController.close(); await pending;
  assert.equal(chunks[0].format, 'pcm16'); assert.equal(chunks[0].sampleRate, 24000);
});

test('Aliyun Qwen uses regional native endpoints and never downloads the final URL twice', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts');
  for (const host of ['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','ws-test.ap-southeast-1.maas.aliyuncs.com']) {
    let requests = 0; const chunks = [];
    await requestSpeech(provider(`https://${host}/compatible-mode/v1`), 'qwen3-tts-flash', '你好', 'Cherry', async (url, init) => {
      requests++; assert.equal(url,`https://${host}/api/v1/services/aigc/multimodal-generation/generation`);
      assert.equal(init.headers['X-DashScope-SSE'],'enable');
      const body = JSON.parse(init.body); assert.equal(body.input.voice,'Cherry'); assert.equal(body.input.text,'你好');
      return sse(frame({output:{audio:{data:pcm}}})+frame({output:{finish_reason:'stop',audio:{url:'https://must-not-fetch.example/audio'}}}));
    }, 1000, undefined, chunk => chunks.push(chunk));
    assert.equal(requests,1); assert.equal(chunks.length,1);
  }
});

test('Qwen Audio and CosyVoice request PCM at 24kHz, while unsupported region/realtime/clone fail locally', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts');
  for (const model of ['qwen-audio-3.1-tts-flash','cosyvoice-v3-flash']) {
    await requestSpeech(provider('https://dashscope.aliyuncs.com/compatible-mode/v1'),model,'你好','voice-id',async(url,init)=>{
      assert.ok(url.endsWith('/services/audio/tts/SpeechSynthesizer'));
      const body=JSON.parse(init.body); assert.equal(body.input.format,'pcm');assert.equal(body.input.sample_rate,24000);
      return sse(frame({output:{audio:{data:pcm},finish_reason:'stop'}}));
    },1000,undefined,()=>{});
  }
  let requests=0; const fetcher=async()=>{requests++;return sse('');};
  await assert.rejects(requestSpeech(provider('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),'cosyvoice-v3-flash','你好','voice',fetcher,1000,undefined,()=>{}),/北京/);
  await assert.rejects(requestSpeech(provider('https://dashscope.aliyuncs.com/compatible-mode/v1'),'qwen3-tts-flash-realtime','你好','Cherry',fetcher,1000,undefined,()=>{}),/realtime|实时/);
  await assert.rejects(requestSpeech(provider(),'mimo-v2.5-tts-voiceclone','你好','苏打',fetcher,1000,undefined,()=>{}),/复刻|克隆/);
  assert.equal(requests,0);
});

test('long Qwen questions are split on sentence boundaries without losing any text', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts');
  const text='请说明项目的技术选型，以及这些选型解决了什么问题。'.repeat(35); const inputs=[];
  await requestSpeech(provider('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'),'qwen3-tts-flash',text,'Cherry',async(_url,init)=>{
    const {input}=JSON.parse(init.body); inputs.push(input.text); assert.ok(Array.from(input.text).length<=500);
    return sse(frame({output:{audio:{data:pcm},finish_reason:'stop'}}));
  },1000,undefined,()=>{});
  assert.ok(inputs.length>1);assert.equal(inputs.join(''),text);
});

test('compatible providers retain binary audio and malformed/error/empty streams surface errors with credentials redacted', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts'); const chunks=[];
  await requestSpeech(provider('https://relay.example/prefix/v1'),'custom-tts','你好','alloy',async(url)=>{
    assert.equal(url,'https://relay.example/prefix/v1/audio/speech');return new Response(new Uint8Array([1,2,3]));
  },1000,undefined,chunk=>chunks.push(chunk)); assert.equal(chunks[0].format,'encoded');
  for(const text of ['data: garbage\n\n',frame({error:{message:'fake-secret rejected'}}),'data: [DONE]\n\n']) {
    await assert.rejects(requestSpeech(provider(),'mimo-v2.5-tts','你好','苏打',async()=>sse(text),1000,undefined,()=>{}),error=>!error.message.includes('fake-secret'));
  }
});

test('abort cancels an open reader and prevents stale audio callbacks', async () => {
  const {requestSpeech} = load('src/lib/ttsProtocol.ts');const abort=new AbortController();let cancelled=false;let count=0;
  const response=new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});
  const pending=requestSpeech(provider(),'mimo-v2.5-tts','你好','苏打',async()=>response,1000,abort.signal,()=>count++);
  await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await assert.rejects(pending);
  assert.equal(cancelled,true);assert.equal(count,0);
});

test('cloud replay caches only complete audio, clears on settings change and never caches an interrupted request', async () => {
  const {createCloudSpeechSession}=load('src/lib/ttsSession.ts');let identity={};let loads=0;const outputs=[];
  const session=createCloudSpeechSession({identity:()=>identity,
    load:async(_text,signal,push)=>{loads++;signal.throwIfAborted();await push({format:'pcm16',sampleRate:24000,bytes:new Uint8Array([0,0])});},
    output:()=>{const out={writes:0,stopped:false,write:async()=>{out.writes++;},finish:()=>{},stop:()=>{out.stopped=true;}};outputs.push(out);return out;},
  });
  await session.speak('你好',()=>{},()=>{},new AbortController().signal);
  await session.speak('你好',()=>{},()=>{},new AbortController().signal);assert.equal(loads,1);
  identity={};await session.speak('你好',()=>{},()=>{},new AbortController().signal);assert.equal(loads,2);
  const abort=new AbortController();abort.abort();await assert.rejects(session.speak('再问',()=>{},()=>{},abort.signal));
  assert.equal(loads,2);session.clear();assert.ok(outputs.every(out=>out.writes===1));
});

test('PCM playback joins odd byte boundaries, schedules in order and stops all pending sources', async () => {
  const {createSpeechOutput}=load('src/lib/ttsPlayback.ts');const sources=[],samples=[],states=[];let closed=false;
  const context={currentTime:1,state:'running',destination:{},resume:async()=>{},close:async()=>{closed=true;},
    createBuffer:(_channels,length,rate)=>{const data=new Float32Array(length);samples.push({data,rate});return {duration:length/rate,getChannelData:()=>data};},
    createBufferSource:()=>{const source={connect(){},disconnect(){},start(at){source.at=at;},stop(){source.stopped=true;}};sources.push(source);return source;},
  };
  const output=createSpeechOutput(value=>states.push(value),()=>{},()=>context);
  await output.write({format:'pcm16',sampleRate:24000,bytes:new Uint8Array([0])});
  await output.write({format:'pcm16',sampleRate:24000,bytes:new Uint8Array([128,255,127])});
  await output.write({format:'pcm16',sampleRate:24000,bytes:new Uint8Array([0,0])});
  assert.equal(samples[0].data[0],-1);assert.ok(samples[0].data[1]>0.99);assert.ok(sources[1].at>=sources[0].at+2/24000);
  output.finish();output.stop();sources.forEach(source=>source.onended?.());
  assert.equal(states.at(-1),false);assert.equal(closed,true);assert.ok(sources.every(source=>source.stopped));
});

test('service and voice choices distinguish native services from compatible proxies', () => {
  const {ttsService,ttsVoices,defaultTtsVoice,isSpeechSynthesisModel}=load('src/lib/ttsConfig.ts');
  assert.equal(defaultTtsVoice(provider(),'mimo-v2.5-tts'),'苏打');
  assert.ok(ttsVoices(provider(),'mimo-v2.5-tts').some(voice=>voice.id==='冰糖'));
  const ali=provider('https://dashscope.aliyuncs.com/compatible-mode/v1');
  assert.equal(defaultTtsVoice(ali,'qwen3-tts-flash'),'Cherry');
  assert.equal(defaultTtsVoice(ali,'qwen-audio-3.1-tts-flash'),'longanhuan_v3.6');
  assert.equal(defaultTtsVoice(ali,'cosyvoice-v3-flash'),'longanyang');
  assert.equal(defaultTtsVoice(ali,'cosyvoice-v3.5-plus'),'');
  assert.equal(defaultTtsVoice(provider('https://relay.example/v1'),'my-tts'),'alloy');
  assert.equal(ttsService(provider('https://relay.example/v1'),'qwen3-tts-flash'),'compatible');
  assert.equal(ttsService(provider('invalid'),'custom'),'compatible');
  for(const model of ['mimo-v2.5-tts','qwen3-tts-flash','cosyvoice-v3-flash','tts-1','gpt-4o-mini-tts']) assert.equal(isSpeechSynthesisModel(model),true);
  for(const model of ['qwen-plus','mimo-v2.5-asr','qwen3-asr-flash']) assert.equal(isSpeechSynthesisModel(model),false);
});

test('native downloads omit authorization, upgrade official HTTP URLs and reject arbitrary hosts', async () => {
  const {requestSpeech}=load('src/lib/ttsProtocol.ts');
  const ali=provider('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');const chunks=[];let calls=0;
  await requestSpeech(ali,'qwen3-tts-flash','你好','Cherry',async(url,init)=>{
    calls++;
    if(calls===1)return Response.json({output:{audio:{url:'http://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/audio.wav?Signature=fake'}}});
    assert.ok(url.startsWith('https://dashscope-result-sg.'));assert.equal(Object.keys(init.headers).length,0);assert.equal(init.credentials,'omit');
    return new Response(new Uint8Array([1,2,3]));
  },1000,undefined,chunk=>chunks.push(chunk));
  assert.equal(calls,2);assert.equal(chunks[0].format,'encoded');
  for(const url of ['https://evil.example/a','https://user:secret@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a']) {
    calls=0;await assert.rejects(requestSpeech(ali,'qwen3-tts-flash','你好','Cherry',async()=>{calls++;return Response.json({output:{audio:{url}}});},1000,undefined,()=>{}),/非官方/);
    assert.equal(calls,1);
  }
  calls=0;await assert.rejects(requestSpeech(ali,'qwen3-tts-flash','你好','Cherry',async()=>++calls===1?Response.json({output:{audio:{url:'https://dashscope-result-sg.oss-ap-southeast-1.aliyuncs.com/a'}}}):new Response('',{status:403}),1000,undefined,()=>{}),/下载失败/);
});

test('SSE parser accepts fragmented UTF-8, comments, multiline events and final lines without a newline', async () => {
  const {requestSpeech}=load('src/lib/ttsProtocol.ts');let count=0;
  const text=': keepalive\n\ndata: {"choices":\ndata: [{"delta":{"audio":{"data":"'+pcm+'"}}}]}\n\ndata: [DONE]';
  const bytes=new TextEncoder().encode(text);
  const response=new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  await requestSpeech(provider(),'mimo-v2.5-tts','你好','alloy',async(_url,init)=>{assert.equal(JSON.parse(init.body).audio.voice,'苏打');return response;},1000,undefined,()=>count++);
  assert.equal(count,1);
});

test('timeouts, truncated streams, invalid base64 and oversized text cannot become successful speech', async () => {
  const {requestSpeech,splitSpeechText}=load('src/lib/ttsProtocol.ts');
  assert.throws(()=>splitSpeechText('问'.repeat(20001)),/过长/);assert.equal(splitSpeechText('  ').length,0);
  for(const text of [frame({choices:[{delta:{audio:{data:'not valid !!!!'}}}]}),frame({choices:[{delta:{audio:{data:pcm}}}]}),frame({code:'InvalidVoice',message:'bad voice'})]) {
    await assert.rejects(requestSpeech(provider(),'mimo-v2.5-tts','你好','苏打',async()=>sse(text),1000,undefined,()=>{}));
  }
  let cancelled=false;
  await assert.rejects(requestSpeech(provider(),'mimo-v2.5-tts','你好','苏打',async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}}),15,undefined,()=>{}),/超时/);
  assert.equal(cancelled,true);
  await assert.rejects(requestSpeech(provider('https://relay.example/v1'),'custom','你好','alloy',async()=>new Response(''),1000,undefined,()=>{}),/未返回音频/);
  await assert.rejects(requestSpeech(provider('https://relay.example/v1'),'custom','你好','alloy',async()=>Response.json({error:'bad'}),1000,undefined,()=>{}),/JSON/);
  await assert.rejects(requestSpeech(provider(),'mimo-v2.5-tts','你好',' ',async()=>sse(''),1000,undefined,()=>{}),/音色/);
});

test('cache evicts old questions, drops oversized entries and retries failed or interrupted synthesis', async () => {
  const {createCloudSpeechSession}=load('src/lib/ttsSession.ts');const identity={};let loads=0,fail=false,abortDuring;
  const session=createCloudSpeechSession({identity:()=>identity,load:async(text,_signal,push)=>{
    loads++;await push({format:'pcm16',bytes:new Uint8Array(text==='large'?8*1024*1024+2:2)});
    if(abortDuring)abortDuring.abort();if(fail)throw new Error('connection lost');
  },output:()=>({write:async()=>{},finish:()=>{},stop:()=>{}})});
  const speak=text=>session.speak(text,()=>{},()=>{},new AbortController().signal);
  for(let i=0;i<9;i++)await speak(String(i));await speak('0');assert.equal(loads,10);
  await speak('large');await speak('large');assert.equal(loads,12);
  fail=true;await assert.rejects(speak('failure'));fail=false;await speak('failure');assert.equal(loads,14);
  abortDuring=new AbortController();await assert.rejects(session.speak('cancel',()=>{},()=>{},abortDuring.signal));abortDuring=null;
  await speak('cancel');assert.equal(loads,16);
});

test('playback closes naturally, decodes encoded audio and discards decoding completed after stop', async () => {
  const {createSpeechOutput}=load('src/lib/ttsPlayback.ts');let source,closed=0,decode,started=0;const states=[];
  const buffer={length:2,duration:0.01};
  const context={state:'running',currentTime:0,destination:{},resume:async()=>{},close:async()=>{closed++;},
    decodeAudioData:async()=>buffer,createBufferSource:()=>source={connect(){},disconnect(){},start(){started++;},stop(){}},
  };
  const output=createSpeechOutput(state=>states.push(state),()=>{},()=>context);
  await output.write({format:'encoded',bytes:new Uint8Array([1])});output.finish();source.onended();
  assert.equal(closed,1);assert.equal(states.at(-1),false);
  await output.write({format:'encoded',bytes:new Uint8Array([1])});output.finish();output.stop();assert.equal(started,1);
  const late=createSpeechOutput(()=>{},()=>{},()=>({...context,decodeAudioData:()=>new Promise(resolve=>{decode=resolve;})}));
  const pending=late.write({format:'encoded',bytes:new Uint8Array([1])});await new Promise(resolve=>setTimeout(resolve,0));late.stop();decode(buffer);await pending;
  assert.equal(started,1);
});

test('playback rejects incomplete PCM and blocked audio, stopping synchronously on scheduling failure', async () => {
  const {createSpeechOutput}=load('src/lib/ttsPlayback.ts');let stopped=false;const errors=[];
  const context={state:'running',currentTime:0,destination:{},resume:async()=>{},close:async()=>{},
    createBuffer:()=>({getChannelData:()=>new Float32Array(1),duration:1}),
    createBufferSource:()=>({connect(){},disconnect(){},start(){throw new Error('device lost');},stop(){stopped=true;}}),
  };
  const output=createSpeechOutput(()=>{},()=>{},()=>context);await output.write({format:'pcm16',bytes:new Uint8Array([0])});assert.throws(()=>output.finish(),/不完整/);output.stop();
  const blocked=createSpeechOutput(()=>{},()=>{},()=>({...context,state:'suspended'}));await assert.rejects(blocked.write({format:'encoded',bytes:new Uint8Array([0])}),/获准/);blocked.stop();
  const failed=createSpeechOutput(()=>{},error=>errors.push(error),()=>context);await assert.rejects(failed.write({format:'pcm16',bytes:new Uint8Array([0,0])}),/device lost/);
  assert.equal(stopped,true);assert.equal(errors.length,1);
  const invalid=createSpeechOutput(()=>{},()=>{},()=>context);await assert.rejects(invalid.write({format:'pcm16',sampleRate:0.5,bytes:new Uint8Array([0,0])}),/采样率/);invalid.stop();
});
