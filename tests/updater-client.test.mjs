import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';

function client({ busy = false, phase = 'available' } = {}) {
  const calls = [], saved = new Map();
  let native = { phase, currentVersion: '0.1.1', version: '0.1.2', notes: 'Fixes', busy, canInstall: true, downloaded: 0 };
  let notify;
  const api = evaluateFixture('src/lib/updateCheck.ts', { exports: {}, URL, AbortSignal, console });
  assert.equal(typeof api.createUpdateClient, 'function', 'A shared native-backed updater client must exist');
  const updater = api.createUpdateClient({
    invoke: async (name, args) => {
      calls.push([name, args]);
      if (name === 'cmd_updater_download') native = { ...native, phase: 'ready', downloaded: 100 };
      if (name === 'cmd_updater_install') native = { ...native, phase: 'installing' };
      return native;
    },
    listen: async fn => { notify = fn; return () => {}; },
    read: key => saved.get(key), write: async (key, value) => { saved.set(key, value); },
    now: () => 1_000_000,
  });
  return { updater, calls, saved, emit: value => notify?.(value) };
}

test('manual checks share one native-backed state and never request the REST API', async () => {
  const h = client();
  await h.updater.check(true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0][0], 'cmd_updater_check');
  assert.equal(h.updater.getSnapshot().version, '0.1.2');
});

test('download completion never installs until the user explicitly confirms', async () => {
  const h = client(); await h.updater.check(true); await h.updater.download();
  assert.equal(h.updater.getSnapshot().phase, 'ready');
  assert.ok(!h.calls.some(([name]) => name === 'cmd_updater_install'));
  await h.updater.install();
  assert.equal(h.calls.at(-1)[0], 'cmd_updater_install');
});

test('busy sessions suppress prompts and prevent installation', async () => {
  const h = client({ busy: true }); await h.updater.check(true);
  assert.equal(h.updater.shouldPrompt(), false);
  await assert.rejects(h.updater.install(), /会话|结束/);
  assert.ok(!h.calls.some(([name]) => name === 'cmd_updater_install'));
});

test('automatic prompts are remembered per version and can be deferred', async () => {
  const h = client(); await h.updater.check(false);
  assert.equal(h.updater.shouldPrompt(), true);
  await h.updater.defer();
  assert.equal(h.updater.shouldPrompt(), false);
  assert.ok(h.saved.size > 0);
});

test('native progress and failures stay visible without being called up-to-date', async () => {
  const h = client(); const stop = await h.updater.connect();
  h.emit({ phase: 'downloading', version: '0.1.2', downloaded: 50, total: 100, busy: false, canInstall: true });
  assert.equal(h.updater.getSnapshot().downloaded, 50);
  h.emit({ phase: 'error', error: '签名验证失败', busy: false, canInstall: true });
  assert.equal(h.updater.getSnapshot().phase, 'error');
  assert.match(h.updater.getSnapshot().error, /签名/);
  stop();
});
