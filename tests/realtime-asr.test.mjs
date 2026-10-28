import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
import { webcrypto } from 'node:crypto';
function load(overrides = {}) {
  const sandbox = { exports: {}, URL, crypto: webcrypto, Uint8Array, Int16Array, DataView, ArrayBuffer,
    setTimeout, clearTimeout, console, DOMException, AbortController, ...overrides };
  return evaluateFixture('src/lib/realtimeAsrProtocol.ts',sandbox);
}
test('real-time ASR waits for task-started, sends raw PCM, replaces partial text, and deduplicates final sentences', async () => {
  const { openRealtimeAsr } = load();
  const sent = [], results = [];
  let listener, taskId, disconnects = 0;
  const socket = { addListener(callback) { listener = callback; return () => {}; },
    async send(message) {
      sent.push(message);
      if (typeof message === 'string' && JSON.parse(message).header.action === 'run-task') {
        taskId = JSON.parse(message).header.task_id;
        listener({ type: 'Text', data: JSON.stringify({ header: { event: 'task-started', task_id: taskId } }) });
      }
    }, async disconnect() { disconnects++; } };
  const session = await openRealtimeAsr({ apiKey: 'synthetic-key', modelId: 'paraformer-realtime-v2',
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference' }, async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer synthetic-key');
      assert.ok(!url.includes('synthetic-key')); return socket;
    }, { onResult: result => results.push(result), onError: error => { throw error; } });
  session.push(new Int16Array([1000, -1000]));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(Array.from(sent.find(Array.isArray)), [232, 3, 24, 252]);
  const emit = (text, sentence_end) => listener({ type: 'Text', data: JSON.stringify({ header: { event: 'result-generated', task_id: taskId }, payload: { output: { sentence: { text, sentence_end, begin_time: 100 } } } }) });
  emit('订单', false); emit('订单幂等', false); emit('订单幂等怎么做？', true); emit('订单幂等怎么做？', true);
  assert.equal(results.length, 3); assert.equal(results[1].text, '订单幂等'); assert.equal(results[2].isFinal, true);
  await session.close(); assert.equal(disconnects, 1);
});

test('credentials cannot be sent to an arbitrary endpoint and task failures redact keys', async () => {
  const { openRealtimeAsr, validateRealtimeEndpoint } = load();
  for (const url of ['ws://dashscope.aliyuncs.com/api-ws/v1/inference', 'wss://dashscope.aliyuncs.com.evil.test/api-ws/v1/inference',
    'wss://dashscope.aliyuncs.com/api-ws/v1/inference?key=secret', 'wss://user:secret@dashscope.aliyuncs.com/api-ws/v1/inference']) {
    assert.throws(() => validateRealtimeEndpoint(url));
  }
  assert.equal(validateRealtimeEndpoint('wss://my-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference'), 'wss://my-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
  let listener, taskId, failure;
  const socket = { addListener(callback) { listener = callback; return () => {}; }, async disconnect() {}, async send(message) {
    if (typeof message !== 'string') return;
    const task = JSON.parse(message);
    if (task.header.action === 'run-task') { taskId = task.header.task_id; listener({ type: 'Text', data: JSON.stringify({ header: { event: 'task-started', task_id: taskId } }) }); }
  } };
  const capture = await openRealtimeAsr({ apiKey: 'private-dummy-key', modelId: 'paraformer-realtime-v2' }, async () => socket,
    { onResult() {}, onError(error) { failure = error; } });
  listener({ type: 'Text', data: JSON.stringify({ header: { event: 'task-failed', task_id: taskId, error_message: 'invalid private-dummy-key' } }) });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(failure && !failure.message.includes('private-dummy-key') && failure.message.includes('<redacted>'));
  await capture.close();
  await assert.rejects(openRealtimeAsr({ apiKey: 'private-dummy-key', modelId: 'paraformer-realtime-v2' }, async () => { throw new Error('connect private-dummy-key failed'); },
    { onResult() {}, onError() {} }), error => !error.message.includes('private-dummy-key') && error.message.includes('<redacted>'));
});

function fixture({ sendBinary = async () => {}, overrides = {} } = {}) {
  const { openRealtimeAsr } = load(overrides);
  const results = [], errors = [], states = [], sent = [];
  let callback, id, disconnects = 0;
  const emit = (event, payload) => callback({ type: 'Text', data: JSON.stringify({ header: { event, task_id: id }, payload }) });
  const socket = { addListener(fn) { callback = fn; return () => {}; }, async disconnect() { disconnects++; }, async send(data) {
    sent.push(data);
    if (typeof data !== 'string') return sendBinary(data);
    const action = JSON.parse(data).header;
    if (action.action === 'run-task') { id = action.task_id; emit('task-started'); }
    if (action.action === 'finish-task') { emit('result-generated', { output: { sentence: { begin_time: 5, text: '最终文本', sentence_end: true } } }); emit('task-finished'); }
  } };
  return { results, errors, states, sent, emit, raw:message=>callback(message), disconnects: () => disconnects,
    open: config => openRealtimeAsr({ apiKey: 'test-key', modelId: 'paraformer-realtime-v2', ...config }, async () => socket,
      { onResult: value => results.push(value), onError: value => errors.push(value), onState: value => states.push(value) }) };
}

test('Singapore official endpoints stream Fun-ASR and reject unavailable models before sending credentials', async () => {
  for (const endpoint of ['wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference', 'wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference']) {
    const f = fixture(); const capture = await f.open({ endpoint, modelId: 'fun-asr-realtime' });
    assert.equal(JSON.parse(f.sent[0]).payload.model, 'fun-asr-realtime');
    await capture.close();
    for (const modelId of ['paraformer-realtime-v2', 'fun-asr-realtime-2026-02-28']) {
      let connected = false;
      await assert.rejects(load().openRealtimeAsr({ endpoint, modelId, apiKey: 'synthetic' }, async () => { connected = true; },
        { onResult() {}, onError() {} }), /新加坡/);
      assert.equal(connected, false);
    }
  }
  const { validateRealtimeEndpoint } = load();
  for (const endpoint of ['wss://ws-example.ap-southeast-1.maas.aliyuncs.com.evil.test/api-ws/v1/inference',
    'wss://a.b.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference', 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference?key=secret']) {
    assert.throws(() => validateRealtimeEndpoint(endpoint));
  }
});

for (const modelId of ['fun-asr-realtime', 'fun-asr-realtime-2026-02-28']) {
  test(`${modelId} streams PCM with supported parameters and stable sentence IDs`, async () => {
    const f = fixture();
    const capture = await f.open({ modelId, vocabularyId: 'vocab-fun', language: 'zh', silenceMs: 900 });
    try {
      const request = JSON.parse(f.sent[0]);
      assert.equal(request.payload.model, modelId);
      assert.deepEqual(request.payload.parameters, { format: 'pcm', sample_rate: 16000,
        heartbeat: true, max_sentence_silence: 900, vocabulary_id: 'vocab-fun', language_hints: ['zh'] });
      capture.push(new Int16Array([1000, -1000]));
      await new Promise(resolve => setTimeout(resolve, 0));
      assert.deepEqual(Array.from(f.sent.find(Array.isArray)), [232, 3, 24, 252]);
      const emit = sentence => f.emit('result-generated', { output: { sentence } });
      emit({ sentence_id: 0, heartbeat: true, text: 'heartbeat' });
      emit({ sentence_id: 1, begin_time: 0, text: '', sentence_begin: true });
      emit({ sentence_id: 1, begin_time: 0, text: '线程', sentence_end: false });
      emit({ sentence_id: 1, begin_time: 170, text: '线程池', sentence_end: true });
      emit({ sentence_id: 1, begin_time: 180, text: '线程池', sentence_end: true });
      assert.equal(f.results.length, 2);
      assert.equal(f.results[0].id, f.results[1].id);
      assert.equal(f.results[1].isFinal, true);
      assert.equal(await capture.finish(), '线程池 最终文本');
      assert.equal(f.errors.length, 0);
    } finally { await capture.close(); }
  });
}

test('Paraformer retains its model-specific recognition parameters', async () => {
  const f = fixture(); const capture = await f.open();
  try {
    const parameters = JSON.parse(f.sent[0]).payload.parameters;
    assert.equal(parameters.semantic_punctuation_enabled, false);
    assert.equal(parameters.disfluency_removal_enabled, true);
  } finally { await capture.close(); }
});

test('finish drains PCM before requesting the final text and closing the transport', async () => {
  const f = fixture(); const capture = await f.open({ vocabularyId: 'vocab-123', language: 'zh', silenceMs: 50 });
  const parameters = JSON.parse(f.sent[0]).payload.parameters;
  assert.equal(parameters.max_sentence_silence, 200); assert.equal(parameters.vocabulary_id, 'vocab-123');
  assert.equal(parameters.language_hints[0], 'zh');
  capture.push(new Int16Array(1600));
  assert.equal(await capture.finish(), '最终文本');
  assert.equal(f.disconnects(), 1); assert.equal(f.states.at(-1), 'closed');
  assert.equal(f.errors.length, 0);
});

test('queue overflow and malformed service responses fail visibly and release the socket', async () => {
  const f = fixture({ sendBinary: () => new Promise(() => {}) });
  const capture = await f.open();
  capture.push(new Int16Array(1600)); capture.push(new Int16Array(32001));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(f.errors[0].message, /积压/); assert.equal(f.disconnects(), 1);
  await capture.close();
});

test('invalid models, vocabulary IDs and a cancelled session never open a socket', async () => {
  const { openRealtimeAsr } = load(); let connections = 0;
  const callbacks = { onResult() {}, onError() {} }; const connect = async () => { connections++; throw new Error('unexpected'); };
  for (const patch of [{modelId: 'mimo-asr'}, {vocabularyId: '../bad'}, {apiKey: 'bad\r\nheader'}]) {
    await assert.rejects(openRealtimeAsr({modelId:'paraformer-realtime-v2', apiKey:'dummy', ...patch}, connect, callbacks));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(openRealtimeAsr({modelId:'paraformer-realtime-v2', apiKey:'dummy', signal:controller.signal}, connect, callbacks), {name:'AbortError'});
  assert.equal(connections, 0);
});

test('an unresponsive PCM send has a bounded timeout instead of hanging finish forever', async () => {
  const f = fixture({ sendBinary: () => new Promise(() => {}), overrides: { setTimeout: (fn, ms) => setTimeout(fn, ms >= 3000 ? 40 : ms) } });
  const capture = await f.open(); capture.push(new Int16Array(1600));
  const result = await Promise.race([capture.finish().then(() => 'success', error => error.message), new Promise(resolve => setTimeout(() => resolve('HUNG'), 200))]);
  await capture.close();
  assert.match(result, /中断|超时|断开/);
});

test('long-session replay preserves 600 final sentences and recovers after repeated stable intervals', async()=>{
  let now=1000;
  const f=fixture({overrides:{Date:class extends Date{static now(){return now;}},setTimeout:(fn,ms)=>setTimeout(fn,ms>=500&&ms<3000?1:ms)}});
  const capture=await f.open();
  for(let part=0;part<6;part++) {
    for(let i=0;i<100;i++) {
      const sentence={begin_time:i*3000,text:`第 ${part*100+i} 个定稿`,sentence_end:true};
      f.emit('result-generated',{output:{sentence}});f.emit('result-generated',{output:{sentence}});
    }
    now+=61000;f.emit('task-finished');await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(f.results.length,600);assert.equal(f.errors.length,0);assert.equal(f.states.at(-1),'ready');
  await capture.close();
});

test('repeated unstable connections exhaust the retry budget, malformed data fails, and heartbeats stay invisible',async()=>{
  const f=fixture({overrides:{setTimeout:(fn,ms)=>setTimeout(fn,ms>=500&&ms<3000?1:ms)}});
  const capture=await f.open();
  f.raw({type:'Binary',data:[1]});f.raw({type:'Text',data:JSON.stringify({header:{task_id:'unrelated'}})});
  f.emit('result-generated',{output:{sentence:{heartbeat:true,text:'heartbeat'}}});assert.equal(f.results.length,0);
  for(let i=0;i<4;i++){f.raw({type:'Close',data:{}});await new Promise(resolve=>setTimeout(resolve,10));}
  assert.match(f.errors[0].message,/多次中断/);assert.equal(f.states.at(-1),'closed');await capture.close();
  const malformed=fixture();const session=await malformed.open();malformed.raw({type:'Text',data:'not json'});
  await new Promise(resolve=>setTimeout(resolve,0));assert.match(malformed.errors[0].message,/响应异常/);await session.close();
});

test('a service that never starts its task times out and frees the socket',async()=>{
  const {openRealtimeAsr}=load({setTimeout:(fn,ms)=>setTimeout(fn,ms===10000?20:ms)});
  let closed=0;
  await assert.rejects(openRealtimeAsr({modelId:'paraformer-realtime-v2',apiKey:'synthetic'},async()=>({addListener(){return()=>{};},async send(){},async disconnect(){closed++;}}),{onResult(){},onError(){}}),/就绪/);
  assert.equal(closed,1);
});

test('a dropped connection reconnects without accepting late text from the retired stream', async () => {
  const { openRealtimeAsr } = load();
  const sockets = [], results = [], states = [];
  const connect = async () => {
    const socket = { callback: null, taskId: '', async disconnect() {}, addListener(callback) { this.callback = callback; return () => {}; },
      async send(message) { if (typeof message !== 'string') return; const task = JSON.parse(message);
        if (task.header.action === 'run-task') { this.taskId = task.header.task_id; this.callback({ type: 'Text', data: JSON.stringify({ header: { event: 'task-started', task_id: this.taskId } }) }); }
      } };
    sockets.push(socket); return socket;
  };
  const capture = await openRealtimeAsr({ apiKey: 'dummy', modelId: 'paraformer-realtime-v2' }, connect,
    { onResult: result => results.push(result), onError: error => { throw error; }, onState: state => states.push(state) });
  const retired = sockets[0];
  retired.callback({ type: 'Close', data: { code: 1006 } });
  retired.callback({ type: 'Text', data: JSON.stringify({ header: { event: 'result-generated', task_id: retired.taskId }, payload: { output: { sentence: { begin_time: 1, text: '断线之后的过期结果', sentence_end: true } } } }) });
  assert.equal(results.length, 0);
  await new Promise(resolve => setTimeout(resolve, 650));
  assert.equal(sockets.length, 2);
  assert.ok(states.includes('reconnecting'));
  await capture.close();
});
