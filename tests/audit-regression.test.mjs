import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {evaluateFixture, evaluateModuleFixture} from './compile-fixture.mjs';
test('audit boundary invariants remain regression gates after the fixes',()=>{
  const result=spawnSync(process.execPath,['scripts/audit/boundary-probes.mjs','--verify'],{encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  assert.doesNotMatch(result.stdout,/FINDING|PROBE ERROR/);
});

test('a late failed AI configuration read cannot invalidate a newer successful read',async()=>{
  const pending=[];
  const api=evaluateFixture('src/lib/aiSettings.ts',{exports:{},window:{__TAURI_INTERNALS__:{}},structuredClone,require:name=>{
    if(name==='./i18n')return evaluateModuleFixture('src/lib/i18n.ts');
    if(name==='react')return {};
    if(name==='@tauri-apps/api/event')return {};
    if(name==='./aiConfig')return {defaultAiSettings:()=>({version:'initial'}),validateAiSettings:value=>value};
    return {invoke:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))};
  }});
  const older=api.reloadAiSettings(),newer=api.reloadAiSettings();pending[1].resolve({version:'new'});await newer;pending[0].reject(Error('old failure'));await older;
  assert.equal(api.getAiLoadError(),'');assert.equal(api.getAiSettings().version,'new');
});

test('a late native settings response cannot overwrite a newer cross-window event',async()=>{
  let listener,resolveWrite;const calls=[];
  const api=evaluateFixture('src/lib/store.ts',{exports:{},window:{__TAURI_INTERNALS__:{}},require:name=>{
    if(name==='./i18n')return evaluateModuleFixture('src/lib/i18n.ts');
    if(name==='react')return {};
    if(name==='@tauri-apps/api/event')return {listen:async(_event,handler)=>{listener=handler;},emit:async()=>{throw Error('Native writes must not be re-broadcast by JS');}};
    if(name==='@tauri-apps/api/core')return {invoke:(name)=>{calls.push(name);return new Promise(resolve=>{resolveWrite=resolve;});}};
    if(name==='./events')return {bus:{emit(){}}};
    throw Error(name);
  }});
  await api.initStoreSync();const writing=api.setSetting('overlay.mode','exam');
  for(let i=0;i<10;i++)await Promise.resolve();assert.equal(calls[0],'cmd_set_setting');
  listener({payload:{key:'overlay.mode',value:'interview'}});resolveWrite();await writing;
  assert.equal(api.getSetting('overlay.mode',''),'interview');
});

test('desktop synchronization failures reach startup recovery instead of being swallowed',async()=>{
  for(const file of ['src/lib/store.ts','src/lib/backend.ts']){
    const api=evaluateFixture(file,{exports:{},window:{__TAURI_INTERNALS__:{}},require:name=>{
      if(name==='./i18n')return evaluateModuleFixture('src/lib/i18n.ts');
      if(name==='react')return {};
      if(name==='@tauri-apps/plugin-store')return {};
      if(name==='@tauri-apps/api/event')return {listen:async()=>{throw Error('synthetic subscription failure');}};
      throw Error(name);
    }});
    await assert.rejects(file.endsWith('store.ts')?api.initStoreSync():api.initDataSync(),/subscription failure/);
  }
});
