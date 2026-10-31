import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function engine({ completionFails = false, imageSaveFails = false, captureFails = false, deferred = true, deferredSession = false, fixedTime = false, deferredCapture = false, settings = {}, records=[] } = {}) {
  let resolveRequest, options, requests = 0, sentImages = [], captures = 0;
  let resolveSession, resolveCapture, created = 0;
  const calls = [], saved = [],prompts=[],createdInputs=[];
  const timers = new Set(), checkpoints = new Map();
  const bridge = {
    cmd: async command => { if (imageSaveFails && command === 'cmd_exam_store_images') throw new Error('disk full'); return ['synthetic/turn/image.png']; },
    captureScreen: async () => { captures++; if(captureFails) throw new Error('capture denied'); return deferredCapture ? new Promise(resolve => { resolveCapture = resolve; }) : `synthetic-page-${captures}`; },
    hideOverlay: async () => calls.push('hide'),
    showMain: async () => calls.push('main'),
    setSessionActive: async on => calls.push(on ? 'active' : 'inactive'),
  };
  const api = evaluateFixture('src/lib/examEngine.ts', {
    exports: {}, console, Date: fixedTime ? class extends Date { static now() { return 1000; } } : Date, AbortController,
    window: { setInterval: () => { const id = {}; timers.add(id); return id; }, clearInterval(id) {timers.delete(id);}, setTimeout(fn) {const id={}; checkpoints.set(id,fn); return id;}, clearTimeout(id){checkpoints.delete(id);} },
    require: name => {
      if (name === './aiContext') return evaluateFixture('src/lib/aiContext.ts',{exports:{}});
      if (name === './bridge') return bridge;
      if (name === './store') return { getSetting: (key, fallback) => settings[key] ?? fallback, DEFAULT_EXAM_CUSTOMIZATION: {}, setSetting: async (key,value) => {settings[key] = value;} };
      if (name === './backend') return {
        readData: (_key, fallback) => _key==='examSessions'?records:fallback,
        createExamSession: async input => { createdInputs.push(input);created++; return deferredSession ? new Promise(resolve => { resolveSession = resolve; }) : { id: 'synthetic-session' }; },
        updateExamSession: async (_id, record) => { calls.push('persist'); saved.push(record); },
        completeExamSession: async () => { if (completionFails) throw new Error('Disk unavailable'); calls.push('complete'); },
      };
      if (name === './ai') return { EXAM_SYSTEM_PROMPT: '', buildExamUserPrompt: () => 'test', chatWithImages: async (_prompt, _images, opts) => {
        requests++;prompts.push(_prompt); sentImages.push(_images); options = opts;
        if (deferred) return new Promise(resolve => { resolveRequest = resolve; });
        opts.onDelta?.('answer'); return 'answer';
      } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { api, calls, saved, settings, timers,prompts,createdInputs,sentImages, captures:()=>captures, runCheckpoints:()=>{for(const fn of [...checkpoints.values()])fn();checkpoints.clear();}, options: () => options, requests: () => requests, resolve: text => resolveRequest?.(text),
    created: () => created, resolveSession: () => resolveSession?.({ id: 'synthetic-session' }), resolveCapture: () => resolveCapture?.('synthetic') };
}

test('first solve sends all collected screenshots without taking a replacement', async () => {
  const h=engine({deferred:false}); await h.api.capturePage(); await h.api.capturePage();
  await h.api.solve();
  assert.deepEqual(Array.from(h.sentImages[0]),['synthetic-page-1','synthetic-page-2']);
  assert.equal(h.captures(),2);
});

test('code review captures the current screen before requesting an answer', async () => {
  const h=engine({deferred:false}); await h.api.solve({screenshots:['original']});
  await h.api.followUp({intent:'code-review'});
  assert.deepEqual(Array.from(h.sentImages[1]),['synthetic-page-1']);
});

test('image save failure stays visible while the captured image is sent', async () => {
  const h=engine({deferred:false,imageSaveFails:true}); await h.api.solve({screenshots:['original']});
  assert.match(h.api.getSolverState().errorMessage,/截图未能保存/);
  assert.match(h.api.getSolverState().turns[0].imageSaveError,/disk full/);
  assert.deepEqual(Array.from(h.sentImages[0]),['original']);
});

test('code review never sends the old answer when current screenshot fails', async () => {
  const h=engine({deferred:false,captureFails:true}); await h.api.solve({screenshots:['original']});
  await h.api.followUp({intent:'code-review'});
  assert.equal(h.requests(),1);
  assert.match(h.api.getSolverState().errorMessage,/capture denied/);
});

test('a streaming exam answer is checkpointed before completion', async () => {
  const h=engine(); const request=h.api.solve({screenshots:['original']}); await flush();
  h.options().onDelta('<exam-question>题目</exam-question><exam-answer>部分答案');
  h.runCheckpoints(); await flush();
  assert.equal(h.saved.at(-1).questions[0].answer,'部分答案');
  h.resolve('<exam-question>题目</exam-question><exam-answer>答案</exam-answer>'); await request;
});

test('an explicitly selected interrupted standalone exam restores its questions', () => {
  const h=engine({records:[{id:'exam-1',status:'ACTIVE',questions:[{id:'q',questionText:'题目',answer:'旧答案',createdAt:1}]}]});
  h.api.prepareExamRun('new-run',null,undefined,'exam-1');
  assert.equal(h.api.getSolverState().turns[0].body,'旧答案');
});

test('ending an exam cancels generation and ignores late streamed text and completion', async () => {
  const h = engine(); await h.api.startExamSession(null);
  const request = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  await h.api.endExamSession(false);
  assert.equal(h.options().signal?.aborted, true);
  h.options().onDelta('late text'); h.resolve('late completion'); await request;
  assert.equal(h.api.getSolverState().phase, 'idle');
  assert.equal(h.api.getSolverState().sessionId, null);
  assert.equal(h.api.getSolverState().turns.length, 0);
  assert.ok(h.calls.includes('hide') && h.calls.includes('main'));
  assert.ok(h.calls.indexOf('persist') >= 0 && h.calls.indexOf('persist') < h.calls.indexOf('complete'), 'Save the partial answer before completing the record');
});

test('two initial solve actions cannot create two sessions before either creation completes', async () => {
  const h = engine({ deferredSession: true, deferred: false });
  const first = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  const second = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  assert.equal(h.created(), 1);
  h.resolveSession(); await Promise.all([first, second]);
});

test('ending while a session or screenshot is pending cannot resurrect the closed session', async () => {
  const h = engine({ deferredSession: true, deferred: false });
  const pending = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  await h.api.endExamSession(false); h.resolveSession(); await pending;
  assert.equal(h.api.getSolverState().sessionId, null);
  assert.equal(h.requests(), 0);
  const capture = engine({ deferredCapture: true });
  const screenshot = capture.api.capturePage(); await flush();
  await capture.api.endExamSession(false); capture.resolveCapture(); await screenshot.catch(() => {});
  assert.equal(capture.api.getSolverState().pendingScreenshots.length, 0);
});

test('question identifiers stay distinct when a follow-up starts in the same millisecond', async () => {
  const h = engine({ deferred: false, fixedTime: true });
  await h.api.solve({ screenshots: ['synthetic'] });
  await h.api.followUp({ intent: 'simplify' });
  const turns = h.api.getSolverState().turns;
  assert.equal(new Set(turns.map(turn => turn.id)).size, 2);
  assert.equal(turns[0].body, 'answer');
});

test('repeated solve actions cannot start competing generation requests', async () => {
  const h = engine(); await h.api.startExamSession(null);
  const first = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  const second = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  assert.equal(h.requests(), 1);
  h.resolve('answer'); await Promise.all([first, second]);
});

test('streamed follow-ups are not appended a second time on completion', async () => {
  const h = engine({ deferred: false });
  await h.api.solve({ screenshots: ['synthetic'] });
  await h.api.followUp({ intent: 'simplify' });
  const answer = h.api.getSolverState().turns.at(-1).body;
  assert.equal(answer.match(/answer/g)?.length, 1);
});

test('a record-save failure cannot trap the user in an unclosable exam overlay', async () => {
  const h = engine({ completionFails: true }); await h.api.startExamSession(null);
  await assert.rejects(h.api.endExamSession(false), /Disk unavailable/);
  assert.ok(h.calls.includes('hide') && h.calls.includes('main'));
  assert.equal(h.api.getSolverState().sessionId, null);
});

test('exam records retain recognized question text separately from the answer', async () => {
  const h = engine();
  const pending = h.api.solve({ screenshots: ['synthetic'] }); await flush();
  h.resolve('<exam-question>计算 1 + 2 的结果。</exam-question><exam-answer>3</exam-answer>'); await pending;
  assert.equal(h.saved.at(-1).questions[0].questionText, '计算 1 + 2 的结果。');
  assert.equal(h.saved.at(-1).questions[0].answer, '3');
});

test('clearing a capture does not erase completed questions from the session', async () => {
  const h = engine({ deferred: false });
  await h.api.solve({ screenshots: ['synthetic'] }); await h.api.abortSolve();
  assert.equal(h.api.getSolverState().turns.length, 1);
});


test('capture limit rejects extra pages instead of silently discarding them (B28)', async () => {
  const h = engine();
  for(let i=0;i<4;i++) await h.api.capturePage();
  await assert.rejects(h.api.capturePage(), /4|最多|上限/);
  assert.equal(h.api.getSolverState().pendingScreenshots.length,4);
});

test('answer-now preserves partial output and ignores late completion (B11)', async () => {
  const h = engine(); const pending = h.api.solve({screenshots:['synthetic']}); await flush();
  h.options().onDelta('<exam-answer>partial');
  await h.api.answerNow();
  assert.equal(h.options().signal.aborted,true);
  assert.equal(h.api.getSolverState().phase,'done');
  assert.equal(h.api.getSolverState().turns.at(-1).body,'partial');
  h.resolve('late final'); await pending;
  assert.equal(h.api.getSolverState().turns.at(-1).body,'partial');
  assert.equal(h.saved.at(-1).questions[0].answer,'partial');
});

test('solver clocks stop on completion and abort (B12)', async () => {
  const h = engine({deferred:false}); await h.api.solve({screenshots:['synthetic']});
  assert.equal(h.timers.size,0);
  await h.api.abortSolve(); assert.equal(h.timers.size,0);
});

test('interview solver mode does not overwrite exam settings (B33)', async () => {
  const h = engine({settings:{'overlay.mode':'interview','exam.mode':'quick','interview.solverExamMode':'instant'}});
  await h.api.startExamSession(null);
  assert.equal(h.api.getSolverState().mode,'instant');
  await h.api.setSolverMode('programming'); await flush();
  assert.equal(h.settings['exam.mode'],'quick');
  assert.equal(h.settings['interview.solverExamMode'],'programming');
});


test('selecting an earlier question scopes a real follow-up request to that question',async()=>{
  const h=engine();
  const first=h.api.solve({screenshots:['synthetic']});await flush();h.resolve('<exam-question>第一题约束十万项</exam-question><exam-answer>第一题代码</exam-answer>');await first;
  const firstId=h.api.getSolverState().turns[0].id;
  const second=h.api.solve({screenshots:['synthetic']});await flush();h.resolve('<exam-question>第二题SQL</exam-question><exam-answer>SELECT 1</exam-answer>');await second;
  h.api.selectSolverTurn(firstId);const follow=h.api.followUp({message:'优化复杂度'});await flush();
  assert.match(h.prompts.at(-1),/十万项/);assert.match(h.prompts.at(-1),/第一题代码/);assert.doesNotMatch(h.prompts.at(-1),/第二题|SELECT/);
  h.resolve('优化答案');await follow;
  assert.equal(h.api.getSolverState().turns.at(-1).parentTurnId,firstId);
});

test('embedded exam restores only the owning interview and stops when that interview ends',async()=>{
  const record={id:'embedded',interviewSessionId:'interview-A',status:'ACTIVE',questions:[{id:'q',questionText:'已保存原题',answer:'已保存代码',createdAt:1}]};
  const h=engine({records:[record]});h.api.prepareExamRun('interview:interview-A',null,'interview-A');
  assert.equal(h.api.getSolverState().turns[0].body,'已保存代码');
  const request=h.api.followUp({message:'继续检查'});await flush();await h.api.finishInterviewExam('interview-A');
  assert.equal(h.options().signal.aborted,true);h.options().onDelta('迟到文本');h.resolve('迟到文本');await request;
  assert.ok(!h.api.getSolverState().turns.some(turn=>turn.body.includes('迟到文本')));assert.ok(h.calls.includes('complete'));
  h.api.prepareExamRun('interview:interview-B',null,'interview-B');assert.equal(h.api.getSolverState().turns.length,0);
});
