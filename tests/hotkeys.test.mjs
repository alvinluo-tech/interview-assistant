import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateModuleFixture} from './compile-fixture.mjs';

const hotkeys = () => evaluateModuleFixture('src/lib/hotkeys.ts');

test('every action has a default in both schemes and no two actions share a key', () => {
  const {ACTIONS, SCHEME_DEFAULTS} = hotkeys();
  for (const scheme of ['simple', 'conflict-free']) {
    const defaults = SCHEME_DEFAULTS[scheme];
    for (const action of ACTIONS) {
      assert.ok(defaults[action], `${scheme} is missing a default for ${action}`);
    }
    const used = new Map();
    for (const action of ACTIONS) {
      const key = defaults[action].toLowerCase();
      assert.equal(used.get(key), undefined, `${scheme}: ${action} collides with ${used.get(key)} on ${key}`);
      used.set(key, action);
    }
  }
});

test('interrupting an answer is reachable from the keyboard, not only by hovering', () => {
  const {ACTIONS, ACTION_LABELS, SCHEME_DEFAULTS, effectiveHotkeys} = hotkeys();
  assert.ok(ACTIONS.includes('cancel'));
  assert.ok(ACTION_LABELS.cancel.label && ACTION_LABELS.cancel.desc);
  assert.equal(SCHEME_DEFAULTS.simple.cancel, 'CmdOrCtrl+.');
  assert.ok(SCHEME_DEFAULTS['conflict-free'].cancel.startsWith('CmdOrCtrl+Alt+Shift+'));
  // 老用户没有自定义这一项，也要直接拿到默认键，否则升级后按不出来。
  assert.equal(effectiveHotkeys('simple', {'copy-code': 'CmdOrCtrl+Shift+K'}).cancel, 'CmdOrCtrl+.');
  // 用户关掉它时不被默认值覆盖回来。
  assert.equal(effectiveHotkeys('simple', {cancel: ''}).cancel, '');
});
