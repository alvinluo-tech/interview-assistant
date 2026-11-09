import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function load() {
  const settings = {};
  const api = evaluateFixture('src/lib/latencyStats.ts', {exports:{},console,Math,Number,Object,Array,
    require:name=>{
      if(name!=='./store') throw new Error(`Unmocked ${name}`);
      return {
        getSetting:(key,fallback)=>settings[key] ?? fallback,
        setSetting:async(key,value)=>{settings[key]=value;},
      };
    }});
  return {api,settings};
}

test('a first-token estimate needs enough samples before it is shown', () => {
  const {api} = load();
  assert.equal(api.estimateFirstToken('model-a'), null);
  api.recordFirstToken('model-a', 1200);
  api.recordFirstToken('model-a', 1500);
  assert.equal(api.estimateFirstToken('model-a'), null, 'two samples are still noise');
  api.recordFirstToken('model-a', 2400);
  assert.equal(api.estimateFirstToken('model-a'), 1500, 'median, not the average');
});

test('the estimate falls back to the model that answered last', () => {
  const {api} = load();
  for (const ms of [800, 900, 1000]) api.recordFirstToken('model-b', ms);
  assert.equal(api.estimateFirstToken(), 900, 'the overlay asks before the request carries a model id');
});

test('nonsense measurements are ignored instead of poisoning the estimate', () => {
  const {api} = load();
  api.recordFirstToken('model-c', 0);
  api.recordFirstToken('model-c', -5);
  api.recordFirstToken('model-c', Number.NaN);
  api.recordFirstToken('model-c', 900_000);
  api.recordFirstToken(undefined, 1200);
  for (const ms of [500, 600, 700]) api.recordFirstToken('model-c', ms);
  assert.equal(api.estimateFirstToken('model-c'), 600);
});

test('only the most recent samples are kept, so the estimate follows the current provider', () => {
  const {api,settings} = load();
  for (let i = 1; i <= 30; i++) api.recordFirstToken('model-d', i * 100);
  const samples = settings['ai.firstTokenMs']['model-d'];
  assert.equal(samples.length, 20);
  assert.equal(samples[0], 1100);
  assert.equal(samples.at(-1), 3000);
});
