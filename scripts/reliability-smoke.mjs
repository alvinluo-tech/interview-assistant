import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp} from './desktop-cdp.mjs';
const executable=path.resolve('artifacts/audio-smoke.exe');
const identifier='com.mianlingai.clone.audiosmoke';
assert.ok((await readFile(executable)).includes(Buffer.from(identifier)));
const start=()=>spawn(executable,[],{windowsHide:true,stdio:'ignore',env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=19395'}});
let child=start();
const desktop=new DesktopCdp(19395);const checks=[];
const commit=(expected,value)=>desktop.invoke('cmd_data_commit',{key:'resumes',expected,value});
try {
  await desktop.connect();const initial=await desktop.invoke('cmd_data_read');
  const original=initial.data.resumes??[];const base=original.filter(row=>!row.id.startsWith('reliability-'));
  await commit(original,base);
  const a={id:'reliability-a',title:'A',content:'body',createdAt:1},b={id:'reliability-b',title:'B',content:'body',createdAt:2};
  await Promise.all([commit(base,[...base,a]),commit(base,[...base,b])]);
  const combined=(await desktop.invoke('cmd_data_read')).data.resumes;
  assert.ok(combined.some(row=>row.id===a.id)&&combined.some(row=>row.id===b.id));
  const first=combined.map(row=>row.id===a.id?{...row,title:'changed'}:row);
  const second=combined.map(row=>row.id===a.id?{...row,content:'edited body'}:row);
  await Promise.all([commit(combined,first),commit(combined,second)]);
  const merged=(await desktop.invoke('cmd_data_read')).data.resumes;
  assert.equal(merged.find(row=>row.id===a.id).title,'changed');assert.equal(merged.find(row=>row.id===a.id).content,'edited body');
  await assert.rejects(commit(combined,combined.map(row=>row.id===a.id?{...row,title:'conflicting'}:row)));
  checks.push('concurrent additions and independent fields merge; conflicting edits reject');
  await desktop.invoke('cmd_data_backup',{restore:false});
  await commit(merged,merged.filter(row=>row.id!==b.id));
  await desktop.invoke('cmd_data_backup',{restore:true});
  const restored=await desktop.invoke('cmd_data_read');assert.ok(restored.data.resumes.some(row=>row.id===b.id));
  const disk=JSON.parse(await readFile(path.join(process.env.APPDATA,identifier,'data.json'),'utf8'));
  assert.ok(disk.resumes.some(row=>row.id===b.id));
  checks.push('manual backup restores committed data on disk');
  const dataPath=path.join(process.env.APPDATA,identifier,'data.json');
  if(process.platform==='win32') {
    const before=await readFile(dataPath,'utf8');await chmod(dataPath,0o444);
    try {
      await assert.rejects(commit(restored.data.resumes,[...restored.data.resumes,{id:'must-not-save',title:'failed'}]));
      assert.equal(await readFile(dataPath,'utf8'),before);
      assert.ok(!(await desktop.invoke('cmd_data_read')).data.resumes.some(row=>row.id==='must-not-save'));
      checks.push('a real disk permission failure preserves both committed memory and disk');
    }finally{await chmod(dataPath,0o666);}
  }
  await assert.rejects(desktop.invoke('cmd_data_commit',{key:'private-unknown',expected:null,value:[]}));
  const image=await desktop.invoke('cmd_capture_screen',{captureMode:'screen'});
  const png=Buffer.from(image.split(',')[1],'base64');assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.readUInt32BE(16)>100);
  checks.push('native screenshot is a nonempty PNG');
  let docker;
  try {docker=await desktop.invoke('cmd_code_check');}
  catch(error){assert.match(error.message,/Docker|引擎/);docker='unavailable';}
  checks.push('Docker preflight reports the real local engine state');
  const exited=new Promise(resolve=>child.once('exit',resolve));
  desktop.close();child.kill();await exited;
  await writeFile(dataPath,'{"deliberately-corrupt":');
  child=start();await desktop.connect();
  await desktop.waitFor("document.body.innerText.includes('本地数据读取失败，已阻止覆盖')");
  await assert.rejects(desktop.invoke('cmd_data_read'));
  await desktop.invoke('cmd_data_backup',{restore:true});
  await desktop.waitFor("!document.body.innerText.includes('本地数据读取失败，已阻止覆盖')");
  assert.ok((await desktop.invoke('cmd_data_read')).data.resumes.some(row=>row.id===b.id));
  checks.push('a corrupt data file still opens the recovery UI and restores the manual backup');
  for(const check of checks)console.log('PASS '+check);
  await writeFile('artifacts/reliability-smoke-results.json',JSON.stringify({checks,docker,isolated:true},null,2));
}finally{await desktop.invoke('cmd_quit_app').catch(()=>child.kill());desktop.close();}
