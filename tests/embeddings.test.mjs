import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function load({ model = 'emb-1', chat = true, respond } = {}) {
  const batches = [];
  const settings = {
    timeoutMs: 30000,
    embeddingModel: model || undefined,
    routes: { chat: chat ? { providerId: 'p', modelId: 'chat' } : null, vision: null, stt: null, tts: null },
    providers: [{ id: 'p', name: '示例', baseUrl: 'https://model.invalid/v1', apiKey: 'k', authMode: 'bearer', models: [] }],
  };
  const sandbox = {
    exports: {},
    require: name => {
      if (name === './aiSettings') return { getAiSettings: () => settings };
      if (name === './aiTransport') return { aiFetch: () => {} };
      if (name === './aiProtocol') return {
        aiHeaders: () => ({}),
        withAiRequest: async (_provider, _endpoint, init) => {
          const body = JSON.parse(init.body);
          batches.push(body.input);
          return respond(body.input);
        },
      };
      throw new Error(`Unexpected import: ${name}`);
    },
    AbortController, DOMException, console, JSON, Map, Set, Number, Math,
  };
  return { api: evaluateFixture('src/lib/embeddings.ts', sandbox), batches };
}

const known = text => text.includes('热点') || text === '缓存击穿' ? [1, 0] : [0, 1];
const vectors = inputs => ({ data: inputs.map(input => ({ embedding: known(input) })) });

test('semantic retrieval stays off until an embedding model is configured', async () => {
  const { api, batches } = load({ model: '', respond: vectors });
  assert.equal(api.embeddingsReady(), false);
  assert.equal(await api.rankChunks('热点 key 失效', [{ id: 'a', text: '缓存击穿' }]), null);
  assert.equal(batches.length, 0, 'nothing is sent when the feature is off');
});

test('a configured model ranks chunks by cosine and drops unrelated ones', async () => {
  const { api, batches } = load({ respond: vectors });
  assert.equal(api.embeddingsReady(), true);
  const ranking = await api.rankChunks('热点 key 失效', [
    { id: 'a', text: '缓存击穿' },
    { id: 'b', text: '完全无关的一段文字' },
  ]);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3, 'the query rides along with the chunks');
  assert.deepEqual([...ranking.keys()], ['a']);
  assert.ok(ranking.get('a') > 0.9);
});

test('chunk vectors are cached while a new query still costs one call', async () => {
  const { api, batches } = load({ respond: vectors });
  const chunks = [{ id: 'a', text: '缓存击穿' }];
  await api.rankChunks('热点 key 失效', chunks);
  await api.rankChunks('另一个问题', chunks);
  assert.equal(batches.length, 2);
  assert.equal(batches[1].length, 1, 'only the new query is embedded again');
});

test('a provider that cannot serve embeddings degrades to no ranking', async () => {
  const { api } = load({ respond: () => ({ data: [] }) });
  assert.equal(await api.rankChunks('热点', [{ id: 'a', text: '缓存击穿' }]), null);
  const failing = load({ respond: () => { throw new Error('404 not found'); } });
  assert.equal(await failing.api.rankChunks('热点', [{ id: 'a', text: '缓存击穿' }]), null);
  api.resetEmbeddingCache();
});

test('cosine ignores mismatched or empty vectors', () => {
  const { api } = load({ respond: vectors });
  assert.equal(api.cosine(Float64Array.from([1, 0]), Float64Array.from([0, 1])), 0);
  assert.equal(api.cosine(Float64Array.from([1, 0]), Float64Array.from([1])), 0);
  assert.ok(Math.abs(api.cosine(Float64Array.from([3, 4]), Float64Array.from([3, 4])) - 1) < 1e-9);
});
