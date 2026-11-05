import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture, evaluateModuleFixture} from './compile-fixture.mjs';

const config={difficultyLabel:'测试',turnBudget:8,basicsRatio:50,assistMode:false};
function harness(reply) {
  const calls=[];
  const api=evaluateFixture('src/lib/mock.ts',{exports:{},require:name=>{
    if(name==='./i18n')return evaluateModuleFixture('src/lib/i18n.ts');
    if(name==='./speechProfile')return evaluateModuleFixture('src/lib/speechProfile.ts');
    if(name==='./knowledgeContext')return {};
    assert.equal(name,'./ai');return {chatStream:async options=>{calls.push(options);return reply;}};
  }});
  return {api,calls};
}
test('opening questions use the same structured question-only contract as follow-ups',async()=>{
  const {api,calls}=harness(JSON.stringify({question:'请介绍一下你的项目经历。',kind:'NEW'}));
  assert.equal(await api.generateOpeningQuestion(config),'请介绍一下你的项目经历。');
  assert.equal(calls[0].schema.name,'mock_question');
  assert.deepEqual(Array.from(calls[0].schema.schema.properties.kind.enum),['NEW']);
});
test('interviewer rejects self-answer, role switching and excessive questions before persistence or speech',async()=>{
  for(const question of [
    '请介绍一下你自己。\n你好，我是 AI 助手，擅长整理信息，没有真实实习经历。',
    '请介绍项目。\n候选人：我负责订单系统。',
    '请介绍项目。\n参考答案：应该按 STAR 结构作答。',
    'Tell me about yourself.\nAs an AI assistant, I do not have real experience.',
    '请介绍你最熟悉的项目。'.repeat(40),
  ]) {
    const {api}=harness(JSON.stringify({question,kind:'NEW'}));
    await assert.rejects(api.generateOpeningQuestion(config),/问题|格式/);
    await assert.rejects(api.generateNextQuestion(config,[]),/问题|格式/);
  }
});
test('technical questions mentioning AI remain valid',async()=>{
  const question='如果要设计一个 AI 助手，你会怎样处理模型自称“我是 AI 助手”却忽略用户问题的情况？';
  const {api}=harness(JSON.stringify({question,kind:'NEW'}));
  assert.equal((await api.generateNextQuestion(config,[])).question,question);
});
test('question protocol accepts a whole JSON fence and rejects prose wrapped around JSON or invalid fields',async()=>{
  const valid='{"question":"请解释缓存一致性。","kind":"NEW"}';
  assert.equal(await harness('```json\n'+valid+'\n```').api.generateOpeningQuestion(config),'请解释缓存一致性。');
  for(const raw of ['你好。'+valid,valid+'\n答案是……','null','[]','{"question":" ","kind":"NEW"}',
    '{"question":"有效问题","kind":"OTHER"}',JSON.stringify({question:42,kind:'NEW'})]){
    await assert.rejects(harness(raw).api.generateOpeningQuestion(config),/问题|格式/);
    await assert.rejects(harness(raw).api.generateNextQuestion(config,[]),/问题|格式/);
  }
  await assert.rejects(harness('{"question":"请介绍自己。","kind":"CONT"}').api.generateOpeningQuestion(config),/问题|格式/);
});
test('candidate speech and old questions retain their actual roles when requesting the next question',async()=>{
  const {api,calls}=harness('{"question":"你如何验证改进效果？","kind":"CONT"}');
  const history=[{id:'q',role:'INTERVIEWER',text:'请介绍项目。',metadata:{turnKind:'NEW'}},
    {id:'a',role:'ASSISTANT',text:'我负责订单系统。',metadata:{origin:'candidate_response'}},
    {id:'old',role:'INTERVIEWER',text:'已作废的问题',metadata:{superseded:true}}];
  await api.generateNextQuestion(config,history);
  assert.ok(calls[0].messages.some(message=>message.role==='assistant'&&message.content==='请介绍项目。'));
  assert.ok(calls[0].messages.some(message=>message.role==='user'&&message.content==='我负责订单系统。'));
  assert.doesNotMatch(JSON.stringify(calls[0]),/已作废/);
  assert.match(calls[0].messages.at(-1).content,/面试官/);
});
