export type VoiceCallPhase = 'idle'|'connecting'|'listening'|'transcribing'|'thinking'|'speaking';
export interface VoiceCallDrivers {
  open(onPcm:(pcm:Int16Array,volume:number)=>void,onError:(message:string)=>void):Promise<{close():Promise<void>}>;
  openRealtime?(onPreview:(text:string)=>void,onError:(message:string)=>void,signal:AbortSignal):Promise<{push(pcm:Int16Array):void;finish():Promise<string>;close():Promise<void>}>;
  preview?(text:string):void;
  transcribe(pcm:Int16Array,signal:AbortSignal):Promise<string>;
  send(text:string):Promise<void>|void;
  speak(text:string,finished:()=>void,failed:(error:unknown)=>void):void;
  stopSpeech():void;
  cancelAnswer():void;
  state(phase:VoiceCallPhase):void;
  error(message:string):void;
}

/** Turn-taking avoids transcribing the speaker's own output. Audio is never retained across turns. */
export function createVoiceCall(drivers:VoiceCallDrivers) {
  let phase:VoiceCallPhase='idle',generation=0,mic:{close():Promise<void>}|undefined,request:AbortController|undefined;
  let realtime:Awaited<ReturnType<NonNullable<VoiceCallDrivers['openRealtime']>>>|undefined,realtimeAbort:AbortController|undefined;
  let chunks:Int16Array[]=[],samples=0,voiced=0,silence=0,pre:Int16Array[]=[];
  const change=(next:VoiceCallPhase)=>{phase=next;drivers.state(next);};
  const reset=()=>{chunks=[];samples=0;voiced=0;silence=0;pre=[];};
  const stop=()=>{generation++;request?.abort();request=undefined;realtimeAbort?.abort();realtimeAbort=undefined;const stream=realtime;realtime=undefined;void stream?.close();const old=mic;mic=undefined;void old?.close();reset();drivers.preview?.('');drivers.stopSpeech();drivers.cancelAnswer();change('idle');};
  const fail=(error:unknown)=>{const message=String((error as Error)?.message || error);stop();drivers.error(message);};
  async function listen(current:number) {
    if(current!==generation)return;
    reset();change('connecting');
    try {
      if(drivers.openRealtime){
        const controller=new AbortController();realtimeAbort=controller;
        const stream=await drivers.openRealtime(text=>{if(current===generation&&phase==='listening')drivers.preview?.(text);},message=>{if(current===generation)fail(message);},controller.signal);
        if(current!==generation){await stream.close();return;}realtime=stream;
      }
      const opened=await drivers.open(push,message=>{if(current===generation)fail(message);});
      if(current!==generation){await opened.close();return;}
      mic=opened;change('listening');
    } catch(error) {if(current===generation)fail(error);}
  }
  async function finish(current:number) {
    if(phase!=='listening'||current!==generation)return;
    change('transcribing');const old=mic;mic=undefined;
    const pcm=new Int16Array(samples);let offset=0;for(const part of chunks){pcm.set(part,offset);offset+=part.length;}reset();
    try {
      await old?.close();if(current!==generation)return;
      request=new AbortController();const controller=request;
      const stream=realtime;realtime=undefined;
      const text=(stream ? await stream.finish() : await drivers.transcribe(pcm,controller.signal)).trim();
      if(current!==generation||controller.signal.aborted)return;
      request=undefined;realtimeAbort=undefined;drivers.preview?.('');
      if(!text){await listen(current);return;}
      change('thinking');await drivers.send(text);
    } catch(error){if(current===generation)fail(error);}
  }
  function push(pcm:Int16Array,volume:number) {
    if(phase!=='listening'||!pcm.length)return;
    realtime?.push(pcm);
    const voice=volume>=12;
    if(!samples&&!voice){pre.push(pcm);while(pre.reduce((n,p)=>n+p.length,0)>3200)pre.shift();return;}
    if(!samples){for(const part of pre){chunks.push(part);samples+=part.length;}pre=[];}
    chunks.push(pcm);samples+=pcm.length;
    if(voice){voiced+=pcm.length;silence=0;}else silence+=pcm.length;
    if(samples>=16000*30 || (silence>=16000*1.2 && voiced>=3200))void finish(generation);
    else if(silence>=16000*2 && voiced<3200)reset();
  }
  return {
    start(){if(phase!=='idle')return;const current=++generation;void listen(current);},
    stop,
    interrupt(){if(phase!=='speaking'&&phase!=='thinking')return;generation++;drivers.stopSpeech();drivers.cancelAnswer();void listen(generation);},
    answer(text:string){if(phase!=='thinking')return;const current=generation;if(!text.trim()){fail('未收到可播放的回答，请检查对话服务。');return;}
      change('speaking');drivers.speak(text,()=>{if(current===generation&&phase==='speaking')void listen(current);},error=>{if(current===generation)fail(error);});},
    answerFailed(error:unknown){if(phase==='thinking')fail(error);},
    getPhase(){return phase;},
  };
}
