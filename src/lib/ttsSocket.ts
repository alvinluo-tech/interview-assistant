import type {AiProvider} from './aiConfig';
import type {SpeechRenderSpec} from './speechProfile';
import type {SpeechConsumer} from './ttsProtocol';
import {t} from './i18n';
import {requestScope} from './aiProtocol.js';
import {bailianRegion,type RealtimeConnect,type RealtimeSocket} from './realtimeAsrProtocol.js';
/** CosyVoice Singapore uses the documented WS API, with the configured workspace host and key. */
export async function requestBailianSpeechSocket(provider:AiProvider,model:string,text:string,voice:string,render:SpeechRenderSpec|undefined,instruction:string|undefined,signal:AbortSignal|undefined,push:SpeechConsumer,timeoutMs:number,connect:RealtimeConnect){
  const host=new URL(provider.baseUrl).hostname;if(!bailianRegion(host))throw new Error(t('语音 WebSocket 地址不是已配置的百炼地域。'));
  const transport=connect;
  const scope=requestScope(timeoutMs,signal);
  let socket:RealtimeSocket|undefined;
  const taskId=crypto.randomUUID();let off=()=>{},received=0,started=false,finished=false,failed=false;
  let queue=Promise.resolve();let queuedFrames=0,queuedBytes=0;let resolve!:()=>void,reject!:(error:unknown)=>void;
  const done=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void done.catch(()=>{});
  let rejectAbort!:(reason:unknown)=>void;const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
  const abort=()=>{const reason=scope.signal.reason || new DOMException(t('已停止朗读'),'AbortError');reject(reason);rejectAbort(reason);void socket?.disconnect();};
  scope.signal.addEventListener('abort',abort,{once:true});
  try{
    scope.signal.throwIfAborted();
    const connecting=transport(`wss://${host}/api-ws/v1/inference`,{headers:{Authorization:`Bearer ${provider.apiKey}`},maxMessageSize:2*1024*1024,maxFrameSize:2*1024*1024});
    void connecting.then(value=>{if(scope.signal.aborted)void value.disconnect();},()=>{});
    socket=await Promise.race([connecting,done.then(()=>{throw new Error(t('语音连接中断'));})]);scope.signal.throwIfAborted();
    const connection=socket;
    off=socket.addListener(message=>{
      if(finished)return;
      if(message.type==='Binary'&&Array.isArray(message.data)){
        const bytes=Uint8Array.from(message.data as number[]);received+=bytes.length;
        if (received > 32*1024*1024) {
          failed = true; finished = true;
          reject(new Error(t('语音音频过长')));
          return;
        }
        queuedFrames++; queuedBytes += bytes.length;
        if (queuedFrames > 256 || queuedBytes > 8*1024*1024) {
          failed = true; finished = true;
          reject(new Error(t('语音播放积压过多，已停止本次朗读，请缩短问题后重试。')));
          return;
        }
        queue = queue.then(async () => {
          try {
            if (failed) return;
            scope.signal.throwIfAborted();
            await push({format:'pcm16', sampleRate:24000, bytes});
          } finally {
            queuedFrames--; queuedBytes -= bytes.length;
          }
        });
        void queue.catch(reject);
        return;
      }
      if(message.type==='Close'){reject(new Error(t('语音连接在播放完成前断开。')));return;}
      if(message.type!=='Text'||typeof message.data!=='string')return;
      try{const event=JSON.parse(message.data);if(event.header?.task_id!==taskId)return;
        if(event.header.event==='task-started'&&!started){started=true;void (async()=>{await connection.send(JSON.stringify({header:{action:'continue-task',task_id:taskId,streaming:'duplex'},payload:{input:{text}}}));await connection.send(JSON.stringify({header:{action:'finish-task',task_id:taskId,streaming:'duplex'},payload:{input:{}}}));})().catch(reject);}
        if(event.header.event==='task-failed')reject(new Error(String(event.header.error_message || t('语音合成失败')).split(provider.apiKey).join(t('[密钥已隐藏]'))));
        if(event.header.event==='task-finished'){finished=true;resolve();}
      }catch(error){reject(error);}
    });
    await Promise.race([socket.send(JSON.stringify({header:{action:'run-task',task_id:taskId,streaming:'duplex'},payload:{task_group:'audio',task:'tts',function:'SpeechSynthesizer',model,
      parameters:{text_type:'PlainText',voice,format:'pcm',sample_rate:24000,...(render?{rate:render.rate,language_hints:[render.language==='en-US'?'en':'zh']}:{}),...(instruction?{instruction}:{})},input:{}}})),aborted]);
    await done;await Promise.race([queue,aborted]);scope.signal.throwIfAborted();if(!received)throw new Error(t('语音接口未返回音频。'));
  }catch(error){failed=true;throw error;}finally{finished=true;off();scope.signal.removeEventListener('abort',abort);scope.cleanup();await socket?.disconnect().catch(()=>{});}
}
