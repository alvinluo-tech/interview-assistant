import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture, evaluateModuleFixture} from './compile-fixture.mjs';
test('displayed app version follows the package version prepared by release tooling', () => {
  const env = evaluateFixture('src/lib/env.ts', { exports: {}, require: name => {
    assert.equal(name, '../../package.json'); return { version: '0.8.7' };
  } });
  assert.equal(env.APP_VERSION, '0.8.7');
});

test('the mock window hash accepts its session query instead of mounting the main workbench',()=>{
  const location={hash:'#mock?sid=mock-123'};
  const i18n=evaluateModuleFixture('src/lib/i18n.ts',{window:{location}});
  assert.equal(i18n.windowScene(),'mock');
  location.hash='#overlay';assert.equal(i18n.windowScene(),'overlay');
  location.hash='#mocked';assert.equal(i18n.windowScene(),'main');
});
