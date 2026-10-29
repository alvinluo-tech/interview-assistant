import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function harness({ deferredListeners = false, deferredCount = false } = {}) {
  const listeners = new Map(), pending = [], timers = new Map(), calls = [], classes = new Set();
  let nextTimer = 1, countResolve, stopped = 0;
  const state = { mode: 'quick', phase: 'idle', turns: [], pendingScreenshots: [], elapsedSec: 0 };
  const bridge = {
    listenEvent: (name, fn) => {
      const register = () => { listeners.set(name, fn); return () => { if (listeners.get(name) === fn) listeners.delete(name); }; };
      return deferredListeners ? new Promise(resolve => pending.push(() => resolve(register()))) : Promise.resolve(register());
    },
    cmd: async (name, args) => {
      calls.push([name, args]);
      if (name === 'cmd_dual_peer_count') return deferredCount ? new Promise(resolve => { countResolve = resolve; }) : 0;
      if (name === 'cmd_get_overlay_rect') return [0, 0, 840, 1040];
      if (name === 'cmd_dual_stop') { stopped++; listeners.get('dual-peer')?.({ count: 0, reason: 'stopped' }); }
      return true;
    },
    setCursorPointFeed: async on => calls.push(['feed', on]),
    setOverlayZones: async zones => calls.push(['zones', zones]),
    setOverlaySize: async (...size) => calls.push(['size', size]),
  };
  let ended = 0, solved = 0;
  const engine = {
    getSolverState: () => state, examModeInfo: () => ({ label: '快速', maxScreenshotPages: 4 }),
    subscribeSolver: () => () => {}, solve: async () => { solved++; },
    endExamSession: async () => { ended++; },
    answerNow() {}, capturePage: async () => {}, clearPendingScreenshots() {},
    followUp: async () => {}, nextExamMode: () => 'programming', setSolverMode() {},
  };
  const api = evaluateFixture('src/lib/dualScreen.ts', {
    exports: {}, console, Date, JSON,
    document: { documentElement: { classList: { add: x => classes.add(x), remove: x => classes.delete(x) } } },
    window: { innerWidth: 420, innerHeight: 520,
      setInterval: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
      setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
      clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id),
    },
    require: name => {
      if (name === './bridge') return bridge;
      if (name === './examEngine') return engine;
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  return { api, calls, classes, timers, listeners,
    register: () => pending.splice(0).forEach(fn => fn()),
    resolveCount: n => countResolve?.(n),
    emit: (name, payload) => listeners.get(name)?.(payload),
    message: payload => listeners.get('dual-message')?.(JSON.stringify(payload)),
    stopped: () => stopped, ended: () => ended, solved: () => solved,
  };
}

test('stopping the service restores the computer immediately instead of waiting for reconnect grace', async () => {
  const h = harness(), stop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  assert.equal(h.api.isZonesSuppressed(), true);
  h.emit('dual-peer', { count: 0, reason: 'stopped' }); await flush();
  assert.equal(h.api.isZonesSuppressed(), false);
  assert.equal(h.classes.has('dual-takeover'), false);
  stop();
});

test('a disposed overlay cannot be taken over by a late peer query or leaked listener', async () => {
  const h = harness({ deferredListeners: true, deferredCount: true });
  const stop = h.api.startDualTakeover(); await flush(); stop();
  h.register(); await flush(); h.resolveCount(1); await flush();
  assert.equal(h.api.isZonesSuppressed(), false);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

test('phone return-to-computer closes its session and ignores subsequent actions', async () => {
  const h = harness(), stop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  h.message({ t: 'exit' }); await flush();
  assert.equal(h.stopped(), 1);
  assert.equal(h.api.isZonesSuppressed(), false);
  h.message({ t: 'action', id: 'solve' }); await flush();
  assert.equal(h.solved(), 0);
  stop();
});

test('desktop dwell can return control and phone can end the exam through the same action path', async () => {
  const h = harness(), stop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  h.message({ t: 'action', id: 'end-session' }); await flush();
  assert.equal(h.ended(), 1);
  assert.equal(h.stopped(), 1);
  assert.equal(h.api.isZonesSuppressed(), false);
  stop();
});

test('malformed phone messages cannot escape the event handler or write zones', async () => {
  const h = harness(), stop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  assert.doesNotThrow(() => h.message(null));
  assert.doesNotThrow(() => h.message({ t: 'zones', zones: [{ id: 'solve', x: NaN, y: 0, w: 1, h: 1 }] }));
  await flush();
  assert.ok(!h.calls.some(([name, zones]) => name === 'zones' && zones.some(z => !Number.isFinite(z.x))));
  h.message({ t: 'zones', zones: [{ id: 'end-session', x: 0, y: 0, w: 0.2, h: 0.1 }] }); await flush();
  assert.ok(!h.calls.some(([name, zones]) => name === 'zones' && zones.some(z => z.id === 'dual:end-session')), 'A desktop dwell must not bypass the phone end-session confirmation');
  stop();
});

test('cleanup of a replaced takeover cannot clear the new session zones or cursor feed', async () => {
  const h = harness(), oldStop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  oldStop();
  const newStop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  assert.equal(h.api.isZonesSuppressed(), true);
  assert.equal(h.calls.filter(([name]) => name === 'zones').length, 0, 'Obsolete async restore must not clear zones after the next owner starts');
  newStop(); await flush();
});

test('zero and near-zero background opacity also apply to nested buttons', () => {
  const { computeSkin, normalizeStyle } = evaluateFixture('src/lib/overlayStyle.ts', { exports: {} });
  const alpha = color => Number(/,\s*([\d.]+)\)$/.exec(color)?.[1]);
  for (const mode of ['exam', 'interview']) {
    for (const opacity of [0, 0.03]) {
      const skin = computeSkin(normalizeStyle({ [`${mode}BgOpacity`]: opacity }), mode);
      for (const key of ['--ov-chip-bg', '--ov-chip-active-bg', '--ov-pill-bg']) {
        assert.ok(alpha(skin.vars[key]) <= (opacity === 0 ? 0 : 0.15), `${mode} ${key} must follow the transparent surface`);
      }
    }
  }
});

test('hiding the overlay ends phone control instead of leaving a connected but unresponsive page', async () => {
  const h = harness(), stop = h.api.startDualTakeover(); await flush();
  h.emit('dual-peer', { count: 1 }); await flush();
  stop(); await flush();
  assert.equal(h.stopped(), 1);
  assert.ok(h.calls.some(([name, args]) => name === 'cmd_dual_send' && JSON.parse(args.text).t === 'released'));
});
