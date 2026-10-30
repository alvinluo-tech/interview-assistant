import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';
const keys = evaluateFixture('src/lib/hotkeys.ts',{exports:{}});

test('recorder rejects modifier-only and unknown physical keys (B18)', () => {
  for(const code of ['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight','OSLeft','Unidentified','']) {
    const result=keys.keyEventToAccelerator({code,ctrlKey:true,shiftKey:true});
    assert.equal(result.accelerator,'',code);
    assert.ok(result.error,code);
  }
  assert.equal(keys.keyEventToAccelerator({code:'KeyA',ctrlKey:true}).accelerator,'Control+A');
  for(const code of ['Escape','NumpadAdd','NumpadSubtract','NumpadMultiply','NumpadDivide','NumpadDecimal','NumpadEnter']) {
    assert.equal(keys.keyEventToAccelerator({code}).accelerator,code);
  }
});

test('exam answer-language preference reaches the actual prompt (B27)', () => {
  const ai=evaluateFixture('src/lib/ai.ts',{exports:{},require:()=>({})});
  assert.match(ai.buildExamUserPrompt({answerLanguage:'en-US'}),/en-US/);
  assert.match(ai.buildExamUserPrompt({answerLanguage:'ja-JP',programmingLanguage:'Python 3'}),/ja-JP/);
  assert.doesNotMatch(ai.buildExamUserPrompt({answerLanguage:'auto'}),/auto/);
});
