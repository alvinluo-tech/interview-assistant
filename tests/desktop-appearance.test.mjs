import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { evaluateFixture } from './compile-fixture.mjs';

test('first paint respects system, light and dark theme preferences', () => {
  const html = readFileSync('index.html', 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  for (const [stored, systemDark, expected] of [
    ['system', true, true], ['system', false, false], ['light', true, false],
    ['dark', false, true], [null, true, true],
  ]) {
    let dark = false;
    const document = { documentElement: { style: {}, classList: { add: name => { if (name === 'dark') dark = true; } } } };
    const matchMedia = () => ({ matches: systemDark });
    vm.runInNewContext(script, { location: { hash: '' }, document, localStorage: { getItem: () => stored }, window: { matchMedia }, matchMedia });
    assert.equal(dark, expected, `${stored}, system=${systemDark}`);
  }
});

test('desktop theme tracks store changes and system appearance without touching overlay state', () => {
  let theme = 'system', scale = 1, dark = false, systemDark = true, storeChanged, systemChanged;
  const document = { documentElement: { style: {}, classList: { toggle: (_name, value) => { dark = value; } } } };
  const media = { get matches() { return systemDark; }, addEventListener: (_type, cb) => { systemChanged = cb; } };
  const api = evaluateFixture('src/lib/desktopAppearance.ts', {
    exports: {}, document, localStorage: { getItem: () => 'dark' }, window: { matchMedia: () => media },
    require: name => {
      assert.equal(name, './store');
      return { getSetting: (key, fallback) => key === 'desktop.theme' ? theme : key === 'desktop.uiScale' ? scale : fallback,
        subscribeStore: cb => { storeChanged = cb; } };
    },
  });
  api.initDesktopAppearance();
  assert.equal(dark, true);
  theme = 'light'; scale = 1.2; storeChanged();
  assert.equal(dark, false);
  assert.equal(document.documentElement.style.zoom, '1.2');
  theme = 'system'; storeChanged();
  assert.equal(dark, true);
  systemDark = false; systemChanged();
  assert.equal(dark, false);
});
