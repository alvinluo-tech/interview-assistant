import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateFixture} from './compile-fixture.mjs';

function harness({desktop=true,owner=true,current='session',fail=false,emitFails=false}={}) {
  const handlers=new Map(),calls=[],settings={'interview.sessionId':'session'};
  const bridge={isTauri:()=>desktop,listenEvent:async(name,fn)=>{const set=handlers.get(name)||new Set();set.add(fn);handlers.set(name,set);return()=>set.delete(fn);},
    emitTo:async(_target,name,payload)=>{
      if(emitFails)throw new Error('emit unavailable');
      for(const handler of [...(handlers.get(name)||[])])await handler(payload);
    }};
  const api=evaluateFixture('src/lib/interviewLifecycle.ts',{exports:{},console,crypto:{randomUUID:()=> 'request'},
    setTimeout:(fn)=>setTimeout(fn,30),clearTimeout,require:name=>{
      if(name==='./bridge')return bridge;
      if(name==='./backend')return {completeSession:async()=>{calls.push('complete');}};
      if(name==='./store')return {getSetting:(key,fallback)=>settings[key]??fallback,setSetting:async(key,value)=>{settings[key]=value;}};
      if(name==='./interviewEngine')return {getInterviewEngineState:()=>({sessionId:current}),endInterview:async()=>{calls.push('stop');if(fail)throw new Error('disk failure');current=null;}};
      throw new Error(name);
    }});
  const off=owner?api.listenForInterviewStop():()=>{};
  return {api,calls,settings,handlers,off,bridge};
}

test('workbench waits for the owning runtime to stop, then releases its listener',async()=>{
  const h=harness();await h.api.requestInterviewStop('session');
  assert.deepEqual(h.calls,['stop']);assert.equal(h.settings['interview.sessionId'],null);
  assert.equal(h.handlers.get('interview-stop-result').size,0);h.off();
  assert.equal(h.handlers.get('interview-stop-request').size,0);
});
test('an already stopped owner can complete the recovered record',async()=>{
  const h=harness({current:null});await h.api.requestInterviewStop('session');
  assert.deepEqual(h.calls,['complete']);h.off();
});
test('storage errors and changed sessions are reported instead of false success',async()=>{
  for(const options of [{fail:true},{current:'another-session'}]){
    const h=harness(options);await assert.rejects(h.api.requestInterviewStop('session'),/disk failure|已改变/);
    assert.equal(h.handlers.get('interview-stop-result').size,0);h.off();
  }
});
test('missing owners and transport failures clean up pending listeners',async()=>{
  for(const options of [{owner:false},{emitFails:true}]){
    const h=harness(options);await assert.rejects(h.api.requestInterviewStop('session'),/尚未确认|emit unavailable/);
    assert.equal(h.handlers.get('interview-stop-result').size,0);h.off();
  }
});
test('browser-only use completes the local record without native events',async()=>{
  const h=harness({desktop:false,owner:false});await h.api.requestInterviewStop('session');
  assert.deepEqual(h.calls,['complete']);assert.equal(h.handlers.size,0);
});
test('a result belonging to another stop request cannot complete this one',async()=>{
  const h=harness({owner:false});const pending=h.api.requestInterviewStop('session');
  for(let i=0;i<5;i++)await Promise.resolve();
  await h.bridge.emitTo('main','interview-stop-result',{requestId:'stale-request'});
  assert.equal(h.handlers.get('interview-stop-result').size,1);
  await h.bridge.emitTo('main','interview-stop-result',{requestId:'request'});await pending;
  assert.equal(h.handlers.get('interview-stop-result').size,0);
});
test('unmount before async registration completes still removes the listener',async()=>{
  let resolve,removed=0;
  const api=evaluateFixture('src/lib/interviewLifecycle.ts',{exports:{},console,require:name=>name==='./bridge'?{listenEvent:()=>new Promise(done=>{resolve=done;})}: {}});
  const off=api.listenForInterviewStop();off();resolve(()=>removed++);
  for(let i=0;i<5;i++)await Promise.resolve();assert.equal(removed,1);
});
test('a disposed owner ignores requests even before listener removal resolves',async()=>{
  let resolve,handler,stops=0;
  const api=evaluateFixture('src/lib/interviewLifecycle.ts',{exports:{},console,require:name=>{
    if(name==='./bridge')return {listenEvent:(_event,callback)=>{handler=callback;return new Promise(done=>{resolve=done;});},emitTo:async()=>{}};
    if(name==='./interviewEngine')return {getInterviewEngineState:()=>({sessionId:'session'}),endInterview:async()=>{stops++;}};
    if(name==='./store')return {getSetting:()=>null};
    return {};
  }});
  const off=api.listenForInterviewStop();off();await handler({requestId:'stale',sessionId:'session'});
  resolve(()=>{});assert.equal(stops,0);
});
