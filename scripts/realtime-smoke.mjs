// Exercise the actual Rust WebSocket plugin using a local synthetic Paraformer server.
// Only the injected test factory redirects the URL; production endpoint validation is unchanged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import { WebSocketServer } from 'ws';
import { DesktopCdp, delay } from './desktop-cdp.mjs';

const executable = path.resolve('artifacts/audio-smoke.exe');
assert.ok((await readFile(executable)).includes(Buffer.from('com.mianlingai.clone.audiosmoke')));
const requests = [], frames = [];
let closed = 0;
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
server.on('connection', (socket, request) => {
  requests.push(request.headers); let id, connectionFrames=0;
  const event = (event, sentence) => socket.send(JSON.stringify({header:{event,task_id:id},payload:{output:{sentence}}}));
  socket.on('close', () => closed++);
  socket.on('message', (data, binary) => {
    if (binary) {
      frames.push(Buffer.from(data));
      if (++connectionFrames === 1) { event('result-generated',{text:'订单',begin_time:0,sentence_end:false}); event('result-generated',{text:'订单幂等',begin_time:0,sentence_end:false}); }
      return;
    }
    const task = JSON.parse(data.toString());
    if (task.header.action === 'run-task') { id = task.header.task_id; event('task-started'); }
    if (task.header.action === 'finish-task') {
      event('result-generated',{text:'订单幂等怎么实现？',begin_time:0,sentence_end:true});
      event('result-generated',{text:'订单幂等怎么实现？',begin_time:0,sentence_end:true});
      event('task-finished');
    }
  });
});
const child = spawn(executable, [], { windowsHide:true, stdio:'ignore', env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19394 --autoplay-policy=no-user-gesture-required'} });
const desktop = new DesktopCdp(19394);
const mock = new DesktopCdp(19394,'mock');
try {
  await desktop.connect();
  const compiled = ts.transpileModule(await readFile('src/lib/realtimeAsrProtocol.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const plugin = (await readFile('node_modules/@tauri-apps/plugin-websocket/dist-js/index.js','utf8')).replace(/^import .*$/m,'').replace(/^export .*$/m,'');
  const result = await desktop.evaluate(`(async () => {
    const exports = {}; ${compiled}
    const invoke = (name,args) => window.__TAURI_INTERNALS__.invoke(name,args);
    // The public Tauri Channel wire format, preserving indexed message order.
    class Channel {
      constructor() { this.next=0; this.pending=new Map(); this.id=window.__TAURI_INTERNALS__.transformCallback(raw => {
        if ('end' in raw) { window.__TAURI_INTERNALS__.unregisterCallback(this.id); return; }
        this.pending.set(raw.index,raw.message);
        while(this.pending.has(this.next)) { const value=this.pending.get(this.next); this.pending.delete(this.next++); this.onmessage?.(value); }
      }); }
      __TAURI_TO_IPC_KEY__() { return '__CHANNEL__:'+this.id; }
    }
    ${plugin}
    const results=[], errors=[], states=[];
    const capture = await exports.openRealtimeAsr({apiKey:'synthetic-native-test',modelId:'paraformer-realtime-v2'},
      (_url,config) => WebSocket.connect('ws://127.0.0.1:${server.address().port}',config),
      {onResult:value=>results.push(value),onError:error=>errors.push(error.message),onState:value=>states.push(value)});
    for(let i=0;i<20;i++) { capture.push(new Int16Array([1000,-1000,0,32767])); await new Promise(resolve=>setTimeout(resolve,20)); }
    const final = await capture.finish();
    return {results,errors,states,final};
  })()`);
  assert.equal(requests[0].authorization,'Bearer synthetic-native-test');
  assert.equal(frames.length,20); assert.deepEqual([...frames[0]],[232,3,24,252,0,0,255,127]);
  assert.deepEqual(result.results.map(value=>value.text),['订单','订单幂等','订单幂等怎么实现？']);
  assert.equal(result.final,'订单幂等怎么实现？'); assert.deepEqual(result.errors,[]);
  assert.equal(result.states.at(-1),'closed');
  await delay(100); assert.equal(closed,1);
  console.log('PASS native authenticated WebSocket, continuous binary PCM, partial replacement, final deduplication and orderly close');
  const provider={id:'local-smoke',name:'合成语音测试',baseUrl:'http://127.0.0.1:1/v1',authMode:'bearer',apiKey:'synthetic-native-test',models:['local-chat','paraformer-realtime-v2'].map(id=>({id,name:id,source:'custom'})),lastFetchedAt:null};
  await desktop.invoke('cmd_ai_save_settings',{config:{version:2,providers:[provider],routes:{chat:{providerId:provider.id,modelId:'local-chat'},vision:null,stt:{providerId:provider.id,modelId:'paraformer-realtime-v2'},tts:null},timeoutMs:90000,ttsVoice:'alloy',speechInputMode:'realtime'}});
  console.log('STEP mock ASR configuration saved');
  const current=await desktop.invoke('cmd_data_read');
  const record={id:'mock-realtime-smoke',title:'实时字幕测试',type:'MOCK_INTERVIEW',status:'ACTIVE',createdAt:Date.now(),messages:[{id:'q1',role:'INTERVIEWER',text:'请介绍订单幂等',createdAt:Date.now(),metadata:{turnKind:'NEW'}}],metadata:{mock:true,config:{difficultyLabel:'应届生',turnBudget:8,basicsRatio:50,assistMode:false}}};
  await desktop.invoke('cmd_data_commit',{key:'interviewSessions',expected:current.data.interviewSessions??null,value:[record]});
  console.log('STEP mock session saved');
  await desktop.evaluate("Array.from(document.querySelectorAll('aside button')).find(button=>button.textContent.startsWith('模拟面试')).click()");
  await desktop.click('继续面试');await mock.connect();
  console.log('STEP connected to the actual mock window');
  await mock.evaluate(`(() => {
    window.__testNativeFailures=[];
    window.__realtimeSmokeUrl='ws://127.0.0.1:${server.address().port}';
    navigator.mediaDevices.getUserMedia=async()=>{
      if(window.__denyRealtimeMic)throw new DOMException('Synthetic denial','NotAllowedError');
      const context=new AudioContext({sampleRate:48000}),osc=context.createOscillator(),gain=context.createGain(),destination=context.createMediaStreamDestination();
      gain.gain.value=0.2;osc.connect(gain);gain.connect(destination);osc.start();await context.resume();
      const stream=destination.stream,track=stream.getAudioTracks()[0],stop=track.stop.bind(track);
      track.stop=()=>{stop();void context.close();};return stream;
    };
  })()`);
  console.log('STEP installed isolated synthetic microphone');
  await mock.click('空格说话');await mock.waitFor("document.querySelector('[role=status]')?.textContent.includes('订单幂等')");
  await delay(1000);await mock.click('结束录音');await mock.waitFor("document.querySelector('textarea')?.value.includes('订单幂等怎么实现？')");
  const after=await desktop.invoke('cmd_data_read');
  assert.equal(after.data.interviewSessions[0].messages.length,1,'Voice input must wait for the user to submit');
  console.log('PASS actual mock interview: live subtitles before stop, finalized editable draft, no automatic submission');
  await mock.evaluate('window.__denyRealtimeMic=true');await mock.click('空格说话');
  await mock.waitFor("document.body.innerText.includes('麦克风权限被拒绝')");
  await delay(100);assert.equal(closed,requests.length,'Permission rejection must close its already-open ASR task');
  console.log('PASS microphone permission errors are visible in the mock window');
  await writeFile('artifacts/realtime-smoke-results.json',JSON.stringify({nativeWebSocket:true,frames:frames.length,mockLivePreview:true,mockDraftOnly:true,microphonePermissionFeedback:true,partialReplacement:true,finalDeduplicated:true,closed:true,syntheticServerOnly:true},null,2));
} catch(error) {
  try{console.error(await mock.evaluate('document.body.innerText'));}catch{}
  try{console.error(await mock.evaluate('window.__testNativeFailures'));}catch{}
  throw error;
} finally {
  await desktop.invoke('cmd_quit_app').catch(()=>child.kill()); desktop.close();mock.close();
  for(const client of server.clients) client.terminate();
  await new Promise(resolve=>server.close(resolve));
}
