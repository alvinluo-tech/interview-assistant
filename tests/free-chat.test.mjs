import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function harness(responses=[]) {
  const data={goals:[{id:'g1',createdAt:1,name:'工程师',companyName:'示例',description:'岗位介绍'}],resumes:[{id:'r1',createdAt:1,title:'简历',summary:'摘要',content:'敏感完整正文'}],interviewSessions:[{id:'i1',createdAt:5,title:'面试记录',status:'COMPLETED',type:'INTERVIEW',messages:[{id:'m1',role:'INTERVIEWER',text:'谈谈项目'}, {id:'m2',role:'ASSISTANT',text:'参考方案',metadata:{origin:'model_generated'}},{id:'m3',role:'ASSISTANT',text:'我的实际回答',metadata:{origin:'candidate_response'}}]}],examSessions:[{id:'e1',createdAt:3,title:'笔试',status:'COMPLETED',questions:[{id:'q1',questionText:'题目',answer:'参考答案'}]}],freeChats:[]};
  const requests=[],chatCalls=[];
  const api=evaluateFixture('src/lib/freeChat.ts',{exports:{},AbortController,Date,JSON,console,require:name=>{
    if(name==='./backend')return {getDataError:()=>null,readData:(key,fallback)=>data[key] ?? fallback,writeData:async(key,value)=>{data[key]=value;}};
    if(name==='./aiSettings')return {getAiSettings:()=>({timeoutMs:30000}),getAiLoadError:()=>null};
    if(name==='./aiConfig')return {resolveAiRoute:()=>({provider:{models:[]},modelId:'model'})};
    if(name==='./aiTransport')return {aiFetch:()=>{}};
    if(name==='./aiProtocol')return {aiHeaders:()=>({}),withAiRequest:async(_p,_url,init)=>{requests.push(JSON.parse(init.body));return responses.shift();}};
    if(name==='./aiRequests')return {chatStream:async(options)=>{chatCalls.push(options);options.onDelta?.('普通回答');return '普通回答';}};
    if(name==='./aiTaskPolicy')return {checkInputBudget:()=>{},outputLimit:()=>4096};
    throw Error(name);
  }});
  return {api,data,requests,chatCalls};
}

test('local tools require authorization, validate arguments, and exclude full resume content',()=>{
  const {api}=harness();
  assert.throws(()=>api.executeFreeChatTool('list_local_data','{"category":"resumes"}',false),/授权/);
  assert.throws(()=>api.executeFreeChatTool('list_local_data','{"category":"resumes","extra":1}',true),/授权/);
  assert.throws(()=>api.executeFreeChatTool('run_command','{}',true),/授权/);
  const result=api.executeFreeChatTool('list_local_data','{"category":"resumes"}',true);
  assert.match(result,/摘要/);assert.doesNotMatch(result,/敏感完整正文/);
});

test('local search only returns bounded relevant excerpts after authorization',()=>{
  const {api}=harness();
  assert.throws(()=>api.executeFreeChatTool('search_local_knowledge','{"query":"敏感"}',false),/授权/);
  assert.match(api.executeFreeChatTool('search_local_knowledge','{"query":"敏感"}',true),/敏感完整正文/);
  assert.throws(()=>api.executeFreeChatTool('search_local_knowledge','{"query":""}',true),/搜索词/);
});

test('record tools expose bounded pages with source and provenance under authorization',()=>{
  const {api}=harness();
  assert.throws(()=>api.executeFreeChatTool('read_local_record','{"category":"resumes","id":"r1","offset":0}',false),/授权/);
  const resume=JSON.parse(api.executeFreeChatTool('read_local_record','{"category":"resumes","id":"r1","offset":0}',true));
  assert.equal(resume.text,'敏感完整正文');assert.equal(resume.next_offset,null);
  const interview=JSON.parse(api.executeFreeChatTool('read_local_record','{"category":"interviews","id":"i1","offset":0}',true));
  assert.equal(interview.messages[1].origin,'model_generated');assert.equal(interview.messages[2].origin,'candidate_response');
  const exam=JSON.parse(api.executeFreeChatTool('read_local_record','{"category":"exams","id":"e1","offset":0}',true));
  assert.equal(exam.questions[0].answer,'参考答案');assert.match(exam.source_note,/AI/);
  assert.throws(()=>api.executeFreeChatTool('read_local_record','{"category":"exams","id":"e1","offset":-1}',true),/参数/);
});

test('record lists show newest first and disclose when the result is limited',()=>{
  const h=harness();h.data.examSessions=Array.from({length:21},(_,i)=>({id:`e${i}`,createdAt:i,title:`笔试${i}`,questions:[]}));
  const page=JSON.parse(h.api.executeFreeChatTool('list_local_data','{"category":"exams"}',true));
  assert.equal(page.items[0].id,'e20');assert.equal(page.total,21);assert.equal(page.has_more,true);assert.equal(page.items.length,20);
});

test('interview pages disclose continuation and do not include pending or superseded messages',()=>{
  const h=harness();h.data.interviewSessions[0].messages=Array.from({length:10},(_,i)=>({id:`m${i}`,role:'INTERVIEWER',text:`问题${i}`}));
  h.data.interviewSessions[0].messages.push({id:'pending',role:'ASSISTANT',text:'未完成',pending:true},{id:'old',role:'INTERVIEWER',text:'旧版',metadata:{superseded:true}});
  const first=JSON.parse(h.api.executeFreeChatTool('read_local_record','{"category":"interviews","id":"i1","offset":0}',true));
  const second=JSON.parse(h.api.executeFreeChatTool('read_local_record',JSON.stringify({category:'interviews',id:'i1',offset:first.next_offset}),true));
  assert.equal(first.total,10);assert.equal(first.next_offset,8);assert.equal(second.messages.length,2);assert.equal(second.next_offset,null);
});

test('every part of a long exam question and answer is retrievable without duplicating entries',()=>{
  const h=harness();const question='问题'.repeat(4000),answer='答案'.repeat(5000);
  h.data.examSessions[0].questions=[{id:'q-long',questionText:question,answer}];
  let textOffset=0,fullQuestion='',fullAnswer='';
  do{
    const reply=JSON.parse(h.api.executeFreeChatTool('read_local_record',JSON.stringify({category:'exams',id:'e1',offset:0,entry_id:'q-long',text_offset:textOffset}),true));
    assert.equal(reply.questions.length,1);fullQuestion+=reply.questions[0].question;fullAnswer+=reply.questions[0].answer;textOffset=reply.questions[0].next_text_offset;
  }while(textOffset!==null);
  assert.equal(fullQuestion,question);assert.equal(fullAnswer,answer);
  h.data.examSessions[0].questions.push({id:'other',answer:'另一题'});
  const chunk=JSON.parse(h.api.executeFreeChatTool('read_local_record','{"category":"exams","id":"e1","offset":0,"entry_id":"q-long","text_offset":3000}',true));
  assert.equal(chunk.next_offset,null,'An entry continuation must not invent a collection-page offset');
  for(const extra of [{entry_id:'missing'},{text_offset:0},{entry_id:'q-long',text_offset:-1},{entry_id:'q-long',text_offset:NaN}])assert.throws(()=>h.api.executeFreeChatTool('read_local_record',JSON.stringify({category:'exams',id:'e1',offset:0,...extra}),true));
});

test('search keeps unknown entry origins unknown even inside AI-created materials',()=>{
  const h=harness();h.data.materials=[{id:'material',name:'参考',source:'ai',entries:[{id:'old',question:'订单优化',answer:'旧资料'},{id:'new',question:'订单优化',answer:'模型参考',origin:'model_generated'}]}];
  const reply=JSON.parse(h.api.executeFreeChatTool('search_local_knowledge','{"query":"订单优化"}',true));
  assert.equal(reply.find(item=>item.entry_id==='old').origin,'legacy_unknown');
  assert.equal(reply.find(item=>item.entry_id==='new').origin,'model_generated');
  assert.match(reply.find(item=>item.entry_id==='new').source_note,/不是用户经历/);
});

test('record cursors accept long valid record IDs and late text offsets within the storage bound',()=>{
  const h=harness(),id='r'.repeat(700);
  h.data.resumes=[{id,title:'长资料',content:'x'.repeat(1_000_100)+'简历尾部'}];
  const resume=JSON.parse(h.api.executeFreeChatTool('read_local_record',JSON.stringify({category:'resumes',id,offset:1_000_100}),true));assert.equal(resume.text,'简历尾部');
  h.data.examSessions[0].questions=[{id:'long',answer:'x'.repeat(2_000_100)+'答案尾部'}];
  const exam=JSON.parse(h.api.executeFreeChatTool('read_local_record',JSON.stringify({category:'exams',id:'e1',offset:0,entry_id:'long',text_offset:2_000_100}),true));assert.equal(exam.questions[0].answer,'答案尾部');assert.equal(exam.questions[0].next_text_offset,null);
});

test('list pagination handles empty, exact and oversized pages and rejects malformed cursors',()=>{
  const h=harness();
  for(const count of [0,20,21,100]){
    h.data.examSessions=Array.from({length:count},(_,i)=>({id:`e${i}`,createdAt:i,title:'记录',questions:[]}));
    const found=[];let cursor;
    do{const result=JSON.parse(h.api.executeFreeChatTool('list_local_data',JSON.stringify({category:'exams',...(cursor?{cursor}:{})}),true));assert.equal(result.offset,found.length);found.push(...result.items.map(item=>item.id));cursor=result.next_cursor;}while(cursor);
    assert.equal(found.length,count);assert.equal(new Set(found).size,count);
  }
  for(const cursor of ['bad','null','{}','{"time":"1","id":"x"}'])assert.throws(()=>h.api.executeFreeChatTool('list_local_data',JSON.stringify({category:'exams',cursor}),true),/游标/);
});

test('tool round trip sends standard tool results and returns the answer',async()=>{
  const h=harness([{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'call1',type:'function',function:{name:'list_local_data',arguments:'{"category":"goals"}'}}]}}]},
    {choices:[{finish_reason:'stop',message:{content:'有工程师岗位'}}]}]);
  const tools=[],chunks=[];
  const text=await h.api.askFreeChat([{role:'user',content:'我有哪些岗位'}],{signal:new AbortController().signal,allowLocal:true,onTool:name=>tools.push(name),onDelta:chunk=>chunks.push(chunk)});
  assert.equal(text,'有工程师岗位');assert.deepEqual(tools,['list_local_data']);
  assert.equal(h.requests[1].messages.at(-1).role,'tool');assert.equal(h.requests[1].messages.at(-1).tool_call_id,'call1');
  assert.match(h.requests[1].messages.at(-1).content,/工程师/);
});

test('internal DSML in plain text is not displayed or executed and a valid retry continues',async()=>{
  const bad='还需核实。 <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_local_record">x</｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
  const h=harness([{choices:[{finish_reason:'stop',message:{content:bad}}]},
    {choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:'c1',type:'function',function:{name:'list_local_data',arguments:'{"category":"goals"}'}}]}}]},
    {choices:[{finish_reason:'stop',message:{content:'查到一个岗位。'}}]}]);
  const chunks=[],seen=[];const answer=await h.api.askFreeChat([{role:'user',content:'分析'}],{signal:new AbortController().signal,allowLocal:true,onTool:name=>seen.push(name),onDelta:text=>chunks.push(text)});
  assert.equal(answer,'查到一个岗位。');assert.deepEqual(chunks,['查到一个岗位。']);assert.deepEqual(seen,['list_local_data']);
  assert.doesNotMatch(JSON.stringify(h.requests[1].messages),/DSML.*invoke/);
});

test('repeated leaked markup fails visibly without executing textual instructions',async()=>{
  const leak={choices:[{finish_reason:'stop',message:{content:'<|DSML|calls><|DSML|invoke name="read_local_record">'}}]};
  const h=harness([leak,leak]);let invoked=0,output='';
  await assert.rejects(h.api.askFreeChat([{role:'user',content:'分析'}],{signal:new AbortController().signal,allowLocal:true,onTool:()=>invoked++,onDelta:t=>{output+=t;}}),/内部工具标记/);
  assert.equal(invoked,0);assert.equal(output,'');
});

test('a previous malformed assistant message is excluded from the next request',async()=>{
  const h=harness([{choices:[{finish_reason:'stop',message:{content:'重新回答'}}]}]);
  await h.api.askFreeChat([{role:'user',content:'分析'},{role:'assistant',content:'<｜DSML｜calls>坏数据'},{role:'user',content:'继续'}],{signal:new AbortController().signal,allowLocal:true,onTool:()=>{},onDelta:()=>{}});
  assert.equal(h.requests[0].messages.some(message=>message.role==='assistant'),false);
});

test('a comprehensive request can query five data categories in one response',async()=>{
  const categories=['goals','resumes','materials','interviews','exams'];
  const calls=categories.map((category,index)=>({id:`call${index}`,type:'function',function:{name:'list_local_data',arguments:JSON.stringify({category})}}));
  const h=harness([{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:calls}}]}, {choices:[{finish_reason:'stop',message:{content:'综合分析'}}]}]);
  const seen=[];const answer=await h.api.askFreeChat([{role:'user',content:'综合分析'}],{signal:new AbortController().signal,allowLocal:true,onTool:name=>seen.push(name),onDelta:()=>{}});
  assert.equal(answer,'综合分析');assert.equal(seen.length,5);
  assert.equal(h.requests[1].messages.filter(message=>message.role==='tool').length,5);
});

test('an excessive batch is rejected without invoking any tools',async()=>{
  const calls=Array.from({length:17},(_,index)=>({id:`c${index}`,type:'function',function:{name:'app_guide',arguments:'{}'}}));
  const h=harness([{choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:calls}}]}]);let invoked=0;
  await assert.rejects(h.api.askFreeChat([{role:'user',content:'你好'}],{signal:new AbortController().signal,allowLocal:true,onTool:()=>invoked++,onDelta:()=>{}}),/16/);
  assert.equal(invoked,0);
});

test('when the model keeps querying, the app summarizes collected results without more tools',async()=>{
  const rounds=Array.from({length:5},(_,index)=>({choices:[{finish_reason:'tool_calls',message:{content:null,tool_calls:[{id:`c${index}`,type:'function',function:{name:'list_local_data',arguments:'{"category":"goals"}'}}]}}]}));
  const h=harness(rounds),chunks=[];
  const answer=await h.api.askFreeChat([{role:'user',content:'分析我的准备情况'}],{signal:new AbortController().signal,allowLocal:true,onTool:()=>{},onDelta:text=>chunks.push(text)});
  assert.match(answer,/达到上限/);assert.match(answer,/普通回答/);assert.equal(h.requests.length,5);assert.equal(h.chatCalls.length,1);
  const finalMessages=h.chatCalls[0].messages;assert.match(finalMessages.at(-1).content,/工程师/);assert.match(finalMessages.at(-1).content,/不可信/);
  assert.deepEqual(chunks,[answer]);
});

test('disabled tools use the ordinary streamed chat route',async()=>{
  const h=harness(),chunks=[];
  const answer=await h.api.askFreeChat([{role:'user',content:'你好'}],{signal:new AbortController().signal,allowLocal:false,onTool:()=>assert.fail(),onDelta:chunk=>chunks.push(chunk)});
  assert.equal(answer,'普通回答');assert.deepEqual(chunks,['普通回答']);assert.equal(h.requests.length,0);
});

test('voice answers request concise spoken language without applying it to text chat',async()=>{
  const h=harness(),options={signal:new AbortController().signal,allowLocal:false,onTool:()=>{},onDelta:()=>{}};
  await h.api.askFreeChat([{role:'user',content:'解释一下'}],{...options,voice:true});
  await h.api.askFreeChat([{role:'user',content:'解释一下'}],options);
  assert.match(h.chatCalls[0].messages[0].content,/语音对话/);assert.equal(h.chatCalls[0].maxTokens,700);
  assert.doesNotMatch(h.chatCalls[1].messages[0].content,/语音对话/);
});

test('conversation history persists locally and a second save updates the same thread',async()=>{
  const h=harness();await h.api.saveFreeChat('id',[{role:'user',content:'你好'}]);
  await h.api.saveFreeChat('id',[{role:'user',content:'你好'},{role:'assistant',content:'您好'}]);
  assert.equal(h.data.freeChats.length,1);assert.equal(h.data.freeChats[0].messages.length,2);
});
