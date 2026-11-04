import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {delay} from '../desktop-cdp.mjs';
await mkdir('artifacts/audit',{recursive:true});
const server=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','1438','--strictPort'],{windowsHide:true,stdio:'ignore'});
const results=[];
function suite(file){return new Promise((resolve,reject)=>{
  const started=Date.now(),child=spawn(process.execPath,[file],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
  child.stdout.on('data',bytes=>output+=bytes);child.stderr.on('data',bytes=>output+=bytes);child.on('error',reject);
  child.on('exit',async(code,signal)=>{const result={file,code,signal,elapsedMs:Date.now()-started};results.push(result);await writeFile(`artifacts/audit/${file.split('/').at(-1)}.log`,output);console.log(JSON.stringify(result));resolve(result);});
});}
try{
  let ready=false;for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('Audit server could not acquire port 1438');try{if((await fetch('http://127.0.0.1:1438')).ok){ready=true;break;}}catch{}await delay(100);}
  if(!ready)throw Error('Audit server not ready');
  await Promise.all([suite('scripts/experience-ui-smoke.mjs'),suite('scripts/mock-room-smoke.mjs')]);
  await Promise.all([suite('scripts/overlay-ui-smoke.mjs'),suite('scripts/updater-ui-smoke.mjs')]);
  await suite('scripts/bug-review-ui-smoke.mjs');
  await writeFile('artifacts/audit/browser-suites.json',JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
  if(results.some(result=>result.code!==0))process.exitCode=1;
}finally{server.kill();}
