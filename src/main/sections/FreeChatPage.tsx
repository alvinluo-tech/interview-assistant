import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import {AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, unstable_useComposerInput, type ChatModelAdapter} from '@assistant-ui/react';
import {ArrowUp, AudioLines, LoaderCircle, Mic, Phone, PhoneOff, Plus, Square, Trash2, Volume2, VolumeX} from 'lucide-react';
import {readData, useData, writeData} from '@/lib/backend';
import {askFreeChat, saveFreeChat, type FreeChatMessage, type FreeChatSession} from '@/lib/freeChat';
import {openMicrophone, type MicrophoneCapture} from '@/lib/microphone';
import {encodeWav, transcribeAudio} from '@/lib/ai';
import {questionSpeaker} from '@/lib/questionSpeech';
import {Md} from '@/overlay/Md';
import {createVoiceCall, type VoiceCallPhase} from '@/lib/voiceCall';
import {useAiReady, useAiSettings} from '@/lib/aiSettings';
import {showToast} from '@/ui/primitives';
import './voice-call.css';

export function FreeChatPage() {
  const [sessions]=useData<FreeChatSession[]>('freeChats',[]);
  const [id,setId]=useState<string>(()=>crypto.randomUUID());
  const [revision,setRevision]=useState(0);
  const callEnded=useCallback(()=>setRevision(value=>value+1),[]);
  const current=sessions.find(session=>session.id===id);
  return <div className="-mx-7 -my-7 flex h-[calc(100vh-6rem)] min-h-[520px] bg-background">
    <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/20 p-3 md:flex">
      <button className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium hover:bg-muted" onClick={()=>setId(crypto.randomUUID())}><Plus size={15}/>新对话</button>
      <div className="px-2 pb-2 pt-5 text-[11px] font-medium text-muted-foreground">最近对话</div>
      <div className="space-y-1 overflow-y-auto">{sessions.map(session=><button key={session.id} onClick={()=>setId(session.id)} className={`w-full truncate rounded-md px-2 py-2 text-left text-xs ${id===session.id?'bg-primary/10 text-primary':'hover:bg-muted'}`}>{session.title}</button>)}</div>
    </aside>
    <ChatThread key={`${id}:${revision}`} id={id} initial={current?.messages || []} onCallEnd={callEnded} onDelete={async()=>{
      if(!window.confirm('删除这段对话？此操作无法撤销。'))return;
      await writeData('freeChats',readData<FreeChatSession[]>('freeChats',[]).filter(session=>session.id!==id));
      setId(crypto.randomUUID());
    }}/>
  </div>;
}

function ChatThread({id,initial,onDelete,onCallEnd}:{id:string;initial:FreeChatMessage[];onDelete:()=>Promise<void>;onCallEnd:()=>void}) {
  const [allowLocal,setAllowLocal]=useState(false),[speak,setSpeak]=useState(false),[speaking,setSpeaking]=useState(false),[tool,setTool]=useState(''),[error,setError]=useState('');
  const [toolsUsed,setToolsUsed]=useState<string[]>([]);
  const recordTool=useCallback((name:string)=>{const label=name==='app_guide'?'应用功能':name==='list_local_data'?'本地记录清单':name==='read_local_record'?'本地记录详情':name==='search_local_knowledge'?'本地资料搜索':'未知工具';setToolsUsed(items=>items.includes(label)?items:[...items,label]);setTool(`正在查询${label}…`);},[]);
  const [callPhase,setCallPhase]=useState<VoiceCallPhase>('idle');
  const [closingCall,setClosingCall]=useState(false);
  const [voiceMessages,setVoiceMessages]=useState<FreeChatMessage[]>([]),[voiceLevel,setVoiceLevel]=useState(0),[voicePreview,setVoicePreview]=useState('');
  const voiceHistory=useRef<FreeChatMessage[]>([]),voiceRequest=useRef<AbortController|null>(null),lastMeter=useRef(0),voiceStartIndex=useRef(0);
  const voiceSave=useRef<Promise<void>>(Promise.resolve());
  const refreshAfterVoice=useCallback(()=>{setClosingCall(true);void voiceSave.current.catch(()=>{}).finally(onCallEnd);},[onCallEnd]);
  const chatReady=useAiReady('chat'),sttReady=useAiReady('stt');
  const speechInputMode=useAiSettings().speechInputMode;
  const call=useRef<ReturnType<typeof createVoiceCall>|null>(null);
  const playback=useRef<{started:boolean;finished:()=>void;failed:(error:unknown)=>void}|null>(null);
  const config=useRef({allowLocal,speak}); config.current={allowLocal,speak};
  const speaker=useMemo(()=>questionSpeaker(value=>{setSpeaking(value);const current=playback.current;if(!current)return;if(value)current.started=true;else if(current.started){playback.current=null;current.finished();}},reason=>{const current=playback.current;playback.current=null;if(current)current.failed(reason);else setError(`语音播放失败：${String((reason as Error)?.message || reason)}`);}),[]);
  useEffect(()=>()=>speaker.dispose(),[speaker]);
  const adapter=useMemo<ChatModelAdapter>(()=>({async *run({messages,abortSignal}) {
    setError('');setTool('');setToolsUsed([]);speaker.stop();
    const history:FreeChatMessage[]=messages.filter(m=>m.role==='user'||m.role==='assistant').map(m=>({role:m.role as 'user'|'assistant',content:m.content.filter(part=>part.type==='text').map(part=>part.text).join('')})).filter(m=>m.content.trim());
    try { await saveFreeChat(id,history); } catch(e) { const message=`对话保存失败：${String((e as Error).message || e)}`;setError(message);call.current?.answerFailed(message);return; }
    let full='', complete=false, wake:(()=>void)|undefined;
    const work=askFreeChat(history,{signal:abortSignal,allowLocal:config.current.allowLocal,onDelta:delta=>{full+=delta;wake?.();},onTool:recordTool});
    let failure:unknown;
    void work.then(()=>{complete=true;wake?.();},e=>{failure=e;complete=true;wake?.();});
    let emitted='';
    while(!complete || emitted!==full){
      if(emitted!==full){emitted=full;yield {content:[{type:'text' as const,text:full}]};continue;}
      await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
    }
    setTool('');
    if(full)try { await saveFreeChat(id,[...history,{role:'assistant',content:full}]); } catch(e) {setError(`回答保存失败：${String((e as Error).message || e)}`);}
    if(failure){if(!abortSignal.aborted){const message=`对话失败：${String((failure as Error).message || failure)}`;setError(message);call.current?.answerFailed(message);}return;}
    if(config.current.speak&&full&&!abortSignal.aborted)void speaker.speak(full);
  }}),[id,speaker,recordTool]);
  const runtime=useLocalRuntime(adapter,{initialMessages:initial.map(message=>({role:message.role,content:[{type:'text' as const,text:message.content}]}))});
  const voiceCall=useMemo(()=>createVoiceCall({
    ...(speechInputMode==='realtime'?{openRealtime:async (onPreview:(text:string)=>void,onError:(message:string)=>void,signal:AbortSignal)=>{
      const {openConfiguredRealtimeAsr}=await import('@/lib/realtimeAsr');
      let finals:string[]=[];
      return openConfiguredRealtimeAsr({onResult:result=>{if(result.isFinal)finals.push(result.text);onPreview([...finals,...(!result.isFinal?[result.text]:[])].join(' '));},onError:error=>onError(error.message),onState:state=>{if(state==='reconnecting')onError('实时识别连接中断，请重新开始通话并重说刚才的话。');}},{signal,silenceMs:800});
    }}:{}),
    preview:setVoicePreview,
    open:(onPcm,onError)=>openMicrophone({onPcm:(pcm,volume)=>{onPcm(pcm,volume);if(performance.now()-lastMeter.current>100){lastMeter.current=performance.now();setVoiceLevel(Math.min(1,volume/45));}},onError}),
    transcribe:(pcm,signal)=>transcribeAudio(encodeWav(pcm),{signal}),
    send:async text=>{
      const controller=new AbortController();voiceRequest.current=controller;
      setToolsUsed([]);
      const history:FreeChatMessage[]=[...voiceHistory.current,{role:'user',content:text}];
      voiceHistory.current=history;setVoiceMessages(history.slice(voiceStartIndex.current));
      let answer='';
      try {
        voiceSave.current=saveFreeChat(id,history);await voiceSave.current;
        await askFreeChat(history,{signal:controller.signal,allowLocal:config.current.allowLocal,voice:true,
          onDelta:delta=>{if(controller.signal.aborted)return;answer+=delta;setVoiceMessages([...history.slice(voiceStartIndex.current),{role:'assistant',content:answer}]);},
          onTool:recordTool});
        if(controller.signal.aborted)return;
        const completed:FreeChatMessage[]=[...history,{role:'assistant',content:answer}];voiceHistory.current=completed;
        voiceSave.current=saveFreeChat(id,completed);await voiceSave.current;
        if(!controller.signal.aborted)call.current?.answer(answer);
      } catch(error) {if(!controller.signal.aborted)call.current?.answerFailed(error);}
      finally {if(voiceRequest.current===controller)voiceRequest.current=null;setTool('');}
    },
    speak:(text,finished,failed)=>{playback.current={started:false,finished,failed};void speaker.speak(text);},
    stopSpeech:()=>{playback.current=null;speaker.stop();},
    cancelAnswer:()=>{voiceRequest.current?.abort();voiceRequest.current=null;},
    state:setCallPhase,
    error:message=>{showToast({type:'error',title:'语音通话已停止',description:message});refreshAfterVoice();},
  }),[speaker,id,refreshAfterVoice,speechInputMode,recordTool]);
  call.current=voiceCall;
  useEffect(()=>()=>{if(voiceCall.getPhase()!=='idle')voiceCall.stop();},[voiceCall]);
  const endVoice=useCallback(()=>{voiceCall.stop();refreshAfterVoice();},[voiceCall,refreshAfterVoice]);
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b px-6 py-4"><div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><AudioLines size={18}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold">自由对话</div><div className="text-xs text-muted-foreground">文字、语音与本地资料</div></div>
      <button onClick={()=>{setSpeak(!speak);if(speak)speaker.stop();}} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted" aria-label={speak?'关闭语音回复':'开启语音回复'} title={speak?'关闭语音回复':'开启语音回复'}>{speak?<Volume2 size={16}/>:<VolumeX size={16}/>}</button>
      <CallButton disabled={callPhase!=='idle'||closingCall} onStart={()=>{if(!chatReady||!sttReady){setError('请先在「设置 → AI 服务」配置对话模型和语音转写模型。');return;}voiceHistory.current=runtime.thread.getState().messages.filter(message=>message.role==='user'||message.role==='assistant').map(message=>({role:message.role as 'user'|'assistant',content:message.content.filter(part=>part.type==='text').map(part=>part.text).join('')})).filter(message=>message.content.trim());voiceStartIndex.current=voiceHistory.current.length;setVoiceMessages([]);setVoicePreview('');setError('');voiceCall.start();}}/>
      <DeleteButton onDelete={onDelete} onError={setError}/>
      {speaking&&<button className="text-xs text-primary" onClick={()=>speaker.stop()}>停止播放</button>}
    </div>
    <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-2xl"><ThreadPrimitive.Empty><div className="flex min-h-64 flex-col justify-center"><p className="text-xs font-medium tracking-wide text-primary">MIANXU · 对话</p><h2 className="mt-3 text-2xl font-semibold">今天想聊点什么？</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">可以问我知识、梳理思路，也可以开启本地资料查询，了解自己的岗位和面试记录。</p></div></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>{({message})=><ChatMessage role={message.role}/>}</ThreadPrimitive.Messages>
        {tool&&<p className="py-2 text-xs text-muted-foreground">{tool}</p>}{!tool&&toolsUsed.length>0&&<p className="py-2 text-xs text-muted-foreground">本次已查询：{toolsUsed.join('、')}</p>}{error&&<p role="alert" className="py-2 text-xs text-destructive">{error}</p>}
      </div>
    </ThreadPrimitive.Viewport>
    <div className="mx-auto w-full max-w-2xl px-5 pb-5"><Composer allowLocal={allowLocal} setAllowLocal={setAllowLocal} setError={setError} speakerStop={speaker.stop}/></div>
    {callPhase!=='idle'&&createPortal(<VoiceCallDialog phase={callPhase} messages={voicePreview?[...voiceMessages,{role:'user',content:voicePreview}]:voiceMessages} level={voiceLevel} tool={tool} onStop={endVoice} onInterrupt={voiceCall.interrupt}/>,document.body)}
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}

function CallButton({disabled,onStart}:{disabled:boolean;onStart:()=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={disabled||running} onClick={onStart} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"><Phone size={14}/>语音通话</button>;
}

export function VoiceCallDialog({phase,messages,level,tool,onStop,onInterrupt}:{phase:VoiceCallPhase;messages:FreeChatMessage[];level:number;tool:string;onStop:()=>void;onInterrupt:()=>void}) {
  const transcript=useRef<HTMLDivElement>(null),endButton=useRef<HTMLButtonElement>(null);
  useEffect(()=>{endButton.current?.focus();const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')onStop();};window.addEventListener('keydown',onKey);return()=>window.removeEventListener('keydown',onKey);},[onStop]);
  useEffect(()=>{const element=transcript.current;if(element)element.scrollTop=element.scrollHeight;},[messages]);
  const status={connecting:'正在连接',listening:'正在聆听',transcribing:'正在识别',thinking:'正在思考',speaking:'正在回答',idle:''}[phase];
  const hint={connecting:'请允许麦克风访问',listening:'你可以直接说话，说完稍作停顿',transcribing:'正在将你的声音转换成文字',thinking:tool || '正在整理回答',speaking:'播放时麦克风暂停，避免回声',idle:''}[phase];
  return <div className="voice-backdrop" role="dialog" aria-modal="true" aria-label="语音通话">
    <div className="voice-dialog" data-phase={phase}>
      <header className="voice-header"><span className="voice-brand"><span className="voice-brand-mark"><AudioLines size={15}/></span>语音对话</span><span className="voice-live"><span/> {status}</span></header>
      <div className="voice-body">
        <div className="voice-visual" aria-hidden="true" style={{'--voice-level':phase==='listening'?level:0} as CSSProperties}>
          <div className="voice-orbit voice-orbit-outer"/><div className="voice-orbit voice-orbit-inner"/><div className="voice-glow"/><div className="voice-orb"><span/></div>
        </div>
        <div className="voice-state"><div role="status" aria-live="polite">{status}</div><p>{hint}</p></div>
        <div ref={transcript} className="voice-transcript" role="log" aria-label="通话内容" aria-live="polite">
          {messages.length===0?<div className="voice-empty">想聊什么，都可以直接说</div>:messages.map((message,index)=><div key={index} className={`voice-line voice-line-${message.role}`}><span>{message.role==='user'?'你':'助手'}</span><p>{message.content}</p></div>)}
          {phase==='thinking' && messages[messages.length-1]?.role==='user' && <div className="voice-line voice-line-assistant"><span>助手</span><p className="voice-wait">正在思考<span> · · ·</span></p></div>}
        </div>
      </div>
      <footer className="voice-footer"><p>语音会发送至你配置的识别服务</p><div className="voice-actions">{(phase==='speaking'||phase==='thinking')&&<button onClick={onInterrupt} className="voice-interrupt"><Mic size={16}/>打断并说话</button>}<button ref={endButton} onClick={onStop} className="voice-end"><PhoneOff size={17}/>结束通话</button></div></footer>
    </div>
  </div>;
}

function DeleteButton({onDelete,onError}:{onDelete:()=>Promise<void>;onError:(message:string)=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={running} onClick={()=>void onDelete().catch(e=>onError(`删除失败：${String((e as Error).message || e)}`))} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="删除当前对话" title="删除当前对话"><Trash2 size={16}/></button>;
}

function ChatMessage({role}:{role:string}) {
  const text=useAuiState(s=>s.message.content.filter(part=>part.type==='text').map(part=>part.text).join(''));
  return <MessagePrimitive.Root className={`mb-5 flex ${role==='user'?'justify-end':'justify-start'}`}><div className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 ${role==='user'?'bg-primary text-primary-foreground':'border bg-card text-foreground'}`}>
    {role==='assistant'?<Md text={text}/>:<div className="whitespace-pre-wrap break-words">{text}</div>}
  </div></MessagePrimitive.Root>;
}

function Composer({allowLocal,setAllowLocal,setError,speakerStop}:{allowLocal:boolean;setAllowLocal:(v:boolean)=>void;setError:(v:string)=>void;speakerStop:()=>void}) {
  const composer=unstable_useComposerInput();
  const running=useAuiState(state=>state.thread.isRunning);
  const [recording,setRecording]=useState(false),[busy,setBusy]=useState(false);
  const capture=useRef<MicrophoneCapture|null>(null),chunks=useRef<Int16Array[]>([]),count=useRef(0),alive=useRef(true),controller=useRef<AbortController|null>(null),opening=useRef(false);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();void capture.current?.close();capture.current=null;};},[]);
  const record=async()=>{
    if(opening.current||busy)return;
    if(capture.current){
      const mic=capture.current;capture.current=null;setRecording(false);setBusy(true);await mic.close();
      const total=count.current;if(total<8000){setError('录音太短，请至少说半秒。');setBusy(false);return;}
      const pcm=new Int16Array(total);let offset=0;for(const chunk of chunks.current){pcm.set(chunk,offset);offset+=chunk.length;}
      const request=new AbortController();controller.current=request;
      try{const text=await transcribeAudio(encodeWav(pcm),{signal:request.signal});if(alive.current&&!request.signal.aborted)composer.setText([composer.value,text].filter(Boolean).join(' '));}
      catch(e){if(alive.current&&!request.signal.aborted)setError(`语音识别失败：${String((e as Error).message || e)}`);}
      finally{if(controller.current===request)controller.current=null;if(alive.current)setBusy(false);}return;
    }
    opening.current=true;setBusy(true);setError('');speakerStop();chunks.current=[];count.current=0;
    try{const mic=await openMicrophone({onPcm:pcm=>{if(count.current+pcm.length<=16000*60){chunks.current.push(pcm);count.current+=pcm.length;}else if(alive.current)setError('已录满 60 秒，请结束录音。');},onError:message=>{if(alive.current){setError(message);setRecording(false);}void capture.current?.close();capture.current=null;}});
      if(!alive.current){await mic.close();return;}capture.current=mic;setRecording(true);
    }catch(e){if(alive.current)setError(`无法录音：${String((e as Error).message || e)}`);}finally{opening.current=false;if(alive.current)setBusy(false);}
  };
  return <ComposerPrimitive.Root className="rounded-2xl border bg-card p-3 shadow-sm">
    <ComposerPrimitive.Input rows={2} placeholder="输入消息，Enter 发送，Shift + Enter 换行" className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground" />
    <div className="mt-2 flex items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={allowLocal} disabled={running} onChange={event=>setAllowLocal(event.target.checked)}/>允许查询本地资料</label>
      <button type="button" onClick={()=>void record()} disabled={busy} className={`rounded-lg p-2 ${recording?'bg-red-100 text-red-600':'text-muted-foreground hover:bg-muted'}`} aria-label={recording?'结束录音':'语音输入'} title={recording?'结束录音':'语音输入'}>{busy?<LoaderCircle size={17} className="animate-spin"/>:recording?<Square size={17}/>:<Mic size={17}/>}</button>
      <ComposerPrimitive.Cancel className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="停止生成"><Square size={16}/></ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-40" aria-label="发送"><ArrowUp size={17}/></ComposerPrimitive.Send>
    </div><p className="mt-2 text-[11px] text-muted-foreground">开启本地资料查询后，模型可读取简历、岗位及面试、笔试记录的内容，并发送给所选服务商。录音结束后可先编辑文字。</p>
  </ComposerPrimitive.Root>;
}
