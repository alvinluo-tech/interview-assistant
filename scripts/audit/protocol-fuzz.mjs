// Fixed seed and bounded inputs make failures reproducible without third-party services.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {evaluateFixture} from '../../tests/compile-fixture.mjs';
let seed=0x20261104;
function random(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;}
function load(file,overrides={}){return evaluateFixture(file,{exports:{},URL,Response,ReadableStream,TextDecoder,TextEncoder,Int16Array,Float32Array,Uint8Array,ArrayBuffer,DataView,DOMException,AbortController,setTimeout,clearTimeout,require:name=>Object.hasOwn(overrides,name)?overrides[name]:load(path.resolve(path.dirname(file),name.replace(/\.js$/,'')+'.ts'),overrides)});}
const results=[];
const {PcmResampler}=load('src/lib/microphone.ts');
let audioCases=0,maxPcmDifference=0;
for(const rate of [8000,16000,22050,44100,48000,96000]){
  for(let iteration=0;iteration<16;iteration++){
    const length=Math.floor(rate*(0.12+random()*0.1));const input=Float32Array.from({length},(_,i)=>Math.sin(i*2*Math.PI*440/rate)*0.6);
    const expected=new PcmResampler(rate).process(input),resampler=new PcmResampler(rate),parts=[];
    for(let cursor=0;cursor<input.length;){const size=1+Math.floor(random()*1024);parts.push(...resampler.process(input.subarray(cursor,cursor+size)));cursor+=size;if(random()<0.2)assert.equal(resampler.process(new Float32Array()).length,0);}
    assert.equal(parts.length,expected.length,`Audio duration changed for rate ${rate}`);
    for(let i=0;i<parts.length;i++)maxPcmDifference=Math.max(maxPcmDifference,Math.abs(parts[i]-expected[i]));
    assert.ok(maxPcmDifference<=1);audioCases++;
  }
}
results.push({area:'PCM chunk partition invariance',cases:audioCases,passed:true,maxPcmDifference});
const {normalizeBaseUrl,validateModelId}=load('src/lib/aiConfig.ts');
let urlCases=0,modelCases=0;
for(let i=0;i<256;i++){
  const url=`${i%2?'https':'http'}://api${i}.example.invalid:${8000+i}/gateway/v1${i%3?'/chat/completions':'/audio/transcriptions'}`;
  const normalized=normalizeBaseUrl(url);assert.equal(normalizeBaseUrl(normalized),normalized);assert.ok(normalized.endsWith('/gateway/v1'));urlCases++;
  for(const invalid of [`file:///tmp/${i}`,`https://name:secret@api${i}.invalid/v1`,`https://api${i}.invalid/v1?key=value`]){assert.throws(()=>normalizeBaseUrl(invalid));urlCases++;}
  assert.equal(validateModelId('model-'+i),'model-'+i);assert.throws(()=>validateModelId('model\u0000'+i));assert.throws(()=>validateModelId('m'.repeat(257+i)));modelCases+=3;
}
results.push({area:'Provider URL normalization and model validation',cases:urlCases+modelCases,passed:true,urlCases,modelCases});
const {consumeChatResult}=load('src/lib/aiProtocol.ts');
let streamCases=0;
for(let i=0;i<128;i++){
  const fragments=['中文🙂 '+i,' quote " and newline\n','最后一段'];
  const wire=fragments.map(content=>'data: '+JSON.stringify({choices:[{delta:{content}}]})+'\r\n\r\n').join('')+'data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(wire),chunks=[];
  for(let cursor=0;cursor<bytes.length;){const size=1+Math.floor(random()*17);chunks.push(bytes.slice(cursor,cursor+size));cursor+=size;}
  const response=new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  const result=await consumeChatResult(response);assert.equal(result.text,fragments.join(''));assert.equal(result.completionStatus,'complete');streamCases++;
}
results.push({area:'SSE UTF-8 and arbitrary network frame splits',cases:streamCases,passed:true});
await mkdir('artifacts/audit',{recursive:true});
await writeFile('artifacts/audit/protocol-fuzz.json',JSON.stringify({createdAt:new Date().toISOString(),seed:'0x20261104',results,totalCases:results.reduce((sum,row)=>sum+row.cases,0)},null,2));
console.log(JSON.stringify({results,totalCases:results.reduce((sum,row)=>sum+row.cases,0)}));
