import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
test('mock interviewer requests forward cancellation to the AI transport', async () => {
  const calls = [];
  const api = evaluateFixture('src/lib/mock.ts', {exports:{}, require: name => {
    if(name==='./speechProfile')return evaluateFixture('src/lib/speechProfile.ts',{exports:{}});
    if(name==='./knowledgeContext') return {};
    assert.equal(name,'./ai'); return {chatStream: async options => {calls.push(options); return options.schema ? '{"question":"你好","kind":"NEW"}' : '你好';}};
  }});
  const controller = new AbortController();
  const config = {difficultyLabel:'测试', turnBudget:8, basicsRatio:50, assistMode:false};
  await api.generateOpeningQuestion(config, controller.signal);
  await api.generateNextQuestion(config, [], controller.signal);
  await api.generateHint(config, '问题', controller.signal);
  await api.generateMockReport([], controller.signal);
  assert.equal(calls.length,4);
  calls.forEach(call => assert.equal(call.signal, controller.signal));
});
