import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';

function bridge({ granted = false, allowOnRequest = false, requestReportsSuccess = false, desktop = true } = {}) {
  const calls = [];
  const api = evaluateFixture('src/lib/bridge.ts', {
    exports: {}, window: desktop ? { __TAURI_INTERNALS__: {} } : {},
    require: name => {
      if (name === '@tauri-apps/api/event') return {};
      if (name === '@tauri-apps/api/core') return { invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === 'cmd_check_screen_capture_permission') return granted;
        if (command === 'cmd_request_screen_capture_permission') { granted = allowOnRequest; return requestReportsSuccess; }
        if (command === 'cmd_capture_screen') return 'data:image/png;base64,ok';
        if (command === 'cmd_start_system_audio_capture') return { sampleRate: 16000, channels: 1, devices: [] };
        throw new Error(`Unexpected command: ${command}`);
      } };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  return { api, calls };
}

test('denied Mac permission prevents both screenshot and system audio startup', async () => {
  for (const action of ['captureScreen', 'startSystemAudioCapture']) {
    const h = bridge({ requestReportsSuccess: true });
    await assert.rejects(h.api[action](), /屏幕.*录制|录屏/);
    assert.ok(!h.calls.some(c => c.command === 'cmd_capture_screen' || c.command === 'cmd_start_system_audio_capture'));
  }
});

test('an effective grant allows capture and preserves the requested window scope', async () => {
  const h = bridge({ allowOnRequest: true });
  assert.equal(await h.api.captureScreen({ captureMode: 'window' }), 'data:image/png;base64,ok');
  assert.equal(h.calls.at(-1).args.captureMode, 'window');
  assert.equal(h.calls.filter(c => c.command === 'cmd_request_screen_capture_permission').length, 1);
  const ready = bridge({ granted: true });
  assert.equal((await ready.api.startSystemAudioCapture()).sampleRate, 16000);
  assert.ok(!ready.calls.some(c => c.command === 'cmd_request_screen_capture_permission'));
});

test('browser preview does not masquerade as a native capture session', async () => {
  const h = bridge({ desktop: false });
  await assert.rejects(h.api.captureScreen(), /桌面/);
  assert.equal(h.calls.length, 0);
});

test('unmounting before event registration completes cannot leak a listener or deliver late events', async () => {
  let completeRegistration, handler, removed = 0, delivered = 0;
  const api = evaluateFixture('src/lib/bridge.ts', {
    exports: {}, window: { __TAURI_INTERNALS__: {} },
    require: name => {
      if (name === '@tauri-apps/api/core') return {};
      if (name === '@tauri-apps/api/event') return { listen: (_event, callback) => {
        handler = callback;
        return new Promise(resolve => { completeRegistration = resolve; });
      } };
      throw new Error(`Unexpected dependency ${name}`);
    },
  });
  const stop = api.onEvent('synthetic-event', () => { delivered++; });
  stop(); completeRegistration(() => { removed++; });
  await Promise.resolve(); await Promise.resolve();
  handler({ payload: {} });
  assert.equal(removed, 1);
  assert.equal(delivered, 0);
});
