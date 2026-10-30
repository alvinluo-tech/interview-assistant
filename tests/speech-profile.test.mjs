import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {evaluateFixture} from './compile-fixture.mjs';
import {randomUUID} from 'node:crypto';
function load(file,deps={}){return evaluateFixture(file,{exports:{},console,Error,DOMException,TextEncoder,TextDecoder,AbortController,setTimeout,clearTimeout,URL,Response,ReadableStream,Uint8Array,atob,performance,crypto:{randomUUID},require:name=>deps[name]??load(path.resolve(path.dirname(file),name.replace(/\.js$/,'')+'.ts'),deps)});}
const provider=(url='https://dashscope-intl.aliyuncs.com/compatible-mode/v1')=>({baseUrl:url});

test('speech preferences separate input, answer and reading language and migrate old values',()=>{
 const api=load('src/lib/speechProfile.ts');const defaults=api.normalizeSpeechProfile();
 assert.equal(defaults.inputLanguage,'auto');assert.equal(defaults.answerLanguage,'zh-CN');
 const migrated=api.normalizeSpeechProfile(undefined,'en-US');assert.equal(migrated.answerLanguage,'en-US');
 const mixed=api.normalizeSpeechProfile({inputLanguage:'auto',answerLanguage:'en-US',accent:'cantonese',rate:1.2});
 assert.equal(api.recognitionLanguage(mixed),'auto');assert.match(api.languagePrompt(mixed,'interview'),/英语|English/);
 assert.throws(()=>api.normalizeSpeechProfile({rate:Infinity}));
});

test('the same model and profile select only documented language and dialect parameters',()=>{
 const {resolveSpeechVoice}=load('src/lib/speechCatalog.ts');
 const mimo=resolveSpeechVoice(provider('https://api.xiaomimimo.com/v1'),'mimo-v2.5-tts','苏打',{language:'en-US',accent:'standard',rate:1});assert.equal(mimo.voice,'Mia');
 const qwen=resolveSpeechVoice(provider(),'qwen3-tts-flash','Cherry',{language:'yue-HK',accent:'cantonese',rate:1});assert.equal(qwen.voice,'Rocky');assert.equal(qwen.languageHint,'Chinese');
 const cq=resolveSpeechVoice(provider(),'qwen-audio-3.1-tts-flash','',{language:'zh-CN',accent:'chongqing',rate:1});assert.equal(cq.voice,'longanhuan_v3.1');assert.match(cq.instruction,/重庆/);assert.equal(cq.support,'documented');
 const english=resolveSpeechVoice(provider(),'qwen-audio-3.1-tts-flash','longanhuan_v3.1',{language:'en-US',accent:'standard',rate:1});assert.equal(english.voice,'Abby_v3.1');
 const northeast=resolveSpeechVoice(provider('https://dashscope.aliyuncs.com/compatible-mode/v1'),'cosyvoice-v3-flash','longanyang',{language:'zh-CN',accent:'northeastern',rate:1});assert.equal(northeast.voice,'longlaotie_v3');
 assert.throws(()=>resolveSpeechVoice(provider(),'cosyvoice-v3-flash','longanyang',{language:'zh-CN',accent:'northeastern',rate:1}),/新加坡|音色|支持/);
});

test('language instructions cover mock questions, hints and feedback without inventing experience',()=>{
 const api=load('src/lib/speechProfile.ts');const profile=api.normalizeSpeechProfile({answerLanguage:'en-US',reportLanguage:'zh-CN'});
 assert.match(api.languagePrompt(profile,'mock'),/英语|English/);assert.match(api.languagePrompt(profile,'report'),/中文/);
 assert.equal(api.speechRenderSpec(profile,'Tell me about Redis.').language,'en-US');
 assert.equal(api.speechRenderSpec(api.normalizeSpeechProfile({accent:'cantonese'}),'中文问题').language,'yue-HK');
 assert.equal(api.speechRenderSpec(api.normalizeSpeechProfile({answerLanguage:'follow'}),'Tell me about Redis.').language,'en-US');
});

test('speaker routing never equates an unmatched voice with the interviewer and handles revisions',()=>{
 const {SpeakerTurnRouter}=load('src/lib/speakerRouting.ts');const actions=[];const router=new SpeakerTurnRouter(action=>actions.push(action));
 router.text({id:'q',text:'请介绍项目',final:true});assert.equal(actions.length,0);
 router.speaker('q',{role:'candidate',score:0.9,revision:1});assert.equal(actions.at(-1).kind,'candidate');
 router.speaker('q',{role:'interviewer',score:0.95,revision:2});assert.equal(actions.at(-1).kind,'question');
 const count=actions.length;router.speaker('q',{role:'interviewer',score:0.95,revision:2});assert.equal(actions.length,count);
 router.text({id:'noise',text:'电视背景声',final:true});router.speaker('noise',{role:'unknown',score:0.2,revision:1});assert.equal(actions.length,count);
 router.close();router.text({id:'late',text:'迟到',final:true});router.speaker('late',{role:'interviewer',score:1,revision:1});assert.equal(actions.length,count);
});

test('bounded audio timeline keeps the exact PCM range for realtime speaker matching',()=>{
 const {AudioTimeline}=load('src/lib/speakerRouting.ts');const timeline=new AudioTimeline(16000,2);
 timeline.push(Int16Array.from([1,2,3,4]));assert.deepEqual(Array.from(timeline.range(0,0.25)),[1,2,3,4]);
 timeline.reset();assert.equal(timeline.range(0,1),null);
});

test('Singapore CosyVoice keeps workspace origin and obeys duplex task boundaries',async()=>{
 const {requestSpeech}=load('src/lib/ttsProtocol.ts');let listener,task,closed=0;const sent=[],audio=[];
 const connect=async(url,options)=>{assert.equal(url,'wss://ws-test.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');assert.equal(options.headers.Authorization,'Bearer test-key');return {
  addListener(fn){listener=fn;return()=>{listener=undefined;};},async disconnect(){closed++;},async send(value){const event=JSON.parse(value);sent.push(event);task=event.header.task_id;
   if(event.header.action==='run-task')queueMicrotask(()=>listener({type:'Text',data:JSON.stringify({header:{task_id:task,event:'task-started'}})}));
   if(event.header.action==='finish-task')queueMicrotask(()=>{listener({type:'Binary',data:[0,0,255,127]});listener({type:'Text',data:JSON.stringify({header:{task_id:task,event:'task-finished'}})});});
  }};};
 await requestSpeech({id:'test',name:'test',authMode:'bearer',models:[],lastFetchedAt:null,...provider('https://ws-test.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1'),apiKey:'test-key'},'cosyvoice-v3-flash','问题正文','longanyang',async()=>assert.fail('Singapore CosyVoice must use WS'),1000,undefined,chunk=>audio.push(chunk),{language:'en-US',accent:'standard',rate:1.1},connect);
 assert.equal(sent[0].payload.parameters.voice,'longanyang');assert.equal(sent[0].payload.parameters.language_hints[0],'en');assert.equal(sent[0].payload.parameters.rate,1.1);assert.equal(sent[1].payload.input.text,'问题正文');assert.equal(audio.length,1);assert.equal(audio[0].sampleRate,24000);assert.equal(closed,1);assert.equal(listener,undefined);
});

test('cancel while connecting closes a late CosyVoice socket and never publishes audio',async()=>{
 const {requestBailianSpeechSocket}=load('src/lib/ttsSocket.ts');let ready,closed=0;const controller=new AbortController();
 const pending=requestBailianSpeechSocket({...provider(),apiKey:'test'},'cosyvoice-v3-flash','问题','longanyang',undefined,undefined,controller.signal,()=>assert.fail('late audio'),1000,()=>new Promise(resolve=>{ready=resolve;}));
 controller.abort();await assert.rejects(pending,/abort/i);ready({disconnect:async()=>{closed++;}});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
});

test('language and dialect render specs map to the documented HTTP request bodies',async()=>{
 const {requestSpeech}=load('src/lib/ttsProtocol.ts');const pcm=Buffer.from([0,0,255,127]).toString('base64');
 const providers=[{...provider('https://api.xiaomimimo.com/v1'),model:'mimo-v2.5-tts',spec:{language:'en-US',accent:'standard',rate:1.1}},
  {...provider(),model:'qwen-audio-3.1-tts-flash',spec:{language:'zh-CN',accent:'chongqing',rate:0.9}},
  {...provider(),model:'qwen3-tts-flash',spec:{language:'yue-HK',accent:'cantonese',rate:1}}];
 for(const p of providers){let sent;await requestSpeech({id:'test',name:'test',apiKey:'test-key',authMode:'bearer',models:[],lastFetchedAt:null,...p},p.model,'Question 正文','alloy',async(url,init)=>{
  sent=JSON.parse(init.body);assert.equal(new URL(url).origin,new URL(p.baseUrl).origin);
  const event=p.model.startsWith('mimo')?{choices:[{delta:{audio:{data:pcm}},finish_reason:'stop'}]}:{output:{audio:{data:pcm},finish_reason:'stop'}};
  return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'content-type':'text/event-stream'}});
 },1000,undefined,()=>{},p.spec);
 if(p.model.startsWith('mimo')){assert.equal(sent.audio.voice,'Mia');assert.equal(sent.messages[1].content,'Question 正文');assert.match(sent.messages[0].content,/English/);}
 else if(p.model.startsWith('qwen-audio')){assert.equal(sent.input.voice,'longanhuan_v3.1');assert.match(sent.input.instruction,/重庆/);assert.equal(sent.input.rate,0.9);assert.equal(sent.input.language_hints.length,1);}
 else{assert.equal(sent.input.voice,'Rocky');assert.equal(sent.input.language_type,'Chinese');assert.equal(sent.input.instruction,undefined);}
 }
});

test('anonymous speech and auxiliary translations never enter interview history as facts',()=>{
 const {assembleInterviewHistory}=load('src/lib/aiContext.ts');
 const history=assembleInterviewHistory([{id:'a',role:'INTERVIEWER',text:'背景电视剧',metadata:{speaker:{role:'unknown'}}},{id:'b',role:'INTERVIEWER',text:'Explain Redis',metadata:{speaker:{role:'interviewer'},translation:{text:'错误译文'}}},{id:'c',role:'ASSISTANT',text:'My real answer',metadata:{origin:'candidate_response',speaker:{role:'candidate'}}}],'next');
 assert.match(JSON.stringify(history),/Explain Redis/);assert.match(JSON.stringify(history),/My real answer/);assert.doesNotMatch(JSON.stringify(history),/背景电视剧|错误译文/);
});

test('CosyVoice failures, empty completions and stalled playback always close their socket',async()=>{
 const {requestBailianSpeechSocket}=load('src/lib/ttsSocket.ts');
 for(const scenario of ['close','provider-error','empty','bad-json','blocked-playback']){
  let listener,closed=0;const key='private-test-key';const connect=async()=>({addListener(fn){listener=fn;return()=>{listener=undefined;};},disconnect:async()=>{closed++;},send:async value=>{
   const request=JSON.parse(value);if(request.header.action!=='run-task')return;const id=request.header.task_id;
   queueMicrotask(()=>{if(scenario==='close')listener({type:'Close'});else if(scenario==='bad-json')listener({type:'Text',data:'{'});else{
    if(scenario==='blocked-playback')listener({type:'Binary',data:[0,0]});
    listener({type:'Text',data:JSON.stringify({header:{task_id:id,event:scenario==='provider-error'?'task-failed':'task-finished',error_message:'Failed '+key}})});
   }});
  }});
  const pending=requestBailianSpeechSocket({...provider(),apiKey:key},'cosyvoice-v3-flash','问题','longanyang',undefined,undefined,undefined,()=>scenario==='blocked-playback'?new Promise(()=>{}):undefined,30,connect);
  await assert.rejects(pending,error=>{assert.ok(!String(error.message).includes(key));return true;});assert.ok(closed>0);assert.equal(listener,undefined);
 }
 await assert.rejects(requestBailianSpeechSocket({...provider('https://unknown.example/v1'),apiKey:'key'},'cosyvoice-v3-flash','问题','longanyang',undefined,undefined,undefined,()=>{},30,async()=>assert.fail('unknown host')),/地域/);
});

test('voice capability lookup handles unknown hosts, unsupported accents and experimental styles',()=>{
 const api=load('src/lib/speechCatalog.ts');
 assert.equal(api.speechRegion({baseUrl:'not a url'}),undefined);
 assert.equal(api.resolveSpeechVoice({baseUrl:'https://relay.example/v1'},'custom-tts','my-voice',{language:'en-US',accent:'standard',rate:1}).support,'unknown');
 assert.throws(()=>api.resolveSpeechVoice(provider(),'qwen3-tts-flash','Cherry',{language:'zh-CN',accent:'chongqing',rate:1}),/支持/);
 assert.equal(api.resolveSpeechVoice({baseUrl:'https://api.xiaomimimo.com/v1'},'mimo-v2.5-tts','苏打',{language:'zh-CN',accent:'chongqing',rate:1}).support,'experimental');
});
