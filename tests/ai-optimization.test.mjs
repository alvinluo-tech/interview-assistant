import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {evaluateFixture} from './compile-fixture.mjs';
function load(file, dependencies={}) {
  return evaluateFixture(file,{exports:{},Error,Response,TextDecoder,TextEncoder,AbortController,DOMException,URL,URLSearchParams,performance,setTimeout,clearTimeout,
    require:name=>dependencies[name]??load(path.resolve(path.dirname(file),name.replace(/\.js$/,'')+'.ts'),dependencies)});
}
const message=(id,role,text,metadata={})=>({id,role,text,metadata,createdAt:1});

test('interview prompt defaults to continuing answers the candidate may read, without per-turn confirmation',()=>{
  const api=load('src/lib/ai.ts',{'./aiRequests':{}});
  const prompt=api.buildInterviewSystemPrompt({customAnswerStyle:'回答自然一些'});
  assert.match(prompt,/默认.*(?:采用|照读|照念)/);
  assert.match(prompt,/不.*(?:逐轮|每轮).*确认/);
  assert.doesNotMatch(prompt,/用户额外要求（优先级最高）/);
});
test('length-limited completions preserve partial output but never become successful answers',async()=>{
  const {consumeChat}=load('src/lib/aiProtocol.ts');
  const response=new Response('data: {"choices":[{"delta":{"content":"def solve():"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(consumeChat(response),error=>error.partialText==='def solve():'&&error.completionStatus==='truncated');
});
test('invalid mock output is rejected instead of becoming a spoken question',async()=>{
  const api=load('src/lib/mock.ts',{'./ai':{chatStream:async()=>'{"notQuestion":true}'}});
  await assert.rejects(api.generateNextQuestion({difficultyLabel:'3 年',turnBudget:8,basicsRatio:50,assistMode:false},[]),/格式|问题/);
});
test('mock follow-up limits are enforced even if the model asks for another CONT',async()=>{
  const calls=[];const api=load('src/lib/mock.ts',{'./ai':{chatStream:async opts=>{calls.push(opts);return '{"question":"请换个角度解释。","kind":"CONT"}';}}});
  const history=[message('q1','INTERVIEWER','项目',{turnKind:'NEW'}),message('a1','ASSISTANT','回答'),message('q2','INTERVIEWER','追问1',{turnKind:'CONT'}),message('a2','ASSISTANT','回答'),message('q3','INTERVIEWER','追问2',{turnKind:'CONT'}),message('a3','ASSISTANT','回答')];
  await assert.rejects(api.generateNextQuestion({difficultyLabel:'3 年',turnBudget:8,basicsRatio:51,assistMode:false},history),/需要换新题/);
  assert.match(JSON.stringify(calls[0].messages),/必须.*新|只允许.*NEW/);
});
test('material retrieval may return nothing while a short resume remains available as background',()=>{
  const {buildKnowledgeContext}=load('src/lib/knowledgeContext.ts');
  const material={id:'m',name:'无关资料',content:'完全无关的演示段落。'.repeat(300),entries:[]};
  const context=buildKnowledgeContext({materials:[material],query:'Kubernetes',maxChars:5000});
  assert.equal(context.sources.length,0);
  const resume=buildKnowledgeContext({resume:{id:'r',title:'简历',content:'Java 开发，负责订单模块。'},query:'Kubernetes'});
  assert.match(resume.text,/订单模块/);
});
test('AI-generated entries retain their origin in retrieved context',()=>{
  const {buildKnowledgeContext}=load('src/lib/knowledgeContext.ts');
  const result=buildKnowledgeContext({materials:[{id:'m',name:'项目资料',content:'',source:'ai',entries:[{question:'Redis 缓存',answer:'我把延迟降低到 20ms',origin:'model_generated'}]}],query:'Redis'});
  assert.match(result.text,/AI.*(?:草稿|建议)|模型生成/);
});
test('interview context includes the prior suggested architecture exactly once and excludes queued future questions',()=>{
  const {assembleInterviewHistory}=load('src/lib/aiContext.ts');
  const messages=[message('q1','INTERVIEWER','缓存怎么做'),message('a1','ASSISTANT','使用 Redis 缓存'),message('q2','INTERVIEWER','如何保证一致性'),message('q3','INTERVIEWER','未来的问题不要混入')];
  const result=assembleInterviewHistory(messages,'如何保证一致性',{throughMessageId:'q2'});
  const text=JSON.stringify(result);
  assert.match(text,/Redis/);assert.doesNotMatch(text,/未来的问题/);
  assert.equal(result.filter(item=>item.content==='如何保证一致性').length,1);
});
test('exam follow-up targets only its root question and retains complete original constraints',()=>{
  const {assembleExamContext}=load('src/lib/aiContext.ts');
  const turns=[{id:'q1',questionText:'题一：数组最多十万项',body:'```python\ndef solve(a):\n return sum(a)\n```'},{id:'q2',questionText:'题二SQL',body:'SELECT 1'},{id:'f1',parentTurnId:'q1',questionText:'优化题一',body:'线性扫描'}];
  const text=assembleExamContext(turns,'q1');assert.match(text,/十万项/);assert.match(text,/def solve/);assert.doesNotMatch(text,/SELECT|题二/);
});
test('transient retries are bounded and authentication/format errors do not repeat paid requests',()=>{
  const {retryDelay}=load('src/lib/aiTaskPolicy.ts');
  assert.equal(retryDelay(new Error('HTTP 401 · 认证失败'),0),null);
  assert.equal(retryDelay(new Error('问题响应格式无效'),0),null);
  assert.ok(retryDelay(new Error('HTTP 503 · 服务商暂时不可用'),0)>0);
  assert.equal(retryDelay(new Error('HTTP 503 · 服务商暂时不可用'),2),null);
});


test('document snapshots remain stable after edits and deletion revokes access',()=>{
  const {captureKnowledge,authorizedKnowledge}=load('src/lib/knowledgeContext.ts');
  const resume={id:'r',title:'简历',content:'原版本 Redis 设计'};
  const material={id:'m',name:'资料',content:'Redis 项目',entries:[]};
  const snapshot=captureKnowledge({resume,materials:[material]});resume.content='新版本';material.content='新资料';
  const pinned=authorizedKnowledge(snapshot,{resume,materials:[material]});
  assert.equal(pinned.resume.content,'原版本 Redis 设计');assert.equal(pinned.materials[0].content,'Redis 项目');
  const revoked=authorizedKnowledge(snapshot,{materials:[]});assert.equal(revoked.resume,undefined);assert.equal(revoked.materials.length,0);
});

test('missing finish reason and DONE do not certify a complete answer',async()=>{
  const {consumeChatResult}=load('src/lib/aiProtocol.ts');
  const result=await consumeChatResult(new Response('data: {"choices":[{"delta":{"content":"回答"}}]}\n\ndata: [DONE]\n\n'));
  assert.equal(result.completionStatus,'unknown');assert.equal(result.text,'回答');
});

test('stream failure preserves partial content and abort cancels a pending reader',async()=>{
  const {consumeChatResult}=load('src/lib/aiProtocol.ts');let reads=0;
  const broken=new Response(new ReadableStream({pull(controller){if(reads++===0)controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"已有内容"}}]}\n\n'));else controller.error(new Error('断线'));}}));
  await assert.rejects(consumeChatResult(broken),error=>error.partialText==='已有内容'&&error.completionStatus==='failed');
  let cancelled=false;const controller=new AbortController();
  const pending=consumeChatResult(new Response(new ReadableStream({cancel(){cancelled=true;}})),undefined,controller.signal);
  controller.abort();await assert.rejects(pending);assert.equal(cancelled,true);
});

test('refusal is not treated as a successful completion',async()=>{
  const {consumeChatResult}=load('src/lib/aiProtocol.ts');
  await assert.rejects(consumeChatResult(new Response(JSON.stringify({choices:[{message:{refusal:'无法完成'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}})),error=>error.completionStatus==='refused');
});

test('task preferences stay below application rules and never duplicate the current question',()=>{
  const {applyTaskInstructions}=load('src/lib/taskPrompts.ts');
  const result=applyTaskInstructions([{role:'system',content:'输出协议'},{role:'user',content:'原题'}],'interview-answer',{'interview-answer':'使用口语'});
  assert.equal(result[0].role,'system');assert.doesNotMatch(result[0].content,/使用口语/);
  assert.equal(result[1].role,'user');assert.match(result[1].content,/使用口语/);assert.equal(result.filter(item=>item.content==='原题').length,1);
});

test('candidate corrections remain stronger context without removing previous reference answers',()=>{
  const {assembleInterviewHistory}=load('src/lib/aiContext.ts');
  const result=assembleInterviewHistory([message('a','ASSISTANT','Redis 缓存'),message('actual','ASSISTANT','我实际说的是本地缓存',{origin:'candidate_response'})],'为什么这样选');
  assert.match(JSON.stringify(result),/Redis/);assert.match(JSON.stringify(result),/实际回答.*本地缓存/);
});

function requestHarness(capabilities,response) {
  const calls=[],traces=[];
  const provider={id:'p',name:'测试接口',baseUrl:'https://example.invalid/v1',authMode:'none',apiKey:'',models:[{id:'model',source:'custom',capabilities}]};
  const api=load('src/lib/aiRequests.ts',{'./aiSettings':{getAiSettings:()=>({timeoutMs:5000}),getAiLoadError:()=>''},
    './aiConfig':{resolveAiRoute:()=>({provider,modelId:'model'})},'./store':{getSetting:(_key,fallback)=>fallback},
    './aiTransport':{aiFetch:async (_url,init)=>{calls.push(JSON.parse(init.body));return response || new Response(JSON.stringify({choices:[{message:{content:'OK'},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:2,prompt_tokens_details:{cached_tokens:10}}}),{headers:{'content-type':'application/json'}});}}});
  return {calls,traces,request:options=>api.chatStream({messages:[{role:'user',content:'测试'}],task:'mock-question',temperature:0.5,schema:{name:'question',schema:{type:'object'}},onTrace:trace=>traces.push(trace),...options})};
}

test('known provider capabilities select compatible parameters and capture actual usage',async()=>{
  const h=requestHarness({outputParameter:'max_completion_tokens',structuredOutput:'json_schema',temperature:false,maxOutputTokens:500});
  await h.request();const body=h.calls[0];
  assert.equal(body.max_completion_tokens,500);assert.equal(body.max_tokens,undefined);assert.equal(body.temperature,undefined);
  assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.capabilities,undefined);
  assert.equal(h.traces[0].completionStatus,'complete');assert.equal(h.traces[0].cachedTokens,10);assert.ok(h.traces[0].firstOutputMs>=0);
});

test('unknown capabilities do not force JSON support and input overflow sends no request',async()=>{
  const compatible=requestHarness();await compatible.request();assert.equal(compatible.calls[0].response_format,undefined);
  const small=requestHarness({contextWindow:1024});await assert.rejects(small.request({messages:[{role:'user',content:'汉'.repeat(2000)}]}),/上下文窗口/);
  assert.equal(small.calls.length,0);assert.equal(small.traces[0].completionStatus,'failed');
  const none=requestHarness({outputParameter:'none'});await none.request();assert.equal(none.calls[0].max_tokens,undefined);
});

test('capability settings survive native JSON ordering and rediscovery',()=>{
  const {normalizeProvider,mergeDiscoveredModels}=load('src/lib/aiConfig.ts');
  const provider={id:'p',name:'接口',baseUrl:'https://example.invalid/v1',authMode:'none',apiKey:'',models:[{id:'m',name:'M',source:'discovered',capabilities:{temperature:false,maxOutputTokens:1024}}]};
  const normalized=normalizeProvider(provider), native=JSON.parse(JSON.stringify(provider,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort()):value));
  assert.equal(JSON.stringify(normalizeProvider(native)),JSON.stringify(normalized));
  assert.equal(mergeDiscoveredModels(normalized,[{id:'m'}],{}).at(0).capabilities.maxOutputTokens,1024);
  assert.throws(()=>normalizeProvider({...provider,models:[{...provider.models[0],capabilities:{maxOutputTokens:-1}}]}));
});

test('preparation uses selected facts and rejects structurally invalid or invented enum values',async()=>{
  let sent;const reply={questions:[{category:'job_skill',probability:'high',question:'Redis 一致性怎么保证？',answer:'解释更新策略与故障边界。'}]};
  const api=load('src/lib/preparation.ts',{'./ai':{chatStream:async options=>{sent=options;return JSON.stringify(reply);}}});
  const result=await api.generatePreparation({count:1,resume:{id:'r',title:'简历',content:'订单模块 Redis 设计'}});
  assert.equal(result.length,1);assert.match(JSON.stringify(sent.messages),/订单模块/);assert.equal(sent.task,'question-bank');
  reply.questions[0].probability='guaranteed';await assert.rejects(api.generatePreparation({count:1}),/格式|字段/);
});

test('mock reports explicitly mark hint use and cite observable message evidence',async()=>{
  let sent;const api=load('src/lib/mock.ts',{'./ai':{chatStream:async options=>{sent=options;return '报告';}}});
  await api.generateMockReport([message('q1','INTERVIEWER','问题'),message('a1','ASSISTANT','回答',{hintUsed:true})]);
  assert.match(JSON.stringify(sent.messages),/辅助提示/);assert.match(JSON.stringify(sent.messages),/a1/);
});


test('retrieval retains AI provenance for late chunks and mixed manual containers',()=>{
  const {buildKnowledgeContext}=load('src/lib/knowledgeContext.ts');
  const context=buildKnowledgeContext({materials:[{id:'mixed',name:'人工资料',source:'manual',content:'',entries:[{id:'ai-entry',question:'项目设计',answer:'较早内容。'.repeat(700)+'Redis 缓存延迟 20ms',origin:'model_generated'}]}],query:'Redis',maxChars:1200});
  assert.match(context.text,/Redis/);assert.match(context.text,/AI 生成参考建议/);
  assert.equal(context.sources[0].origin,'model_generated');assert.ok(context.text.length<=1200);
});


test('failed task preference saves remain drafts and do not broadcast success',async()=>{
  let stored={old:'value'},emits=0;
  const store={get:async()=>stored,set:async(_key,value)=>{stored=value;},save:async()=>{throw new Error('disk full');},delete:async()=>{stored=undefined;}};
  const api=load('src/lib/store.ts',{'react':{},'@tauri-apps/plugin-store':{load:async()=>store},'@tauri-apps/api/event':{emit:async()=>{emits++;}}});
  await assert.rejects(api.setSetting('ai.taskPreferences',{'interview-answer':'新偏好'},{strict:true}),/未保存/);
  assert.equal(api.getSetting('ai.taskPreferences',undefined),undefined);assert.equal(stored.old,'value');assert.equal(emits,0);
});


test('history budgeting keeps whole recent turns and excludes obsolete or incomplete drafts',()=>{
  const {assembleInterviewHistory}=load('src/lib/aiContext.ts');
  const history=[message('q0','INTERVIEWER','较早问题'.repeat(20)),message('a0','ASSISTANT','较早回答'.repeat(20)),message('old','INTERVIEWER','已更正',{superseded:true}),{...message('pending','ASSISTANT','草稿'),pending:true},message('refused','ASSISTANT','拒绝',{completionStatus:'refused'}),message('empty','ASSISTANT',''),message('q1','INTERVIEWER','最近问题'),message('a1','ASSISTANT','最近回答',{completionStatus:'truncated'})];
  const result=assembleInterviewHistory(history,'新问题',{maxChars:65});const text=JSON.stringify(result);
  assert.match(text,/最近问题/);assert.match(text,/最近回答/);assert.doesNotMatch(text,/较早|已更正|草稿|拒绝/);
  assert.throws(()=>assembleInterviewHistory(history,'新问题',{maxChars:1}),/完整问答/);
});

test('exam context retains earlier same-question answers and refuses to cut a whole code block',()=>{
  const {assembleExamContext}=load('src/lib/aiContext.ts');
  const turns=[{id:'q',questionText:'约束',body:'原解法'},{id:'f1',parentTurnId:'q',body:'优化解法'},{id:'f2',parentTurnId:'q',body:'当前完整代码'}];
  const context=assembleExamContext(turns,'f2');assert.match(context,/原解法/);assert.match(context,/优化解法/);assert.match(context,/当前完整代码/);
  assert.throws(()=>assembleExamContext(turns,'missing'),/找到/);assert.throws(()=>assembleExamContext(turns,'f2',2),/完整代码/);
});

test('mock knowledge authorization excludes deleted selected documents and preserves legacy configuration explicitly',()=>{
  const {captureKnowledge}=load('src/lib/knowledgeContext.ts');
  const resume={id:'r',title:'简历',content:'旧简历'},goal={id:'g',name:'岗位',description:'Redis'},material={id:'m',name:'资料',content:'Redis',entries:[]};
  const current={resumes:[resume],goals:[goal],materials:[material]};
  const {currentMockKnowledge}=load('src/lib/sessionKnowledge.ts',{'./backend':{readData:(key,fallback)=>current[key] || fallback}});
  const legacy={knowledgeContext:'旧资料字符串'};assert.equal(currentMockKnowledge(legacy),legacy);
  const config={knowledge:captureKnowledge({resume,goal,materials:[material]}),knowledgeContext:'不应回退旧串'};
  current.resumes[0]={...resume,content:'新版本'};const pinned=currentMockKnowledge(config);assert.equal(pinned.knowledge.resume.content,'旧简历');
  current.resumes=[];current.goals=[];current.materials=[];const revoked=currentMockKnowledge(config);
  assert.equal(revoked.knowledge.resume,undefined);assert.equal(revoked.knowledge.goal,undefined);assert.equal(revoked.knowledge.materials.length,0);assert.equal(revoked.knowledgeContext,undefined);
});

test('preparation parsing rejects empty and malformed results without saving content',async()=>{
  let raw='invalid';const api=load('src/lib/preparation.ts',{'./ai':{chatStream:async()=>raw}});
  await assert.rejects(api.generatePreparation({count:1}),/格式/);
  for(const value of [null,[],{questions:[null]},{questions:[{category:'job_skill',probability:'high',question:'',answer:'答案'}]}]){raw=JSON.stringify(value);await assert.rejects(api.generatePreparation({count:1}),/字段/);}
  raw=JSON.stringify([{category:'job_skill',probability:'low',question:'题目',answer:'答案'}]);assert.equal((await api.generatePreparation({count:1})).length,1);
});


test('legacy entry origins remain unknown even inside an AI-created container',()=>{
  const {buildKnowledgeContext}=load('src/lib/knowledgeContext.ts');
  const context=buildKnowledgeContext({query:'Redis',materials:[{id:'old',name:'旧资料',source:'ai',content:'',entries:[{question:'Redis',answer:'旧条目'}]}]});
  assert.equal(context.sources[0].origin,'legacy_unknown');assert.match(context.text,/来源未逐条确认/);
});
