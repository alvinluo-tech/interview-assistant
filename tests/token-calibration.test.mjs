import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function harness() {
  const settings = {};
  const api = evaluateFixture('src/lib/tokenCalibration.ts', {
    exports: {},
    console,
    require: name => {
      if (name === './store') return {
        getSetting: (key, fallback) => (key in settings ? JSON.parse(JSON.stringify(settings[key])) : fallback),
        setSetting: async (key, value) => { settings[key] = JSON.parse(JSON.stringify(value)); },
      };
      throw Error(name);
    },
  });
  return { api, settings };
}

test('one sample is not enough to move the budget', async () => {
  const { api } = harness();
  await api.recordTokenSample('deepseek-chat', 1000, 500);
  assert.equal(api.tokenScale('deepseek-chat'), 1);
});

test('three agreeingsamples move the scale and are persisted', async () => {
  const { api, settings } = harness();
  for (let i = 0; i < 3; i++) await api.recordTokenSample('deepseek-chat', 1000, 500);
  const scale = api.tokenScale('deepseek-chat');
  assert.ok(scale < 0.62 && scale > 0.48, `unexpected scale ${scale}`);
  assert.equal(settings['ai.tokenCalibration']['deepseek-chat'].samples, 3);
});

test('namespace prefixes collapse so one model keeps one history', async () => {
  const { api, settings } = harness();
  for (let i = 0; i < 3; i++) await api.recordTokenSample('vendor/index/DeepSeek-Chat', 1000, 2000);
  assert.ok(api.tokenScale('deepseek-chat') > 1.5);
  assert.deepEqual(Object.keys(settings['ai.tokenCalibration']), ['deepseek-chat']);
});

test('wild ratios are clamped and bad samples are ignored', async () => {
  const { api, settings } = harness();
  for (let i = 0; i < 3; i++) await api.recordTokenSample('m', 100, 1_000_000);
  assert.equal(api.tokenScale('m'), 3);
  for (let i = 0; i < 3; i++) await api.recordTokenSample('n', 1000, 1);
  assert.equal(api.tokenScale('n'), 0.5);
  await api.recordTokenSample('p', 0, 100);
  await api.recordTokenSample(undefined, 100, 100);
  await api.recordTokenSample('q', 100, undefined);
  assert.equal(api.tokenScale('p'), 1);
  assert.equal(api.tokenScale('q'), 1);
  assert.equal(api.tokenScale(), 1);
  assert.deepEqual(Object.keys(settings['ai.tokenCalibration']).sort(), ['m', 'n']);
});

test('a restarted process reads the stored book back', async () => {
  const { api, settings } = harness();
  for (let i = 0; i < 3; i++) await api.recordTokenSample('m', 1000, 1500);
  const ratio = settings['ai.tokenCalibration']['m'].ratio;
  api.resetTokenCalibration();
  assert.equal(api.tokenScale('m'), ratio);
});
