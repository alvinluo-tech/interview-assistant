import {emitTo, isTauri, listenEvent} from './bridge';
import {completeSession} from './backend';
import {getSetting, setSetting} from './store';

interface StopRequest {requestId:string; sessionId:string}
interface StopResult {requestId:string; error?:string}

/** The main webview must wait for the owning overlay to stop its microphone/AI. */
export async function requestInterviewStop(sessionId:string):Promise<void> {
  if (!isTauri()) {await completeSession(sessionId);return;}
  const requestId=crypto.randomUUID();
  let timer:ReturnType<typeof setTimeout> | undefined;
  let resolve!:()=>void, reject!:(error:Error)=>void;
  const result=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});
  void result.catch(()=>{}); // A slow emit must not leave the deadline rejection unobserved.
  const off=await listenEvent<StopResult>('interview-stop-result',payload=>{
    if(payload.requestId!==requestId)return;
    if(payload.error)reject(new Error(payload.error));else resolve();
  });
  try {
    timer=setTimeout(()=>reject(new Error('浮窗尚未确认停止收音，请重试结束面试。')),5000);
    await emitTo('overlay','interview-stop-request',{requestId,sessionId});
    await result;
  } finally {if(timer)clearTimeout(timer);off();}
}

export function listenForInterviewStop():()=>void {
  let disposed=false, release:(()=>void)|undefined;
  void listenEvent<StopRequest>('interview-stop-request',async payload=>{
    if(disposed)return;
    let error:string|undefined;
    try {
      const engine=await import('./interviewEngine');
      const current=engine.getInterviewEngineState().sessionId;
      if(current && current!==payload.sessionId)throw new Error('当前面试已改变，请刷新工作台后重试。');
      if(current)await engine.endInterview(true);
      else await completeSession(payload.sessionId);
      if(getSetting('interview.sessionId',null)===payload.sessionId)await setSetting('interview.sessionId',null);
    } catch(reason){error=String((reason as Error).message||reason);}
    await emitTo('main','interview-stop-result',{requestId:payload.requestId,error});
  }).then(off=>{if(disposed)off();else release=off;}).catch(error=>console.warn('[sessions] stop listener unavailable',error));
  return ()=>{disposed=true;release?.();};
}
