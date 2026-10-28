import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function moduleFrom(file, mocks = {}) {
  const sandbox = { exports: {}, require: name => { if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`); return mocks[name]; }, Blob, TextDecoder, TextEncoder, Uint8Array, AbortController, DOMException, console };
  return evaluateFixture(file,sandbox);
}

test('imported resume body and full job requirements reach the selected context, with source excerpts', () => {
  const { buildKnowledgeContext } = moduleFrom('src/lib/knowledgeContext.ts');
  const context = buildKnowledgeContext({
    resume: { id: 'r', title: '简历', summary: '旧摘要', content: '负责订单系统，使用 Redis 幂等键解决重复支付。' },
    goal: { id: 'g', name: '后端工程师', description: '必须熟悉 Redis 幂等与分布式事务。' },
    materials: [{ id: 'm', name: '项目细节', content: '订单幂等使用 request_id 唯一索引兜底。', entries: [] }],
    query: '如何实现订单幂等？', maxChars: 4000,
  });
  assert.match(context.text, /Redis 幂等键/);
  assert.match(context.text, /必须熟悉 Redis 幂等与分布式事务/);
  assert.match(context.text, /request_id/);
  assert.ok(context.sources.every(source => source.id && source.excerpt));
  assert.ok(context.text.length <= 4000);
});

test('answer prompts preserve the selected JD and relevant document excerpts rather than only an old summary', () => {
  const { buildInterviewSystemPrompt } = moduleFrom('src/lib/ai.ts', { './aiRequests': {} });
  const prompt = buildInterviewSystemPrompt({ goalName: '后端', contextBlock: '【J1】必须具备支付幂等经验\n【R1】主导 request_id 唯一索引改造' });
  assert.match(prompt, /必须具备支付幂等经验/);
  assert.match(prompt, /主导 request_id/);
});

test('mock interviewer receives the same full document context', async () => {
  let sent;
  const mock = moduleFrom('src/lib/mock.ts', { './ai': { chatStream: async options => { sent = options.messages; return '请介绍一下你的支付幂等设计'; } } });
  await mock.generateOpeningQuestion({ goalName: '后端', difficultyLabel: '3-5 年', turnBudget: 5, basicsRatio: 50, assistMode: false,
    knowledgeContext: '【J1】必须掌握支付幂等\n【R1】负责 Redis request_id 设计' });
  assert.match(sent[0].content, /必须掌握支付幂等/);
  assert.match(sent[0].content, /Redis request_id/);
});

test('a failed document save is rejected and does not appear in the local resume list', async () => {
  const store = { set: async () => {}, save: async () => { throw new Error('disk full'); }, delete: async () => {}, get: async () => undefined };
  const backend = moduleFrom('src/lib/backend.ts', { '@tauri-apps/plugin-store': { load: async () => store }, react: { useSyncExternalStore() {} } });
  await assert.rejects(backend.saveResume({ title: 'Resume', content: 'Project experience' }), /保存|disk/);
  assert.equal(backend.readData('resumes', []).length, 0);
});

test('PDF text is extracted locally, scanned pages require consent, and resources close on all outcomes', async () => {
  const { parseDocument } = moduleFrom('src/lib/documentIngest.ts');
  let closed = 0, ocrCalls = 0;
  const file = { name: 'resume.pdf', type: 'application/pdf', size: 100,
    arrayBuffer: async () => new TextEncoder().encode('%PDF-1.7 synthetic-fixture').buffer };
  const services = {
    openPdf: async () => ({ pageCount: 2, getPage: async number => ({ text: number === 1 ? '项目经历：负责订单服务，使用 Redis 与 MySQL 保证订单幂等。' : '', render: async () => 'data:image/png;base64,fixture' }), close: async () => { closed++; } }),
    recognizeImage: async () => { ocrCalls++; return '扫描页：订单峰值每秒 3000 笔。'; },
  };
  await assert.rejects(parseDocument(file, {}, services), error => error.code === 'VISION_CONSENT_REQUIRED');
  assert.equal(ocrCalls, 0);
  assert.equal(closed, 1);
  const document = await parseDocument(file, { allowVision: true }, services);
  assert.match(document.text, /Redis 与 MySQL/);
  assert.match(document.text, /每秒 3000 笔/);
  assert.equal(document.method, 'mixed');
  assert.equal(document.pages, 2);
  assert.equal(ocrCalls, 1);
  assert.equal(closed, 2);
});

test('retrieval finds relevant late paragraphs and reports a truncated context budget', () => {
  const { buildKnowledgeContext } = moduleFrom('src/lib/knowledgeContext.ts');
  const context = buildKnowledgeContext({ resume: { id: 'r', title: 'Resume', content: '无关的早期经历。'.repeat(900) + '\n支付幂等项目使用 Redis request_id。' },
    query: 'Redis request_id 支付幂等', maxChars: 500 });
  assert.match(context.text, /Redis request_id/);
  assert.ok(context.text.length <= 500);
  assert.equal(context.truncated, true);
  const single = buildKnowledgeContext({ resume: { id: 'r', title: 'Resume', content: '一'.repeat(900) }, maxChars: 500 });
  assert.equal(single.truncated, true);
  assert.equal(buildKnowledgeContext({ maxChars: 0 }).text, '');
});

test('document import rejects malformed/oversized/unsupported files and cancellation without sending anything', async () => {
  const { parseDocument } = moduleFrom('src/lib/documentIngest.ts');
  const services = { openPdf() { throw new Error('must not open'); }, recognizeImage() { throw new Error('must not send'); } };
  const file = { name: 'resume.txt', type: 'text/plain', size: 20, arrayBuffer: async () => new TextEncoder().encode('项目经历：实现了支付幂等服务。').buffer };
  assert.match((await parseDocument(file, {}, services)).text, /支付幂等/);
  for (const bad of [{ ...file, size: 0 }, { ...file, size: 30 * 1024 * 1024 }, { ...file, name: 'resume.exe' }, { ...file, name: 'resume.pdf' }]) {
    await assert.rejects(parseDocument(bad, {}, services));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(parseDocument(file, { signal: controller.signal }, services), error => error.name === 'AbortError');
  await assert.rejects(parseDocument({ ...file, arrayBuffer: async () => Uint8Array.from([255, 254, 0, 1]).buffer }, {}, services), error => error.code === 'TEXT_ENCODING');
  await assert.rejects(parseDocument({ ...file, name: 'scan.png' }, {}, services), error => error.code === 'VISION_CONSENT_REQUIRED');
});

test('image imports, page limits and empty OCR fail with explicit errors and release PDF resources',async()=>{
  const {parseDocument}=moduleFrom('src/lib/documentIngest.ts');
  const file={name:'scan.png',type:'image/png',size:10,arrayBuffer:async()=>new TextEncoder().encode('%PDF-1.7 fixture').buffer};
  const services={openPdf:async()=>{throw new Error('unexpected');},readImage:async()=> 'data:image/png;base64,fixture',recognizeImage:async()=> '识别到的正文'};
  assert.equal((await parseDocument(file,{allowVision:true},services)).method,'vision');
  await assert.rejects(parseDocument(file,{allowVision:true},{...services,readImage:undefined}),error=>error.code==='IMAGE_UNAVAILABLE');
  await assert.rejects(parseDocument(file,{allowVision:true},{...services,recognizeImage:async()=>''}),error=>error.code==='EMPTY_DOCUMENT');
  let closed=0;
  const pdf=async(count,text='')=>parseDocument({...file,name:'scan.pdf'},{allowVision:true},{...services,openPdf:async()=>({pageCount:count,getPage:async()=>({text,render:async()=>''}),close:async()=>{closed++;}})});
  await assert.rejects(pdf(31),error=>error.code==='TOO_MANY_PAGES');
  await assert.rejects(pdf(11),error=>error.code==='TOO_MANY_SCANS');
  assert.equal(closed,2);
  const large={...file,name:'large.txt',arrayBuffer:async()=>new TextEncoder().encode('x'.repeat(150001)).buffer};
  await assert.rejects(parseDocument(large,{},services),error=>error.code==='TOO_MUCH_TEXT');
});
