import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';

function harness({ sampleRate = 48000, suspended = false, denied = false, stt = true, speechRouteError, transcribe, permission, live = false, autoAnswer = false, chat, nativeStart, realtime = false } = {}) {
  let now = 1000;
  let processor;
  let resumed = 0;
  let stopped = 0;
  let requests = 0;
  let permissionRequests = 0;
  const wavs = [];
  let context;
  const timers = new Map();
  const nativeListeners = new Map();
  const nativeCallbacks = [];
  let nativeStops = 0;
  let realtimeCallbacks, realtimeFrames = 0, realtimeCloses = 0;
  const registerNative = (event, handler) => {
    nativeListeners.set(event, handler);
    nativeCallbacks.push({ event, handler });
    return () => { if (nativeListeners.get(event) === handler) nativeListeners.delete(event); };
  };
  const track = { label: 'Test microphone', enabled: true, getSettings: () => ({ deviceId: 'test' }), stop: () => stopped++ };
  const settings = { 'interview.autoAnswer': autoAnswer, 'interview.silenceGateMs': 300 };
  const mocks = {
    './aiSettings': { getAiSettings: () => realtime ? ({ speechInputMode: 'realtime' }) : ({}) },
    './realtimeAsr': { openConfiguredRealtimeAsr: async callbacks => { realtimeCallbacks = callbacks; return { push: () => { realtimeFrames++; }, close: async () => { realtimeCloses++; } }; } },
    './aiConfig': { isRoleConfigured: (_s, role) => role !== 'stt' || stt,
      resolveAiRoute() { if (speechRouteError) throw new Error(speechRouteError); if (!stt) throw new Error('尚未配置语音转写模型'); return {}; } },
    './bridge': { onEvent: registerNative, listenEvent: async (event, handler) => registerNative(event, handler),
      startSystemAudioCapture: nativeStart ?? (async () => ({ devices: [{ id: 'speaker-a', name: '测试耳机', is_default: true }], sampleRate: 16000, channels: 1 })),
      stopSystemAudioCapture: async () => { nativeStops++; }, setSystemAudioExcludedOutputs: async () => {} },
    './ai': { liveSpeechEnabled: () => live, buildInterviewSystemPrompt: () => '', chatStream: chat ?? (async () => '测试回答'), transcribeAudio: async (wav, options) => { requests++; wavs.push(wav); return transcribe ? transcribe(wav, options) : '请介绍一下你的项目经历'; } },
    './backend': { readData: (_key, fallback) => fallback, createSession: async () => ({ id: 'test-session' }), updateSession: async () => {}, completeSession: async () => {} },
    './examEngine': { getSolverState: () => ({ turns: [] }) },
    './store': { getSetting: (key, fallback) => settings[key] ?? fallback },
    './events': { bus: { emit() {} } },
  };
  const sandbox = {
    exports: {}, require: name => { if (!(name in mocks)) throw new Error(`Unmocked dependency: ${name}`); return mocks[name]; },
    window: { setInterval: fn => { const id = timers.size + 1; timers.set(id, fn); return id; }, clearInterval: id => timers.delete(id), setTimeout: fn => { fn(); return 1; }, clearTimeout() {} },
    navigator: { mediaDevices: { getUserMedia: async () => { permissionRequests++; if (permission) await permission; if (denied) throw new DOMException('Permission denied', 'NotAllowedError'); return { getTracks: () => [track], getAudioTracks: () => [track] }; }, addEventListener() {}, removeEventListener() {} } },
    AudioContext: class {
      constructor() { this.sampleRate = sampleRate; this.state = suspended ? 'suspended' : 'running'; context = this; }
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createScriptProcessor() { processor = { connect() {}, disconnect() {} }; return processor; }
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
      async resume() { resumed++; this.state = 'running'; }
      async suspend() { this.state = 'suspended'; }
      async close() { this.state = 'closed'; }
      addEventListener() {}
      removeEventListener() {}
    },
    performance: { now: () => now }, console, Blob, DOMException, AbortController, atob, btoa, setTimeout, clearTimeout,
    Int16Array, Float32Array, Uint8Array, ArrayBuffer, DataView,
  };
  vm.createContext(sandbox);
  const code = ts.transpileModule(readFileSync('src/lib/interviewEngine.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const microphoneModule = { exports: {} };
  const microphoneCode = ts.transpileModule(readFileSync('src/lib/microphone.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  sandbox.microphoneModule = microphoneModule;
  vm.runInContext(`(function(exports){ ${microphoneCode}\n})(microphoneModule.exports)`, sandbox);
  mocks['./microphone'] = microphoneModule.exports;
  const speechModule = { exports: {} };
  sandbox.speechModule = speechModule;
  mocks['./aiConfig.js'] = {}; mocks['./aiProtocol.js'] = {};
  const speechCode = ts.transpileModule(readFileSync('src/lib/speechProtocol.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(`(function(exports){ ${speechCode}\n})(speechModule.exports)`, sandbox);
  mocks['./speechProtocol'] = speechModule.exports;
  const knowledgeModule = { exports: {} };
  sandbox.knowledgeModule = knowledgeModule;
  const knowledgeCode = ts.transpileModule(readFileSync('src/lib/knowledgeContext.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInContext(`(function(exports){ ${knowledgeCode}\n})(knowledgeModule.exports)`, sandbox);
  mocks['./knowledgeContext'] = knowledgeModule.exports;
  vm.runInContext(code, sandbox);
  const engine = sandbox.exports;
  engine.exposeEngineDebug();
  return { engine, sandbox, wavs, track, get permissionRequests() { return permissionRequests; }, get resumed() { return resumed; }, get stopped() { return stopped; }, get requests() { return requests; },
    async start(source = 'MICROPHONE') { await engine.startInterview({ goalId: null, resumeId: null, materialIds: [], audioSource: source }); await engine.beginListening(source); },
    get nativeStops() { return nativeStops; },
    get realtimeFrames() { return realtimeFrames; },
    get realtimeCloses() { return realtimeCloses; },
    realtimeResult(result) { realtimeCallbacks?.onResult(result); },
    get nativeListenerCount() { return nativeListeners.size; },
    nativeCallbacks,
    emitNative(event, payload) { nativeListeners.get(event)?.(payload); },
    systemFeed(amplitude = 3277) {
      now += 100;
      const samples = new Int16Array(1600).fill(amplitude);
      nativeListeners.get('system-audio-chunk')?.({ pcmBase64: Buffer.from(samples.buffer).toString('base64'), volume: Math.abs(amplitude) / 32768 * 800 });
    },
    feed(amplitude = 0.1) { now += 2048 / sampleRate * 1000; if (context.state === 'running') processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(amplitude) } }); },
    async silence() { now += 1000; for (const tick of timers.values()) tick(); for (let i = 0; i < 10; i++) await Promise.resolve(); },
    get timerCount() { return timers.size; },
  };
}

test('continuous ASR sends live PCM, displays partial text and answers only finalized sentences', async () => {
  const h = harness({ realtime: true, autoAnswer: true }); await h.start();
  for (let i = 0; i < 10; i++) h.feed();
  assert.ok(h.realtimeFrames > 0);
  assert.equal(h.requests, 0, 'continuous mode must not issue segmented WAV requests');
  h.realtimeResult({ id: 'sentence-1', text: '请介绍', isFinal: false });
  assert.equal(h.engine.getInterviewEngineState().partial, '请介绍');
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
  h.realtimeResult({ id: 'sentence-1', text: '请介绍一下支付幂等设计', isFinal: true });
  for (let i = 0; i < 25; i++) await Promise.resolve();
  assert.equal(h.engine.getInterviewEngineState().messages.filter(message => message.role === 'INTERVIEWER').length, 1);
  await h.engine.endInterview(false);
  assert.ok(h.realtimeCloses > 0);
  h.realtimeResult({ id: 'late', text: '已结束之后的语音', isFinal: true });
  assert.equal(h.engine.getInterviewEngineState().messages.filter(message => message.role === 'INTERVIEWER').length, 1);
});

test('unsupported speech configuration is explained before opening the microphone or sending audio', async () => {
  const reason='当前 fun-asr 属于百炼文件识别模型，请改选 fun-asr-realtime';
  const h=harness({speechRouteError:reason});await h.start();
  assert.equal(h.engine.getInterviewEngineState().status,'error');
  assert.equal(h.engine.getInterviewEngineState().errorMessage,reason);
  assert.equal(h.permissionRequests,0);assert.equal(h.requests,0);
});

test('online interview receives PCM16 system playback and submits its correct WAV duration', async () => {
  const h = harness(); await h.start('SPEAKER');
  for (let i = 0; i < 10; i++) h.systemFeed();
  await h.silence();
  assert.equal(h.requests, 1);
  assert.equal(h.wavs[0].size, 44 + 16000 * 2);
  assert.equal(h.permissionRequests, 0);
  assert.match(h.engine.getInterviewEngineState().audio.deviceLabel, /测试耳机/);
  await h.engine.endInterview(false);
  assert.equal(h.nativeListenerCount, 0);
});

test('system capture failures stop listening and become visible instead of fabricating subtitles', async () => {
  const h = harness(); await h.start('SPEAKER');
  h.emitNative('system-audio-error', { error: '播放设备已断开，请重新连接耳机' });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.engine.getInterviewEngineState().status, 'error');
  assert.match(h.engine.getInterviewEngineState().errorMessage, /播放设备已断开/);
  assert.equal(h.nativeListenerCount, 0);
  assert.equal(h.requests, 0);
});

test('queued system audio from an old capture cannot enter the resumed session', async () => {
  const h = harness(); await h.start('SPEAKER');
  const old = h.nativeCallbacks.find(entry => entry.event === 'system-audio-chunk').handler;
  const stops = h.nativeStops;
  await h.engine.pauseListening();
  assert.ok(h.nativeStops > stops, 'pause must stop native playback capture');
  await h.engine.resumeListening();
  old({ pcmBase64: Buffer.from(new Int16Array(1600).fill(3277).buffer).toString('base64'), volume: 80 });
  assert.equal(h.sandbox.window.__ml_audio().buffered, 0);
  await h.engine.endInterview(false);
});

test('queued old native events delivered to the new listener are rejected by capture ID', async () => {
  let sequence = 0;
  const h = harness({ nativeStart: async () => ({ captureId: `capture-${++sequence}`, sampleRate: 16000, channels: 1, devices: [] }) });
  await h.start('SPEAKER');
  await h.engine.pauseListening();
  await h.engine.resumeListening();
  const pcmBase64 = Buffer.from(new Int16Array(1600).fill(3277).buffer).toString('base64');
  h.emitNative('system-audio-chunk', { captureId: 'capture-1', pcmBase64, volume: 80 });
  h.emitNative('system-audio-error', { captureId: 'capture-1', error: 'old stream stopped' });
  assert.equal(h.sandbox.window.__ml_audio().buffered, 0);
  assert.equal(h.engine.getInterviewEngineState().status, 'listening');
  h.emitNative('system-audio-chunk', { captureId: 'capture-2', pcmBase64, volume: 80 });
  assert.ok(h.sandbox.window.__ml_audio().buffered > 0);
  await h.engine.endInterview(false);
});

test('current tagged audio arriving before the start reply is buffered until identity is known', async () => {
  let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const h = harness({ nativeStart: () => pending });
  const start = h.start('SPEAKER');
  for (let i = 0; i < 100 && h.nativeListenerCount < 2; i++) await Promise.resolve();
  const pcmBase64 = Buffer.from(new Int16Array(1600).fill(3277).buffer).toString('base64');
  h.emitNative('system-audio-chunk', { captureId: 'stale', pcmBase64, volume: 80 });
  h.emitNative('system-audio-chunk', { captureId: 'current', pcmBase64, volume: 80 });
  ready({ captureId: 'current', sampleRate: 16000, channels: 1, devices: [] });
  await start;
  assert.equal(h.sandbox.window.__ml_audio().buffered, 1600);
  await h.engine.endInterview(false);
});

test('silent system packets never invoke ASR even if the reported native volume is wrong', async () => {
  const h = harness(); await h.start('SPEAKER');
  for (let i = 0; i < 20; i++) {
    h.emitNative('system-audio-chunk', { pcmBase64: Buffer.alloc(3200).toString('base64'), volume: 800 });
  }
  await h.silence();
  assert.equal(h.requests, 0);
  assert.equal(h.engine.getInterviewEngineState().audio.level, 0);
  await h.engine.endInterview(false);
});

test('broken system PCM and failed native startup expose recoverable errors', async () => {
  const h = harness(); await h.start('SPEAKER');
  h.emitNative('system-audio-chunk', { pcmBase64: Buffer.from([1]).toString('base64'), volume: 80 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.engine.getInterviewEngineState().status, 'error');
  assert.match(h.engine.getInterviewEngineState().errorMessage, /数据格式异常/);
  assert.equal(h.requests, 0);
  assert.equal(h.nativeListenerCount, 0);
  const unavailable = harness({ nativeStart: () => { throw new Error('播放设备初始化失败'); } });
  await unavailable.start('SPEAKER');
  assert.equal(unavailable.engine.getInterviewEngineState().status, 'error');
  assert.match(unavailable.engine.getInterviewEngineState().errorMessage, /初始化失败/);
  assert.equal(unavailable.nativeListenerCount, 0);
});

for (const sampleRate of [48000, 44100, 16000, 96000]) {
  test(`${sampleRate} Hz: continuous voice keeps the silence gate open across block boundaries`, async () => {
    const h = harness({ sampleRate }); await h.start();
    for (let i = 0; i < 100; i++) h.feed();
    assert.equal(h.sandbox.window.__ml_audio().lastVoiceAgoMs, 0);
    await h.silence();
    assert.equal(h.requests, 1);
    const wav = new DataView(await h.wavs[0].arrayBuffer());
    assert.equal(wav.getUint32(24, true), 16000);
    assert.equal(wav.getUint16(22, true), 1);
    const expectedSamples = 100 * 2048 / sampleRate * 16000;
    assert.ok(Math.abs((h.wavs[0].size - 44) / 2 - expectedSamples) < 2);
    await h.engine.endInterview(false);
    assert.equal(h.timerCount, 0);
  });
}
test('a suspended AudioContext is resumed before listening starts', async () => {
  const h = harness({ suspended: true }); await h.start();
  assert.equal(h.resumed, 1);
  for (let i = 0; i < 10; i++) h.feed();
  await h.silence(); assert.equal(h.requests, 1);
});
test('permission failure becomes a visible, recoverable engine error', async () => {
  const h = harness({ denied: true }); await h.start().catch(() => {});
  assert.equal(h.engine.getInterviewEngineState().status, 'error');
  assert.match(h.engine.getInterviewEngineState().errorMessage, /麦克风.*权限|权限.*麦克风/);
});
test('missing STT is rejected before requesting microphone access', async () => {
  const h = harness({ stt: false }); await h.start().catch(() => {});
  assert.equal(h.engine.getInterviewEngineState().status, 'error');
  assert.match(h.engine.getInterviewEngineState().errorMessage, /语音转写/);
  assert.equal(h.permissionRequests, 0);
});
test('silence never starts transcription', async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 100; i++) h.feed(0);
  await h.silence();
  assert.equal(h.requests, 0);
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
});
test('a single loud click followed by silence never becomes a question', async () => {
  const h = harness(); await h.start();
  h.feed(0.3);
  for (let i = 0; i < 20; i++) h.feed(0);
  await h.silence();
  assert.equal(h.requests, 0);
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
});

test('manual transcription flushes captured audio without waiting for silence', async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 10; i++) h.feed();
  h.engine.flushUtterance();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(h.requests, 1);
  assert.equal(h.engine.getInterviewEngineState().messages[0].text, '请介绍一下你的项目经历');
});
test('pause disables the track, discards unfinished audio, and resume reconnects', async () => {
  const h = harness(); await h.start();
  for (let i = 0; i < 10; i++) h.feed();
  await h.engine.pauseListening(); await h.silence();
  assert.equal(h.track.enabled, false); assert.equal(h.requests, 0);
  assert.equal(h.engine.getInterviewEngineState().status, 'paused');
  await h.engine.resumeListening();
  assert.equal(h.permissionRequests, 2);
  for (let i = 0; i < 10; i++) h.feed();
  await h.silence(); assert.equal(h.requests, 1);
});
test('ending a session aborts STT and ignores its late result', async () => {
  let resolve; let signal;
  const h = harness({ transcribe: (_wav, opts) => { signal = opts.signal; return new Promise(r => { resolve = r; }); } });
  await h.start(); for (let i = 0; i < 10; i++) h.feed(); await h.silence();
  assert.equal(h.engine.getInterviewEngineState().audio.pending, 1);
  await h.engine.endInterview(false);
  assert.equal(signal.aborted, true);
  resolve('这是结束之后返回的过期转写');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
  assert.equal(h.engine.getInterviewEngineState().status, 'ended');
  assert.equal(h.stopped, 1); assert.equal(h.timerCount, 0);
});
test('transcription failures preserve listening and expose the reason before any message', async () => {
  const h = harness({ transcribe: () => { throw new Error('HTTP 401: 服务鉴权失败'); } });
  await h.start(); for (let i = 0; i < 10; i++) h.feed(); await h.silence();
  assert.equal(h.engine.getInterviewEngineState().status, 'listening');
  assert.match(h.engine.getInterviewEngineState().errorMessage, /HTTP 401/);
  assert.equal(h.engine.getInterviewEngineState().audio.pending, 0);
});
test('reentrant start requests open the microphone once', async () => {
  const h = harness();
  await Promise.all([h.engine.beginListening('MICROPHONE'), h.engine.beginListening('MICROPHONE')]);
  assert.equal(h.permissionRequests, 1);
});
test('end during microphone permission wait closes late capture without restarting listening', async () => {
  let resolve;
  const h = harness({ permission: new Promise(r => { resolve = r; }) });
  const starting = h.start();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(h.permissionRequests, 1);
  await h.engine.endInterview(false);
  resolve(); await starting;
  assert.equal(h.engine.getInterviewEngineState().status, 'ended');
  assert.equal(h.engine.getInterviewEngineState().sessionId, null);
  assert.equal(h.stopped, 1);
});
test('end immediately after start prevents pending initialization from requesting audio', async () => {
  const h = harness();
  const starting = h.engine.beginListening('MICROPHONE');
  await h.engine.endInterview(false); await starting;
  assert.equal(h.permissionRequests, 0);
  assert.equal(h.engine.getInterviewEngineState().status, 'ended');
});

test('live previews appear before silence and only corrected final text triggers an answer', async () => {
  let chatCalls = 0;
  const h = harness({ live: true, autoAnswer: true, chat: async () => { chatCalls++; return '参考答案'; },
    transcribe: (_wav, opts) => { opts.onDelta?.('识别'); opts.onDelta?.('中的文字'); return '最终校正后的完整问题'; } });
  await h.start();
  for (let i = 0; i < 60; i++) h.feed();
  for (let i = 0; i < 15; i++) await Promise.resolve();
  assert.equal(h.requests, 1);
  assert.equal(h.engine.getInterviewEngineState().liveTranscripts[0].phase, 'preview');
  assert.ok(h.engine.getInterviewEngineState().liveTranscripts[0].text.length > 0);
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
  assert.equal(chatCalls, 0);
  await h.silence(); for (let i = 0; i < 25; i++) await Promise.resolve();
  assert.equal(h.requests, 2);
  assert.equal(chatCalls, 1);
  assert.equal(h.engine.getInterviewEngineState().liveTranscripts.length, 0);
  assert.equal(h.engine.getInterviewEngineState().messages[0].text, '最终校正后的完整问题');
});
test('a late preview cannot overwrite a final transcript', async () => {
  let resolvePreview; let emitPreview;
  let calls = 0;
  const h = harness({ live: true, transcribe: (_wav, opts) => {
    if (++calls === 1) { emitPreview = opts.onDelta; return new Promise(resolve => { resolvePreview = resolve; }); }
    opts.onDelta?.('正确的问题'); return '正确的问题已经完整识别';
  } });
  await h.start(); for (let i = 0; i < 60; i++) h.feed();
  await h.silence();
  emitPreview('过期字幕'); resolvePreview('过期字幕');
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(h.engine.getInterviewEngineState().messages[0].text, '正确的问题已经完整识别');
  assert.equal(h.engine.getInterviewEngineState().liveTranscripts.length, 0);
});
test('pause cancels active live previews and removes temporary subtitles', async () => {
  let signal; let emit;
  const h = harness({ live: true, transcribe: (_wav, opts) => { signal = opts.signal; emit = opts.onDelta; emit('尚未说完'); return new Promise(() => {}); } });
  await h.start(); for (let i = 0; i < 60; i++) h.feed();
  await h.engine.pauseListening();
  assert.equal(signal.aborted, true);
  emit('迟到的字幕');
  assert.equal(h.engine.getInterviewEngineState().liveTranscripts.length, 0);
  assert.equal(h.engine.getInterviewEngineState().messages.length, 0);
});
test('final questions received during a streamed answer are queued instead of dropped', async () => {
  let finish; let chatCalls = 0;
  const h = harness({ autoAnswer: true, chat: async () => { chatCalls++; if (chatCalls === 1) return new Promise(resolve => { finish = resolve; }); return '第二个回答'; } });
  await h.start(); for (let i = 0; i < 10; i++) h.feed(); await h.silence();
  assert.equal(chatCalls, 1);
  for (let i = 0; i < 10; i++) h.feed(); await h.silence();
  finish('第一个回答');
  for (let i = 0; i < 40; i++) await Promise.resolve();
  assert.equal(chatCalls, 2);
});
