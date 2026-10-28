import test from 'node:test';
import assert from 'node:assert/strict';
import { recognizeSpeech, joinTranscript } from '../artifacts/byok-tests/speechProtocol.js';
import { usesLiveSpeech } from '../artifacts/byok-tests/aiConfig.js';
const provider = { id: 'mimo', name: 'MiMo', baseUrl: 'https://speech.example/v1', authMode: 'bearer', apiKey: 'test-credential', models: [], lastFetchedAt: null };

test('MiMo uploads WAV through chat audio and consumes actual SSE transcript deltas', async () => {
  const deltas = [];
  const text = await recognizeSpeech(provider, 'mimo-v2.5-asr', new Blob(['test-wav']), { lang: 'zh-CN', onDelta: delta => deltas.push(delta) }, async (url, init) => {
    assert.equal(url, 'https://speech.example/v1/chat/completions');
    assert.equal(init.headers.Authorization, 'Bearer test-credential');
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true); assert.equal(body.model, 'mimo-v2.5-asr');
    assert.equal(body.asr_options.language, 'zh');
    assert.equal(body.messages[0].content[0].type, 'input_audio');
    assert.equal(body.messages[0].content[0].input_audio.data, `data:audio/wav;base64,${Buffer.from('test-wav').toString('base64')}`);
    return new Response('data: {"choices":[{"delta":{"reasoning_content":"internal","content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"世界"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }, 1000);
  assert.equal(text, '你好世界'); assert.deepEqual(deltas, ['你好', '世界']);
});
test('other providers retain the existing multipart transcription protocol', async () => {
  const text = await recognizeSpeech(provider, 'whisper-1', new Blob(['audio']), { lang: 'en-US' }, async (url, init) => {
    assert.ok(url.endsWith('/audio/transcriptions')); assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('language'), 'en');
    return Response.json({ text: 'recognized' });
  }, 1000);
  assert.equal(text, 'recognized');
});
test('segment merge keeps English spacing and removes exact overlapping context', () => {
  assert.equal(joinTranscript('我的项目是订单', '是订单系统'), '我的项目是订单系统');
  assert.equal(joinTranscript('hello', 'world'), 'hello world');
  assert.equal(joinTranscript('', '你好'), '你好');
});
test('MiMo automatically uses progressive subtitles and an explicit file mode disables previews', () => {
  const settings = { routes: { stt: { modelId: 'mimo-v2.5-asr' } } };
  assert.equal(usesLiveSpeech(settings), true);
  assert.equal(usesLiveSpeech({ ...settings, speechInputMode: 'file' }), false);
  assert.equal(usesLiveSpeech({ routes: { stt: { modelId: 'whisper-1' } } }), false);
});
