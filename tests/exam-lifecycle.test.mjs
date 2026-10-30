import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function engine({ completionFails = false, deferred = true, deferredSession = false, fixedTime = false, deferredCapture = false, settings = {} } = {}) {
  let resolveRequest, options, requests = 0;
  let resolveSession, resolveCapture, created = 0;
  const calls = [], saved = [];
  const timers = new Set();
  const bridge = {
    cmd: async () => ['synthetic/turn/image.png'],
    captureScreen: async () => deferredCapture ? new Promise(resolve => { resolveCapture = resolve; }) : 'data:image/png;base64,synthetic',
    hideOverlay: async () => calls.push('hide'),
    showMain: async () => calls.push('main'),
    setSessionActive: async on => calls.push(on ? 'active' : 'inactive'),
  };
  const api = evaluateFixture('src/lib/examEngine.ts', {
    exports: {}, console, Date: fixedTime ? class extends Date { static now() { return 1000; } } : Date, AbortController,
    window: { setInterval: () => { const id = {}; timers.add(id); return id; }, clearInterval(id) {timers.delete(id);} },
    require: name => {
      if (name === './bridge') return bridge;
      if (name === './store') return { getSetting: (key, fallback) => settings[key] ?? fallback, DEFAULT_EXAM_CUSTOMIZATION: {}, setSetting: async (key,value) => {settings[key] = value;} };
      if (name === './backend') return {
        readData: (_key, fallback) => fallback,
        createExamSession: async () => { created++; return deferredSession ? new Promise(resolve => { resolveSession = resolve; }) : { id: 'synthetic-session' }; },
        updateExamSession: async (_id, record) => { calls.push('persist'); saved.push(record); },
        completeExamSession: async () => { if (completionFails) throw new Error('Disk unavailable'); calls.push('complete'); },
      };
      if (name === './ai') return { EXAM_SYSTEM_PROMPT: '', buildExamUserPrompt: () => 'test', chatWithImages: async (_prompt, _images, opts) => {
        requests++; options = opts;
        if (deferred) return new Promise(resolve => { resolveRequest = resolve; });
        opts.onDelta?.('answer'); return 'answer';
      } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { api, calls, saved, settings, timers, options: () => options, requests: () => requests, resolve: text => resolveRequest?.(text),
    created: () => created, resolveSession: () => resolveSession?.({ id: 'synthetic-session' }), resolveCapture: () => resolveCapture?.('synthetic') };
}

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
