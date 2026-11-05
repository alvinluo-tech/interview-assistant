import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture, evaluateModuleFixture} from './compile-fixture.mjs';
test('click-outside cleanup cancels registration even if a queued timer runs late',()=>{
  let cleanup;const timers=new Map(),queued=[],listeners=new Set();
  const api=evaluateFixture('src/ui/primitives.tsx',{exports:{},window:{setTimeout:fn=>{const id=queued.push(fn);timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)},document:{addEventListener:(_event,fn)=>listeners.add(fn),removeEventListener:(_event,fn)=>listeners.delete(fn)},require:name=>{
    if(name==='@/lib/i18n')return evaluateModuleFixture('src/lib/i18n.ts');
    if(name==='react')return {createContext:()=>({}),useRef:value=>({current:value}),useEffect:effect=>{cleanup=effect();}};
    if(['react/jsx-runtime','react-dom','lucide-react','../lib/events','./useModalFocus'].includes(name))return {};
    throw Error(name);
  }});
  api.useClickOutside(()=>{});cleanup();for(const task of queued)task();assert.equal(timers.size,0);assert.equal(listeners.size,0);
});
