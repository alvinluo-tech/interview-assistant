import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFixture } from './compile-fixture.mjs';
function harness(configured = false) {
  const calls = [], states = [], errors = [];
  const api = evaluateFixture('src/lib/questionSpeaker.ts', {exports: {}, AbortController, require: () => ({})});
  assert.equal(typeof api.createQuestionSpeaker, 'function', 'Question speech needs a cancellable system fallback');
  const speaker = api.createQuestionSpeaker({
    configured: () => configured,
    cloud: async () => {calls.push('cloud'); return new ArrayBuffer(1);},
    play: (_bytes, state) => {calls.push('play');state(true);return () => calls.push('stop-audio');},
    system: async (_text, state) => {calls.push('system');state(true);return () => calls.push('stop-system');},
  }, value => states.push(value), error => errors.push(error));
  return {speaker,calls,states,errors};
}
test('unconfigured TTS uses the system voice and stops when muted', async () => {
  const h = harness(); await h.speaker.speak('你好');
  assert.deepEqual(h.calls, ['system']);
  h.speaker.stop(); assert.equal(h.calls.at(-1), 'stop-system'); assert.equal(h.states.at(-1), false);
});
test('configured TTS uses its cloud route and releases playback on stop', async () => {
  const h = harness(true); await h.speaker.speak('你好');
  assert.deepEqual(h.calls, ['cloud','play']); h.speaker.stop(); assert.equal(h.calls.at(-1), 'stop-audio');
});

test('muting while a cloud request is pending cannot play late audio', async () => {
  const api = evaluateFixture('src/lib/questionSpeaker.ts', {exports: {}, AbortController});
  let complete, signal; const calls = [];
  const speaker = api.createQuestionSpeaker({configured: () => true,
    cloud: (_text, pending) => {signal = pending; return new Promise(resolve => {complete = resolve;});},
    play: () => {calls.push('play'); return () => {};}, system: async () => () => {},
  }, () => {}, () => {});
  const pending = speaker.speak('问题'); speaker.stop();
  assert.equal(signal.aborted, true); complete(new ArrayBuffer(2)); await pending;
  assert.deepEqual(calls, []);
});

test('a late system registration is disposed and cannot change the muted state', async () => {
  const api = evaluateFixture('src/lib/questionSpeaker.ts', {exports: {}, AbortController});
  let complete, onState, releases = 0; const states = [];
  const speaker = api.createQuestionSpeaker({configured: () => false, cloud: async () => null, play: () => () => {},
    system: (_text, changed) => {onState = changed; return new Promise(resolve => {complete = resolve;});},
  }, value => states.push(value), () => {});
  const pending = speaker.speak('问题'); speaker.stop();
  onState(true); complete(() => {releases++;}); await pending;
  assert.equal(states.at(-1), false); assert.equal(releases, 1);
});

test('blank text does not request audio and configured service failures are visible', async () => {
  const api = evaluateFixture('src/lib/questionSpeaker.ts', {exports: {}, AbortController});
  const errors = []; let requests = 0;
  const speaker = api.createQuestionSpeaker({configured: () => true,
    cloud: async () => {requests++; return null;}, play: () => () => {}, system: async () => () => {},
  }, () => {}, error => errors.push(error));
  await speaker.speak('  '); assert.equal(requests, 0);
  await speaker.speak('问题'); assert.equal(errors.length, 1);
});
