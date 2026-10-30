import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, defaultAiSettings, normalizeBaseUrl, validateAiSettings, resolveAiRoute, isRoleConfigured, mergeDiscoveredModels, removeProvider } from '../artifacts/byok-tests/aiConfig.js';
import * as configApi from '../artifacts/byok-tests/aiConfig.js';
import { aiHeaders, consumeChat, discoverModels, withAiRequest, testChatModel, transcriptionLanguage } from '../artifacts/byok-tests/aiProtocol.js';

const provider = (patch = {}) => ({ id: 'local', name: 'Local', baseUrl: 'http://localhost:11434/v1', authMode: 'none', apiKey: '', models: [{ id: 'custom/model', name: 'Custom', source: 'custom' }], lastFetchedAt: null, ...patch });
const settings = () => ({ ...defaultAiSettings(), providers: [provider()], routes: { chat: { providerId: 'local', modelId: 'custom/model' }, vision: null, stt: null, tts: null } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('Bailian preset and saved realtime routes support Fun-ASR alongside Paraformer', () => {
  const connection = createProvider('dashscope'); connection.apiKey = 'synthetic-key';
  for (const modelId of ['fun-asr-realtime', 'fun-asr-realtime-2026-02-28', 'paraformer-realtime-v2']) {
    assert.ok(connection.models.some(model => model.id === modelId));
    const config = { ...defaultAiSettings(), providers: [connection], speechInputMode: 'realtime',
      routes: { chat: null, vision: null, tts: null, stt: { providerId: connection.id, modelId } } };
    assert.equal(validateAiSettings(config).routes.stt.modelId, modelId);
  }
});

const singaporeUrl = 'https://ws-example.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

test('speech recognition models cannot send a text-only test to chat/completions', async () => {
  let requests = 0;
  for (const model of ['fun-asr', 'fun-asr-flash-2026-06-15', 'fun-asr-realtime']) {
    await assert.rejects(testChatModel(provider({ baseUrl: singaporeUrl }), model, async () => {
      requests++;
      return json({ error: { message: 'url error, please check url!' } }, 400);
    }), /语音识别.*对话/);
  }
  assert.equal(requests, 0, 'The invalid text test must be rejected before sending a request');
});

test('speech synthesis models cannot be tested as text chat', async () => {
  let requests = 0;
  for (const model of ['mimo-v2.5-tts','qwen3-tts-flash','qwen-audio-3.1-tts-flash','cosyvoice-v3-flash']) {
    await assert.rejects(testChatModel(provider(),model,async()=>{requests++;return json({});}),/语音合成/);
  }
  assert.equal(requests,0);
  assert.ok(createProvider('mimo').models.some(model=>model.id==='mimo-v2.5-tts'));
});

test('recognition model classification covers audio families without blocking text-capable multimodal models', () => {
  for (const model of ['fun-asr', 'fun-asr-flash-2026-06-15', 'fun-asr-realtime', 'fun-asr-flash-8k-realtime',
    'paraformer-v2', 'paraformer-realtime-v2', 'sensevoice-v1', 'whisper-1', 'openai/whisper-1', 'mimo-v2-asr', 'qwen3-asr-flash', 'qwen-audio-asr']) {
    assert.equal(configApi.isSpeechRecognitionModel(model), true, model);
  }
  for (const model of ['qwen-plus', 'qwen3.5-plus', 'qwen-omni-turbo', 'qwen2.5-omni', 'gpt-4o', 'custom/model', 'my-asr-aware-chat']) {
    assert.equal(configApi.isSpeechRecognitionModel(model), false, model);
  }
});

function singaporeSettings() {
  const connection = createProvider('dashscope-sg'); connection.apiKey = 'synthetic-key'; connection.baseUrl = singaporeUrl;
  return { ...defaultAiSettings(), providers: [connection], speechInputMode: 'realtime',
    routes: { chat: null, vision: null, tts: null, stt: { providerId: connection.id, modelId: 'fun-asr-realtime' } } };
}

test('a saved realtime model automatically selects its required streaming transport', () => {
  const config = singaporeSettings();
  for (const mode of [undefined, 'auto', 'file', 'segmented', 'realtime']) {
    assert.equal(validateAiSettings({...config,speechInputMode:mode}).speechInputMode,'realtime');
  }
});

test('unsupported Bailian file recognition is readable for repair but cannot be saved or used as a transcription route', () => {
  const config=singaporeSettings();
  config.providers[0].models.push({id:'fun-asr',name:'Fun-ASR',source:'discovered'});
  config.routes.stt.modelId='fun-asr';config.speechInputMode='auto';
  assert.equal(validateAiSettings(config,true).routes.stt.modelId,'fun-asr');
  assert.throws(()=>validateAiSettings(config),/文件识别.*fun-asr-realtime/);
  assert.throws(()=>resolveAiRoute(config,'stt'),/文件识别.*fun-asr-realtime/);
});
test('Singapore preset and existing custom connections infer the matching realtime endpoint', () => {
  const config = singaporeSettings();
  assert.equal(createProvider('dashscope-sg').baseUrl, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.deepEqual(config.providers[0].models.filter(model => configApi.isSpeechRecognitionModel(model.id)).map(model => model.id), ['fun-asr-realtime']);
  assert.ok(config.providers[0].models.some(model => model.id === 'qwen3-tts-flash'));
  assert.equal(configApi.resolveRealtimeEndpoint(validateAiSettings(config)), 'wss://ws-example.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');
  assert.equal(config.realtimeEndpoint, undefined);
  config.realtimeEndpoint = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
  assert.throws(() => validateAiSettings(config), /地域/);
  config.realtimeEndpoint = undefined;
  config.providers[0].models.push({ id: 'fun-asr-realtime-2026-02-28', name: 'Snapshot', source: 'custom' });
  config.routes.stt.modelId = 'fun-asr-realtime-2026-02-28';
  assert.throws(() => validateAiSettings(config), /新加坡/);
});

test('Bailian discovery reads its regional catalog, pages through audio models and keeps workspace authentication', async () => {
  const connection = provider({ baseUrl: singaporeUrl, authMode: 'bearer', apiKey: 'catalog-key' });
  const requests = [];
  const models = await discoverModels(connection, async (url, init) => {
    requests.push(url);
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://dashscope-intl.aliyuncs.com');
    assert.equal(parsed.pathname, '/api/v1/models');
    assert.equal(parsed.searchParams.get('service_site'), 'international');
    assert.equal(init.headers.Authorization, 'Bearer catalog-key');
    assert.equal(init.headers['X-DashScope-WorkSpace'], 'ws-example');
    assert.equal(init.redirect, 'error');
    const page = Number(parsed.searchParams.get('page_no'));
    return json({ success: true, output: { total: 2, page_no: page, page_size: 1,
      models: [{ model: page === 1 ? 'qwen-plus' : 'fun-asr-realtime', name: page === 1 ? 'Qwen' : 'Fun-ASR' }] } });
  });
  assert.equal(requests.length, 2);
  assert.deepEqual(models.map(model => model.id), ['fun-asr-realtime', 'qwen-plus']);
});

test('Beijing catalog uses its own origin and unsupported catalogs fall back to compatibility discovery', async () => {
  for (const baseUrl of ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://ws-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1']) {
    const requests = [];
    const models = await discoverModels(provider({ baseUrl }), async url => {
      requests.push(url);
      if (new URL(url).pathname === '/api/v1/models') {
        assert.equal(new URL(url).origin, new URL(baseUrl).origin);
        return json({ error: { message: 'not found' } }, 404);
      }
      return json({ data: [{ id: 'custom-chat' }] });
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1], `${baseUrl}/models`);
    assert.equal(models[0].id, 'custom-chat');
  }
});

test('catalog failures, invalid pages and cancellation never produce a misleading successful list', async () => {
  const connection = provider({ baseUrl: singaporeUrl, authMode: 'bearer', apiKey: 'catalog-key' });
  for (const [payload, status] of [
    [{ error: { message: 'bad catalog-key' } }, 401],
    [{ success: false, code: 'Denied', message: 'bad catalog-key' }, 200],
    [{ output: { total: 2, models: [] } }, 200],
    [{ output: { total: 2001, models: [] } }, 200],
    [{ output: { total: 1, models: [{ model: '' }] } }, 200],
  ]) {
    let requests = 0;
    await assert.rejects(discoverModels(connection, async () => { requests++; return json(payload, status); }),
      error => !error.message.includes('catalog-key'));
    assert.equal(requests, 1);
  }
  const controller = new AbortController(); let requests = 0;
  await assert.rejects(discoverModels(connection, async () => {
    requests++; controller.abort();
    return json({ output: { total: 2, models: [{ model: 'qwen-plus' }] } });
  }, controller.signal));
  assert.equal(requests, 1);
});

test('lookalike and proxy addresses retain their configured model URL without forwarding keys to Bailian', async () => {
  for (const baseUrl of ['https://dashscope-intl.aliyuncs.com.evil.test/compatible-mode/v1', 'https://proxy.example/compatible-mode/v1',
    'http://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope-intl.aliyuncs.com/custom/v1']) {
    const models = await discoverModels(provider({ baseUrl }), async url => {
      assert.equal(url, `${baseUrl}/models`); return json({ data: [{ id: 'own-model' }] });
    });
    assert.equal(models[0].id, 'own-model');
  }
});

test('catalog rejects repeated pages, changing totals and excessive pagination, and accepts an empty catalog', async () => {
  const connection = provider({ baseUrl: singaporeUrl });
  for (const mode of ['repeated', 'changed', 'too-many-pages']) {
    let page = 0;
    await assert.rejects(discoverModels(connection, async () => {
      page++;
      return json({ output: { total: mode === 'changed' && page === 2 ? 3 : mode === 'too-many-pages' ? 21 : 2,
        page_no: page, models: [{ model: mode === 'repeated' ? 'same' : `model-${page}` }] } });
    }), /分页/);
    assert.ok(page <= 20);
  }
  assert.deepEqual(await discoverModels(connection, async () => json({ output: { total: 0, models: [] } })), []);
});
const streaming = (value, width = 1) => {
  const bytes = new TextEncoder().encode(value);
  let cursor = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (cursor >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(cursor, cursor + width)); cursor += width;
  } }), { headers: { 'content-type': 'text/event-stream' } });
};

test('a marked mock AI response cannot be consumed as a real answer or transcript', async () => {
  let consumed = false;
  const fetcher = async () => new Response('{"text":"fixed fixture"}', { headers: { 'x-mianshi-test-service': 'mock-ai' } });
  await assert.rejects(withAiRequest(provider(), 'audio/transcriptions', {}, 1000, async () => { consumed = true; return 'fixed fixture'; }, fetcher), /测试服务.*真实|模拟服务.*真实/);
  assert.equal(consumed, false);
});
test('transcription converts UI locales to ISO language codes and leaves auto unspecified', () => {
  assert.equal(transcriptionLanguage('zh-CN'), 'zh');
  assert.equal(transcriptionLanguage('en-US'), 'en');
  assert.equal(transcriptionLanguage('zh_Hans'), 'zh');
  assert.equal(transcriptionLanguage('auto'), undefined);
  assert.equal(transcriptionLanguage(), undefined);
});

test('base URLs accept pasted endpoints and preserve gateway prefixes', () => {
  assert.equal(normalizeBaseUrl(' https://EXAMPLE.com/compatible/v1/chat/completions/ '), 'https://example.com/compatible/v1');
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1/models'), 'http://localhost:11434/v1');
  assert.equal(normalizeBaseUrl('https://example.com/'), 'https://example.com');
  for (const bad of ['file:///secret', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com?key=hidden', 'https://example.com/#fragment', 'not-a-url']) assert.throws(() => normalizeBaseUrl(bad));
});
test('local no-key routes are ready and never send Authorization', () => {
  const value = validateAiSettings(settings());
  assert.equal(isRoleConfigured(value, 'chat'), true);
  assert.deepEqual(aiHeaders(provider({ apiKey: 'leftover-value' })), {});
  assert.equal(resolveAiRoute(value, 'vision').modelId, 'custom/model');
  assert.equal(isRoleConfigured(value, 'stt'), false);
});
test('native JSON key ordering does not make a saved configuration appear dirty', () => {
  const value = validateAiSettings(settings());
  const fromNative = JSON.parse(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item));
  assert.equal(JSON.stringify(validateAiSettings(fromNative)), JSON.stringify(value));
});
test('roles can use separate providers, credentials and model IDs', () => {
  const value = settings();
  value.providers.push(provider({ id: 'speech', baseUrl: 'https://speech.example/v1', authMode: 'bearer', apiKey: 'test-secret' }));
  value.routes.stt = { providerId: 'speech', modelId: 'custom/model' };
  assert.equal(resolveAiRoute(value, 'stt').provider.apiKey, 'test-secret');
  assert.equal(resolveAiRoute(value, 'chat').provider.baseUrl, 'http://localhost:11434/v1');
});
test('incomplete bearer credentials are never reported as ready', () => {
  const value = settings(); value.providers[0].authMode = 'bearer';
  assert.equal(isRoleConfigured(value, 'chat'), false);
  assert.throws(() => validateAiSettings(value));
  assert.doesNotThrow(() => validateAiSettings(value, true));
});
test('invalid routes, duplicate models and header injection are rejected', () => {
  const value = settings(); value.routes.chat.modelId = 'missing';
  assert.throws(() => validateAiSettings(value));
  const duplicate = settings(); duplicate.providers[0].models.push(duplicate.providers[0].models[0]);
  assert.throws(() => validateAiSettings(duplicate));
  const injection = settings(); injection.providers[0].apiKey = 'test\r\nX-Other: injected';
  assert.throws(() => validateAiSettings(injection));
});
test('discovery merges duplicates while preserving custom and assigned missing models', () => {
  const p = provider({ models: [
    { id: 'private', name: 'Mine', source: 'custom' },
    { id: 'assigned', name: 'Assigned', source: 'discovered' },
    { id: 'stale', name: 'Old', source: 'discovered' },
  ] });
  const merged = mergeDiscoveredModels(p, [{ id: 'private' }, { id: 'new' }, { id: 'new' }], { ...defaultAiSettings().routes, chat: { providerId: 'local', modelId: 'assigned' } });
  assert.deepEqual(merged.map(m => m.id).sort(), ['assigned', 'new', 'private']);
  assert.equal(merged.find(m => m.id === 'private').name, 'Mine');
  assert.equal(merged.find(m => m.id === 'assigned').source, 'custom');
});
test('deleting a provider clears every dependent route without mutating original', () => {
  const value = settings(); value.routes.stt = value.routes.chat;
  const next = removeProvider(value, 'local');
  assert.equal(next.providers.length, 0);
  assert.ok(Object.values(next.routes).every(r => r === null));
  assert.equal(value.providers.length, 1);
});
test('GET models handles pagination and encodes cursors', async () => {
  const requests = [];
  const models = await discoverModels(provider(), async (url, init) => {
    requests.push({ url, init });
    return requests.length === 1 ? json({ data: [{ id: 'a/b' }], has_more: true, last_id: 'a/b' }) : json({ data: [{ id: 'c' }, { id: 'a/b' }] });
  });
  assert.equal(requests[0].url, 'http://localhost:11434/v1/models');
  assert.equal(requests[1].url, 'http://localhost:11434/v1/models?after=a%2Fb');
  assert.equal(requests[0].init.redirect, 'error');
  assert.deepEqual(models.map(m => m.id), ['a/b', 'c']);
});
test('unavailable and malformed discovery never invent models', async () => {
  await assert.rejects(discoverModels(provider(), async () => json({ message: 'missing' }, 404)), /404/);
  await assert.rejects(discoverModels(provider(), async () => json({ models: [] })), /data/);
  await assert.rejects(discoverModels(provider(), async () => json({ data: [{ id: 123 }] })), /无效/);
  assert.deepEqual(await discoverModels(provider(), async () => json({ data: [] })), []);
});
test('cyclic model pagination fails instead of looping', async () => {
  let count = 0;
  await assert.rejects(discoverModels(provider(), async () => { count++; return json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' }); }), /分页游标/);
  assert.equal(count, 2);
});
test('UTF-8 split streams and unterminated final SSE lines are decoded', async () => {
  const deltas = [];
  const stream = 'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"世界"}}]}';
  assert.equal(await consumeChat(streaming(stream), t => deltas.push(t)), '你好世界');
  assert.deepEqual(deltas, ['你好', '世界']);
});
test('SSE inline errors and empty replies surface as failures', async () => {
  await assert.rejects(consumeChat(streaming('data: {"error":{"message":"bad model"}}\n')), /bad model/);
  await assert.rejects(consumeChat(streaming('data: [DONE]\n')), /没有返回/);
});
test('non-streaming compatible replies are supported', async () => {
  assert.equal(await consumeChat(json({ choices: [{ message: { content: 'OK' } }] })), 'OK');
});
test('HTTP and stream errors redact credentials before reaching UI', async () => {
  const p = provider({ apiKey: 'test-secret-123', authMode: 'bearer' });
  await assert.rejects(withAiRequest(p, 'models', {}, 1000, r => r.json(), async () => json({ error: { message: 'invalid test-secret-123' } }, 401)), e => {
    assert.ok(!e.message.includes(p.apiKey)); assert.match(e.message, /401/); return true;
  });
  await assert.rejects(withAiRequest(p, 'chat/completions', {}, 1000, consumeChat, async () => streaming('data: {"error":{"message":"test-secret-123"}}\n')), e => !e.message.includes(p.apiKey));
});
test('cancelling before fetch sends no request', async () => {
  const controller = new AbortController(); controller.abort();
  let fetched = false;
  await assert.rejects(withAiRequest(provider(), 'models', {}, 1000, r => r.json(), async () => { fetched = true; return json({}); }, controller.signal));
  assert.equal(fetched, false);
});
test('timeouts remain active after headers until response consumption finishes', async () => {
  await assert.rejects(withAiRequest(provider(), 'models', {}, 10, r => r.text(), async (_url, init) => {
    return new Response(new ReadableStream({ start(controller) { init.signal.addEventListener('abort', () => controller.error(init.signal.reason)); } }));
  }), /超时/);
});
test('model test sends only a short real chat request and consumes its stream', async () => {
  const result = await testChatModel(provider(), 'custom/model', async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'custom/model'); assert.equal(body.stream, true);
    assert.equal(body.messages.length, 1);
    return streaming('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n');
  });
  assert.equal(result.sample, 'OK'); assert.ok(result.latencyMs >= 0);
});
