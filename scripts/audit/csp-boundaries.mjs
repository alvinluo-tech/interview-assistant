// Production CSP in a real browser: synthetic PDF, worker, wasm, images and muted media.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readFile,mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {DesktopCdp} from '../desktop-cdp.mjs';
const policy=JSON.parse(await readFile('src-tauri/tauri.conf.json','utf8')).app.security.csp;
const csp=Object.entries(policy).map(([name,value])=>name+' '+(Array.isArray(value)?value.join(' '):value)).join('; ');
const content='BT /F1 12 Tf 50 750 Td (Synthetic CSP resume) Tj ET';
const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
let pdf='%PDF-1.4\n';const offsets=[0];objects.forEach((object,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const probe=`import{getDocument,GlobalWorkerOptions}from'/pdf.mjs';
window.__TAURI_INTERNALS__={metadata:{currentWindow:{label:'main'}}};window.__result=null;
const violations=[];document.addEventListener('securitypolicyviolation',event=>violations.push({directive:event.effectiveDirective,blocked:event.blockedURI}));
try{
GlobalWorkerOptions.workerSrc='/pdf.worker.mjs';
const task=getDocument({data:Uint8Array.from(atob(${JSON.stringify(Buffer.from(pdf).toString('base64'))}),c=>c.charCodeAt(0)),standardFontDataUrl:'/pdfjs/standard_fonts/',wasmUrl:'/pdfjs/wasm/'});
const documentPdf=await task.promise;const page=await documentPdf.getPage(1);const text=(await page.getTextContent()).items.map(item=>item.str||'').join(' ');await task.destroy();
new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0]));
const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const image=new Image();image.src=canvas.toDataURL();await image.decode();
const wav=new ArrayBuffer(44+320),v=new DataView(wav),ascii=(at,s)=>[...s].forEach((c,i)=>v.setUint8(at+i,c.charCodeAt(0)));ascii(0,'RIFF');v.setUint32(4,wav.byteLength-8,true);ascii(8,'WAVE');ascii(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);ascii(36,'data');v.setUint32(40,320,true);
const audio=new Audio();audio.muted=true;const audioUrl=URL.createObjectURL(new Blob([wav],{type:'audio/wav'}));await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=reject;audio.src=audioUrl;audio.load();});URL.revokeObjectURL(audioUrl);
let evalBlocked=false;try{eval('1+1')}catch{evalBlocked=true;}
window.__injected=false;const injected=document.createElement('script');injected.textContent='window.__injected=true';document.head.append(injected);injected.remove();
let networkBlocked=false;try{await fetch('https://csp-blocked.invalid/probe')}catch{networkBlocked=true;}
await new Promise(resolve=>setTimeout(resolve,100));
window.__result={pdfText:text,pdfWorker:true,wasm:true,imageDecoded:true,blobMediaLoaded:true,evalBlocked,inlineBlocked:!window.__injected,networkBlocked,violations};
}catch(error){window.__result={error:String(error.stack||error)};}`;
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');res.setHeader('Content-Security-Policy',csp);
  try{
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><div>Isolated CSP test</div><script type="module" src="/probe.mjs"></script>');return;}
    if(url.pathname==='/probe.mjs'){res.setHeader('Content-Type','text/javascript');res.end(probe);return;}
    const exact={'/pdf.mjs':'node_modules/pdfjs-dist/legacy/build/pdf.mjs','/pdf.worker.mjs':'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'};
    let file=exact[url.pathname];
    if(!file&&url.pathname.startsWith('/pdfjs/')&&!url.pathname.includes('..'))file='public'+url.pathname;
    if(!file){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.mjs')?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream');res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await mkdir('artifacts/audit',{recursive:true});await new Promise(resolve=>server.listen(1447,'127.0.0.1',resolve));
let browser,cdp;
try{
  const profile=await mkdtemp(path.resolve('artifacts/csp-browser-'));
  browser=spawn(process.env.UI_TEST_BROWSER||path.join(process.env.PROGRAMFILES||'','Google/Chrome/Application/chrome.exe'),['--headless=new','--no-first-run',`--user-data-dir=${profile}`,'--remote-debugging-port=19409','http://127.0.0.1:1447'],{windowsHide:true,stdio:'ignore'});
  cdp=new DesktopCdp(19409,'main');await cdp.connect();await cdp.waitFor('!!window.__result');const result=await cdp.evaluate('__result');
  await writeFile('artifacts/audit/csp-boundaries.json',JSON.stringify({createdAt:new Date().toISOString(),policy,result},null,2));assert.equal(result.error,undefined);assert.match(result.pdfText,/Synthetic CSP resume/);
  for(const field of ['pdfWorker','wasm','imageDecoded','blobMediaLoaded','evalBlocked','inlineBlocked','networkBlocked'])assert.equal(result[field],true,field);
  assert.ok(result.violations.some(item=>item.directive==='connect-src'&&item.blocked==='https://csp-blocked.invalid/probe'));
  console.log(JSON.stringify(result));
}finally{if(cdp?.socket){await cdp.command('Browser.close',{}).catch(()=>{});cdp.close();}browser?.kill();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
