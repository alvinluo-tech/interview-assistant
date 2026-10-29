import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function engine({ completionFails = false, deferred = true, deferredSession = false, fixedTime = false, deferredCapture = false } = {}) {
  let resolveRequest, options, requests = 0;
  let resolveSession, resolveCapture, created = 0;
  const calls = [];
  const bridge = {
    captureScreen: async () => deferredCapture ? new Promise(resolve => { resolveCapture = resolve; }) : 'data:image/png;base64,synthetic',
    hideOverlay: async () => calls.push('hide'),
    showMain: async () => calls.push('main'),
    setSessionActive: async on => calls.push(on ? 'active' : 'inactive'),
  };
  const api = evaluateFixture('src/lib/examEngine.ts', {
    exports: {}, console, Date: fixedTime ? class extends Date { static now() { return 1000; } } : Date, AbortController,
    window: { setInterval: () => 1, clearInterval() {} },
    require: name => {
      if (name === './bridge') return bridge;
      if (name === './store') return { getSetting: (_key, fallback) => fallback, DEFAULT_EXAM_CUSTOMIZATION: {}, setSetting: async () => {} };
      if (name === './backend') return {
        readData: (_key, fallback) => fallback,
        createExamSession: async () => { created++; return deferredSession ? new Promise(resolve => { resolveSession = resolve; }) : { id: 'synthetic-session' }; },
        updateExamSession: async () => calls.push('persist'),
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
  return { api, calls, options: () => options, requests: () => requests, resolve: text => resolveRequest?.(text),
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
