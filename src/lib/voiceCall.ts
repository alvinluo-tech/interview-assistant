import { t } from './i18n';
export type VoiceCallPhase = 'idle'|'connecting'|'listening'|'transcribing'|'thinking'|'speaking';
export interface VoiceCallDrivers {
  open(onPcm:(pcm:Int16Array,volume:number)=>void,onError:(message:string)=>void):Promise<{close():Promise<void>}>;
  /** Optional barge-in capture: it keeps listening while the answer plays so speech can cut it short. */
  openMonitor?(onPcm:(pcm:Int16Array,volume:number)=>void,onError:(message:string)=>void):Promise<{close():Promise<void>}>;
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

/** The realtime recogniser ends a turn on the same silence window. */
const END_SILENCE_MS = 800;
/** Speech this long during playback interrupts the answer instead of talking over it. */
const BARGE_IN_MS = 400;
const BARGE_IN_VOLUME = 22;

/** Turn-taking avoids transcribing the speaker's own output. Audio is never retained across turns. */
export function createVoiceCall(drivers:VoiceCallDrivers) {
  let phase:VoiceCallPhase='idle',generation=0,mic:{close():Promise<void>}|undefined,request:AbortController|undefined;
  let realtime:Awaited<ReturnType<NonNullable<VoiceCallDrivers['openRealtime']>>>|undefined,realtimeAbort:AbortController|undefined;
  let chunks:Int16Array[]=[],samples=0,voiced=0,silence=0,pre:Int16Array[]=[];
  let queue:string[]=[],playing=false,answerDone=true,monitor:{close():Promise<void>}|undefined,bargeVoiced=0;
  const change=(next:VoiceCallPhase)=>{phase=next;drivers.state(next);};
  const reset=()=>{chunks=[];samples=0;voiced=0;silence=0;pre=[];};
  const resetSpeech=()=>{queue=[];playing=false;answerDone=true;bargeVoiced=0;};
  const closeMonitor=()=>{const old=monitor;monitor=undefined;void old?.close();};
  const stop=()=>{generation++;request?.abort();request=undefined;realtimeAbort?.abort();realtimeAbort=undefined;const stream=realtime;realtime=undefined;void stream?.close();const old=mic;mic=undefined;void old?.close();resetSpeech();closeMonitor();reset();drivers.preview?.('');drivers.stopSpeech();drivers.cancelAnswer();change('idle');};
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
  function playNext(current:number) {
    if(current!==generation)return;
    const next=queue.shift();
    if(!next){playing=false;if(answerDone)finishSpeaking(current);return;}
    playing=true;
    drivers.speak(next,()=>{
      if(current!==generation){playing=false;return;}
      playing=false;playNext(current);
    },error=>{
      if(current!==generation)return;
      playing=false;fail(error);
    });
  }
  function finishSpeaking(current:number) {
    resetSpeech();closeMonitor();
    if(current===generation)void listen(current);
  }
  /** Keeps a second capture open during playback; sustained speech cuts the answer short. */
  async function startMonitor(current:number) {
    if(!drivers.openMonitor)return;
    try {
      const opened=await drivers.openMonitor((pcm,volume)=>{
        if(phase!=='speaking'||current!==generation)return;
        bargeVoiced=volume>=BARGE_IN_VOLUME?bargeVoiced+pcm.length:0;
        if(bargeVoiced>=16000*BARGE_IN_MS/1000)interruptCall();
      },()=>{bargeVoiced=0;});
      if(phase!=='speaking'||current!==generation){await opened.close();return;}
      monitor=opened;
    } catch { /* Barge-in is a convenience: a blocked monitor must not end the call. */ }
  }
  function interruptCall() {
    if(phase!=='speaking'&&phase!=='thinking')return;
    generation++;
    const current=generation;
    resetSpeech();closeMonitor();drivers.stopSpeech();drivers.cancelAnswer();void listen(current);
  }
  function beginAnswer() {
    if(phase!=='thinking')return;
    const current=generation;
    queue=[];playing=false;answerDone=false;bargeVoiced=0;change('speaking');void startMonitor(current);
  }
  function pushAnswer(text:string) {
    if(phase!=='speaking')return;
    const said=text.trim();if(!said)return;
    queue.push(said);
    if(!playing)playNext(generation);
  }
  function endAnswer() {
    if(phase!=='speaking')return;
    answerDone=true;
    if(!playing&&!queue.length)finishSpeaking(generation);
  }
  function push(pcm:Int16Array,volume:number) {
    if(phase!=='listening'||!pcm.length)return;
    realtime?.push(pcm);
    const voice=volume>=12;
    if(!samples&&!voice){pre.push(pcm);while(pre.reduce((n,p)=>n+p.length,0)>3200)pre.shift();return;}
    if(!samples){for(const part of pre){chunks.push(part);samples+=part.length;}pre=[];}
    chunks.push(pcm);samples+=pcm.length;
    if(voice){voiced+=pcm.length;silence=0;}else silence+=pcm.length;
    if(samples>=16000*30 || (silence>=16000*END_SILENCE_MS/1000 && voiced>=3200))void finish(generation);
    else if(silence>=16000*2 && voiced<3200)reset();
  }
  return {
    start(){if(phase!=='idle')return;const current=++generation;void listen(current);},
    stop,
    interrupt(){if(phase!=='speaking'&&phase!=='thinking')return;generation++;const current=generation;resetSpeech();closeMonitor();drivers.stopSpeech();drivers.cancelAnswer();void listen(current);},
    /** Starts playback so streamed sentences can be queued as they arrive. */
    beginAnswer,
    pushAnswer,
    endAnswer,
    answer(text:string){if(phase!=='thinking')return;if(!text.trim()){fail(t('未收到可播放的回答，请检查对话服务。'));return;}
      const current=generation;queue=[];playing=false;bargeVoiced=0;change('speaking');void startMonitor(current);
      queue.push(text.trim());answerDone=true;if(!playing)playNext(current);},
    answerFailed(error:unknown){if(phase==='thinking'||phase==='speaking')fail(error);},
    getPhase(){return phase;},
  };
}
