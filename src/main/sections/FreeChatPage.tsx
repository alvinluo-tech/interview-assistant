import {useCallback, useEffect, useMemo, useRef, useState, type CSSProperties,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, unstable_useComposerInput, type ChatModelAdapter, type ThreadMessage} from '@assistant-ui/react';
import {ArrowUp, AudioLines, LoaderCircle, Mic, Phone, PhoneOff, Plus, Square, Trash2, Volume2, VolumeX} from 'lucide-react';
import {readData, useData, writeData} from '@/lib/backend';
import {askFreeChat, saveFreeChat, displayFreeChatText, readFreeChatQueries, LOCAL_DATA_CATEGORIES, LOCAL_DATA_LABELS, type LocalDataCategory, type FreeChatQuery, type FreeChatMessage, type FreeChatSession} from '@/lib/freeChat';
import {openMicrophone, type MicrophoneCapture} from '@/lib/microphone';
import {encodeWav, transcribeAudio} from '@/lib/ai';
import {questionSpeaker} from '@/lib/questionSpeech';
import {Md} from '@/overlay/Md';
import {createVoiceCall, type VoiceCallPhase} from '@/lib/voiceCall';
import {useAiReady, useAiSettings} from '@/lib/aiSettings';
import {showToast} from '@/ui/primitives';
import './voice-call.css';
import {useModalFocus} from '@/ui/useModalFocus';

type LocalPermission = {allowLocal:boolean;categories:LocalDataCategory[]};
function savedMessages(messages:readonly ThreadMessage[]):FreeChatMessage[] {
  return messages.flatMap(message=>{
    if(message.role!=='user'&&message.role!=='assistant')return [];
    const content=message.content.filter(part=>part.type==='text').map(part=>part.text).join('');
    const incomplete=message.role==='assistant'&&message.status.type==='incomplete';
    if(!content.trim()&&!(incomplete&&message.status.reason==='error'))return [];
    return [{role:message.role,content,...(message.role==='assistant'?{queries:readFreeChatQueries(message.metadata.custom.localQueries)}:{}),...(incomplete?{status:content?'partial' as const:'failed' as const,error:message.status.reason==='error'?String(message.status.error || '回答失败'):undefined}:{})}];
  });
}
export function FreeChatPage() {
  const [sessions]=useData<FreeChatSession[]>('freeChats',[]);
  const [id,setId]=useState<string>(()=>crypto.randomUUID());
  const [revision,setRevision]=useState(0);
  const [permission,setPermission]=useState<LocalPermission>({allowLocal:false,categories:[...LOCAL_DATA_CATEGORIES]});
  const openSession=(next:string)=>{setPermission({allowLocal:false,categories:[...LOCAL_DATA_CATEGORIES]});setId(next);};
  const callEnded=useCallback(()=>setRevision(value=>value+1),[]);
  const current=sessions.find(session=>session.id===id);
  return <div className="-mx-7 -my-7 flex h-[calc(100vh-6rem)] min-h-[520px] bg-background">
    <aside className="hidden w-48 shrink-0 flex-col border-r bg-muted/20 p-3 md:flex">
      <button className="flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium hover:bg-muted" onClick={()=>openSession(crypto.randomUUID())}><Plus size={15}/>新对话</button>
      <div className="px-2 pb-2 pt-5 text-[11px] font-medium text-muted-foreground">最近对话</div>
      <div className="space-y-1 overflow-y-auto">{sessions.map(session=><button key={session.id} onClick={()=>{if(id!==session.id)openSession(session.id);}} className={`w-full truncate rounded-md px-2 py-2 text-left text-xs ${id===session.id?'bg-primary/10 text-primary':'hover:bg-muted'}`}>{session.title}</button>)}</div>
    </aside>
    <ChatThread key={`${id}:${revision}`} id={id} initial={current?.messages || []} permission={permission} onPermissionChange={setPermission} onCallEnd={callEnded} onDelete={async()=>{
      if(!window.confirm('删除这段对话？此操作无法撤销。'))return;
      await writeData('freeChats',readData<FreeChatSession[]>('freeChats',[]).filter(session=>session.id!==id));
      openSession(crypto.randomUUID());
    }}/>
  </div>;
}

function ChatThread({id,initial,permission,onPermissionChange,onDelete,onCallEnd}:{id:string;initial:FreeChatMessage[];permission:LocalPermission;onPermissionChange:(permission:LocalPermission)=>void;onDelete:()=>Promise<void>;onCallEnd:()=>void}) {
  const {allowLocal,categories}=permission;
  const [speak,setSpeak]=useState(false),[speaking,setSpeaking]=useState(false),[tool,setTool]=useState(''),[error,setError]=useState('');
  const [toolsUsed,setToolsUsed]=useState<string[]>([]);
  const recordTool=useCallback((name:string)=>{const label=name==='app_guide'?'应用功能':name==='list_local_data'?'本地记录清单':name==='read_local_record'?'本地记录详情':name==='search_local_knowledge'?'本地资料搜索':'未知工具';setToolsUsed(items=>items.includes(label)?items:[...items,label]);setTool(`正在查询${label}…`);},[]);
  const [callPhase,setCallPhase]=useState<VoiceCallPhase>('idle');
  const [closingCall,setClosingCall]=useState(false);
  const inputOwner=useRef<'call'|'manual'|null>(null);
  const [manualBusy,setManualBusy]=useState(false);
  const [voiceMessages,setVoiceMessages]=useState<FreeChatMessage[]>([]),[voiceLevel,setVoiceLevel]=useState(0),[voicePreview,setVoicePreview]=useState('');
  const voiceHistory=useRef<FreeChatMessage[]>([]),voiceRequest=useRef<AbortController|null>(null),lastMeter=useRef(0),voiceStartIndex=useRef(0);
  const voiceSave=useRef<Promise<void>>(Promise.resolve());
  const refreshAfterVoice=useCallback(()=>{setClosingCall(true);void voiceSave.current.catch(()=>{}).finally(onCallEnd);},[onCallEnd]);
  const chatReady=useAiReady('chat'),sttReady=useAiReady('stt');
  const aiSettings=useAiSettings(),speechInputMode=aiSettings.speechInputMode;
  const provider=aiSettings.providers.find(item=>item.id===aiSettings.routes.chat?.providerId);
  const call=useRef<ReturnType<typeof createVoiceCall>|null>(null);
  const playback=useRef<{started:boolean;finished:()=>void;failed:(error:unknown)=>void}|null>(null);
  const config=useRef({allowLocal,categories,speak}); config.current={allowLocal,categories,speak};
  const permissionEpoch=useRef(0),textRequest=useRef<AbortController|null>(null);
  const speaker=useMemo(()=>questionSpeaker(value=>{setSpeaking(value);const current=playback.current;if(!current)return;if(value)current.started=true;else if(current.started){playback.current=null;current.finished();}},reason=>{const current=playback.current;playback.current=null;if(current)current.failed(reason);else setError(`语音播放失败：${String((reason as Error)?.message || reason)}`);}),[]);
  useEffect(()=>()=>speaker.dispose(),[speaker]);
  useEffect(()=>()=>{textRequest.current?.abort();voiceRequest.current?.abort();},[]);
  const adapter=useMemo<ChatModelAdapter>(()=>({async *run({messages,abortSignal}) {
    setError('');setTool('');setToolsUsed([]);speaker.stop();
    const controller=new AbortController(),epoch=permissionEpoch.current,grant=config.current;
    const cancel=()=>controller.abort(abortSignal.reason);abortSignal.addEventListener('abort',cancel,{once:true});if(abortSignal.aborted)cancel();textRequest.current=controller;
    const history=savedMessages(messages);
    try {
      try {
        await saveFreeChat(id,history);
      } catch(e) {
        const message=`对话保存失败：${String((e as Error).message || e)}`;
        yield {status:{type:'incomplete',reason:'error',error:message}};
        return;
      }
      if(controller.signal.aborted)return;
      let full='', complete=false, wake:(()=>void)|undefined;
      const queries:FreeChatQuery[]=[];
      const work=askFreeChat(history,{
        signal:controller.signal,allowLocal:grant.allowLocal,categories:grant.categories,
        canQueryLocal:()=>permissionEpoch.current===epoch&&config.current.allowLocal,
        onDelta:delta=>{if(!controller.signal.aborted){full+=delta;wake?.();}},
        onTool:recordTool,onToolResult:query=>queries.push(query),
      });
      let failure:unknown;
      void work.then(()=>{complete=true;wake?.();},e=>{failure=e;complete=true;wake?.();});
      let emitted='';
      while(!complete || emitted!==full){
        if(emitted!==full){emitted=full;yield {content:[{type:'text' as const,text:full}]};continue;}
        await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
      }
      setTool('');
      const message=failure?`对话失败：${String((failure as Error).message || failure)}`:undefined;
      if(full || (failure&&!controller.signal.aborted)){
        try {
          await saveFreeChat(id,[...history,{role:'assistant',content:full,queries,...(message?{status:full?'partial' as const:'failed' as const,error:message}:{})}]);
        } catch(e) {setError(`回答保存失败：${String((e as Error).message || e)}`);}
      }
      if(controller.signal.aborted){yield {metadata:{custom:{localQueries:queries}},status:{type:'incomplete',reason:'cancelled'}};return;}
      if(failure){yield {metadata:{custom:{localQueries:queries}},status:{type:'incomplete',reason:'error',error:message}};return;}
      yield {metadata:{custom:{localQueries:queries}}};
      if(config.current.speak&&full&&!inputOwner.current)void speaker.speak(full);
    } finally {
      abortSignal.removeEventListener('abort',cancel);
      if(textRequest.current===controller)textRequest.current=null;
      controller.abort();
    }
  }}),[id,speaker,recordTool]);
  const runtime=useLocalRuntime(adapter,{initialMessages:initial.map(message=>({role:message.role,content:[{type:'text' as const,text:message.content}],metadata:{custom:{localQueries:readFreeChatQueries(message.queries)}},...(message.role==='assistant'&&message.status?{status:{type:'incomplete' as const,reason:'error' as const,error:message.error || '上次回答未完成，请重试。'}}:{})}))});
  const changePermission=(next:LocalPermission)=>{permissionEpoch.current++;config.current={...config.current,...next};textRequest.current?.abort();runtime.thread.cancelRun();voiceRequest.current?.abort();speaker.stop();setTool('');onPermissionChange(next);};
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
      const epoch=permissionEpoch.current,grant=config.current,queries:FreeChatQuery[]=[];
      setToolsUsed([]);
      const history:FreeChatMessage[]=[...voiceHistory.current,{role:'user',content:text}];
      voiceHistory.current=history;setVoiceMessages(history.slice(voiceStartIndex.current));
      let answer='';
      try {
        voiceSave.current=saveFreeChat(id,history);await voiceSave.current;
        await askFreeChat(history,{signal:controller.signal,allowLocal:grant.allowLocal,categories:grant.categories,canQueryLocal:()=>permissionEpoch.current===epoch&&config.current.allowLocal,voice:true,
          onDelta:delta=>{if(controller.signal.aborted)return;answer+=delta;setVoiceMessages([...history.slice(voiceStartIndex.current),{role:'assistant',content:answer}]);},
          onTool:recordTool,onToolResult:query=>queries.push(query)});
        if(controller.signal.aborted)return;
        const completed:FreeChatMessage[]=[...history,{role:'assistant',content:answer,queries}];voiceHistory.current=completed;
        voiceSave.current=saveFreeChat(id,completed);await voiceSave.current;
        if(!controller.signal.aborted)call.current?.answer(answer);
      } catch(error) {
        if(!controller.signal.aborted){
          const failed:FreeChatMessage[]=[...history,{role:'assistant',content:answer,queries,status:answer?'partial':'failed',error:`语音对话失败：${String((error as Error).message || error)}`}];
          voiceHistory.current=failed;
          voiceSave.current=saveFreeChat(id,failed);await voiceSave.current.catch(()=>{});
          if(!controller.signal.aborted)call.current?.answerFailed(error);
        }
      }
      finally {if(voiceRequest.current===controller)voiceRequest.current=null;setTool('');}
    },
    speak:(text,finished,failed)=>{playback.current={started:false,finished,failed};void speaker.speak(text);},
    stopSpeech:()=>{playback.current=null;speaker.stop();},
    cancelAnswer:()=>{voiceRequest.current?.abort();voiceRequest.current=null;},
    state:phase=>{if(phase==='idle'&&inputOwner.current==='call')inputOwner.current=null;setCallPhase(phase);},
    error:message=>{showToast({type:'error',title:'语音通话已停止',description:message});refreshAfterVoice();},
  }),[speaker,id,refreshAfterVoice,speechInputMode,recordTool]);
  call.current=voiceCall;
  useEffect(()=>()=>{if(voiceCall.getPhase()!=='idle')voiceCall.stop();},[voiceCall]);
  const endVoice=useCallback(()=>{voiceCall.stop();refreshAfterVoice();},[voiceCall,refreshAfterVoice]);
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root inert={callPhase!=='idle'||closingCall} className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b px-6 py-4"><div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><AudioLines size={18}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold">自由对话</div><div className="text-xs text-muted-foreground">文字、语音与本地资料</div></div>
      <button onClick={()=>{setSpeak(!speak);if(speak)speaker.stop();}} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted" aria-label={speak?'关闭语音回复':'开启语音回复'} title={speak?'关闭语音回复':'开启语音回复'}>{speak?<Volume2 size={16}/>:<VolumeX size={16}/>}</button>
      <CallButton disabled={callPhase!=='idle'||closingCall||manualBusy} onStart={()=>{if(inputOwner.current)return;if(!chatReady||!sttReady){setError('请先在「设置 → AI 服务」配置对话模型和语音转写模型。');return;}inputOwner.current='call';voiceHistory.current=savedMessages(runtime.thread.getState().messages);voiceStartIndex.current=voiceHistory.current.length;setVoiceMessages([]);setVoicePreview('');setError('');voiceCall.start();}}/>
      <DeleteButton onDelete={onDelete} onError={setError}/>
      {speaking&&<button className="text-xs text-primary" onClick={()=>speaker.stop()}>停止播放</button>}
    </div>
    <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-2xl"><ThreadPrimitive.Empty><div className="flex min-h-64 flex-col justify-center"><p className="text-xs font-medium tracking-wide text-primary">MIANXU · 对话</p><h2 className="mt-3 text-2xl font-semibold">今天想聊点什么？</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">可以问我知识、梳理思路，也可以开启本地资料查询，了解自己的岗位和面试记录。</p></div></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>{({message})=><ChatMessage role={message.role}/>}</ThreadPrimitive.Messages>
        {tool&&<p className="py-2 text-xs text-muted-foreground">{tool}</p>}{!tool&&toolsUsed.length>0&&<p className="py-2 text-xs text-muted-foreground">本轮请求的工具：{toolsUsed.join('、')}</p>}{error&&<p role="alert" className="py-2 text-xs text-destructive">{error}</p>}
      </div>
    </ThreadPrimitive.Viewport>
    <div className="mx-auto w-full max-w-2xl px-5 pb-5"><Composer permission={permission} onPermissionChange={changePermission} destination={provider?`${provider.name} · ${aiSettings.routes.chat?.modelId}`:'未配置对话服务'} setError={setError} speakerStop={speaker.stop} inputOwner={inputOwner} blocked={callPhase!=='idle'||closingCall} onInputBusy={setManualBusy}/></div>
    {callPhase!=='idle'&&createPortal(<VoiceCallDialog phase={callPhase} messages={voicePreview?[...voiceMessages,{role:'user',content:voicePreview}]:voiceMessages} level={voiceLevel} tool={tool} onStop={endVoice} onInterrupt={voiceCall.interrupt} localAccess={allowLocal?categories.map(category=>LOCAL_DATA_LABELS[category]).join('、'):undefined} onRevokeLocal={()=>{changePermission({...permission,allowLocal:false});endVoice();}}/>,document.body)}
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}

function CallButton({disabled,onStart}:{disabled:boolean;onStart:()=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={disabled||running} onClick={onStart} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"><Phone size={14}/>语音通话</button>;
}

export function VoiceCallDialog({phase,messages,level,tool,onStop,onInterrupt,localAccess,onRevokeLocal}:{phase:VoiceCallPhase;messages:FreeChatMessage[];level:number;tool:string;onStop:()=>void;onInterrupt:()=>void;localAccess?:string;onRevokeLocal?:()=>void}) {
  const transcript=useRef<HTMLDivElement>(null),endButton=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDivElement>(null);
  useModalFocus(dialog,true,onStop,endButton);
  useEffect(()=>{const element=transcript.current;if(element)element.scrollTop=element.scrollHeight;},[messages]);
  const status={connecting:'正在连接',listening:'正在聆听',transcribing:'正在识别',thinking:'正在思考',speaking:'正在回答',idle:''}[phase];
  const hint={connecting:'请允许麦克风访问',listening:'你可以直接说话，说完稍作停顿',transcribing:'正在将你的声音转换成文字',thinking:tool || '正在整理回答',speaking:'播放时麦克风暂停，避免回声',idle:''}[phase];
  return <div ref={dialog} tabIndex={-1} className="voice-backdrop" role="dialog" aria-modal="true" aria-label="语音通话">
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
      <footer className="voice-footer"><p>语音会发送至你配置的识别服务{localAccess&&<><br/>已允许查询：{localAccess} <button onClick={onRevokeLocal} className="underline">关闭资料查询并结束通话</button></>}</p><div className="voice-actions">{(phase==='speaking'||phase==='thinking')&&<button onClick={onInterrupt} className="voice-interrupt"><Mic size={16}/>打断并说话</button>}<button ref={endButton} onClick={onStop} className="voice-end"><PhoneOff size={17}/>结束通话</button></div></footer>
    </div>
  </div>;
}

function DeleteButton({onDelete,onError}:{onDelete:()=>Promise<void>;onError:(message:string)=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={running} onClick={()=>void onDelete().catch(e=>onError(`删除失败：${String((e as Error).message || e)}`))} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label="删除当前对话" title="删除当前对话"><Trash2 size={16}/></button>;
}

function ChatMessage({role}:{role:string}) {
  const text=useAuiState(s=>s.message.content.filter(part=>part.type==='text').map(part=>part.text).join(''));
  const status=useAuiState(s=>s.message.status),rawQueries=useAuiState(s=>s.message.metadata.custom.localQueries);
  const queries=readFreeChatQueries(rawQueries);
  const failed=role==='assistant'&&status?.type==='incomplete'&&status.reason==='error';
  const waiting=role==='assistant'&&status?.type==='running'&&!text;
  return <MessagePrimitive.Root className={`mb-5 flex ${role==='user'?'justify-end':'justify-start'}`}><div className={`max-w-[92%] rounded-2xl px-4 py-3 text-sm leading-6 ${role==='user'?'bg-primary text-primary-foreground':'border bg-card text-foreground'}`}>
    {role==='assistant'?<>{text&&<Md text={displayFreeChatText(text)}/>}{waiting&&<span role="status" className="text-muted-foreground">正在思考或查询资料…</span>}{failed&&<div role="alert" className="text-destructive">{String(status.error || '回答失败，请重试。')}</div>}{status?.type==='incomplete'&&status.reason==='cancelled'&&<p className="text-xs text-muted-foreground">已停止回答</p>}{queries&&queries.length>0&&<details className="mt-3 border-t pt-2 text-xs text-muted-foreground"><summary className="cursor-pointer">本次查询记录（{queries.length}）</summary><ul className="mt-2 space-y-1">{queries.map((query,index)=><li key={index}>{query.category&&LOCAL_DATA_LABELS[query.category as LocalDataCategory] || (query.name==='app_guide'?'应用功能':'资料搜索')}{query.title?` · ${query.title}`:''}{query.count!==undefined?` · ${query.count} 条`:''} · {query.status==='error'?'查询失败':query.status==='cached'?'复用本轮结果':'已查询'}{query.recordId&&<span className="block break-all opacity-70">记录编号：{query.recordId}</span>}</li>)}</ul></details>}{status?.type!=='running'&&<ActionBarPrimitive.Reload className="mt-2 text-xs text-primary hover:underline disabled:opacity-40">重试回答</ActionBarPrimitive.Reload>}</>:<div className="whitespace-pre-wrap break-words">{text}</div>}
  </div></MessagePrimitive.Root>;
}

function Composer({permission,onPermissionChange,destination,setError,speakerStop,inputOwner,blocked,onInputBusy}:{permission:LocalPermission;onPermissionChange:(permission:LocalPermission)=>void;destination:string;setError:(v:string)=>void;speakerStop:()=>void;inputOwner:RefObject<'call'|'manual'|null>;blocked:boolean;onInputBusy:(busy:boolean)=>void}) {
  const {allowLocal,categories}=permission;
  const composer=unstable_useComposerInput();
  const currentComposer=useRef(composer);currentComposer.current=composer;
  const running=useAuiState(state=>state.thread.isRunning);
  const [recording,setRecording]=useState(false),[busy,setBusy]=useState(false);
  const capture=useRef<MicrophoneCapture|null>(null),chunks=useRef<Int16Array[]>([]),count=useRef(0),alive=useRef(true),controller=useRef<AbortController|null>(null),opening=useRef(false);
  const release=()=>{if(inputOwner.current==='manual')inputOwner.current=null;if(alive.current)onInputBusy(false);};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;controller.current?.abort();void capture.current?.close().catch(()=>{});capture.current=null;release();};},[]);
  const record=async()=>{
    if(opening.current||busy||blocked||running||inputOwner.current==='call')return;
    if(capture.current){
      const mic=capture.current;capture.current=null;setRecording(false);setBusy(true);
      const request=new AbortController();controller.current=request;
      try{
      await mic.close();
      const total=count.current;if(total<8000){setError('录音太短，请至少说半秒。');return;}
      const pcm=new Int16Array(total);let offset=0;for(const chunk of chunks.current){pcm.set(chunk,offset);offset+=chunk.length;}
      const text=await transcribeAudio(encodeWav(pcm),{signal:request.signal});if(alive.current&&!request.signal.aborted)currentComposer.current.setText([currentComposer.current.value,text].filter(Boolean).join(' '));}
      catch(e){if(alive.current&&!request.signal.aborted)setError(`语音识别失败：${String((e as Error).message || e)}`);}
      finally{if(controller.current===request)controller.current=null;chunks.current=[];count.current=0;release();if(alive.current)setBusy(false);}return;
    }
    if(inputOwner.current)return;inputOwner.current='manual';onInputBusy(true);
    opening.current=true;setBusy(true);setError('');speakerStop();chunks.current=[];count.current=0;
    try{const mic=await openMicrophone({onPcm:pcm=>{if(count.current+pcm.length<=16000*60){chunks.current.push(pcm);count.current+=pcm.length;}else if(alive.current)setError('已录满 60 秒，请结束录音。');},onError:message=>{if(alive.current){setError(message);setRecording(false);}void capture.current?.close().catch(()=>{});capture.current=null;release();}});
      if(!alive.current){await mic.close();return;}capture.current=mic;setRecording(true);
    }catch(e){release();if(alive.current)setError(`无法录音：${String((e as Error).message || e)}`);}finally{opening.current=false;if(alive.current)setBusy(false);}
  };
  return <ComposerPrimitive.Root onKeyDownCapture={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&(busy||recording||blocked)){event.preventDefault();event.stopPropagation();}}} className="rounded-2xl border bg-card p-3 shadow-sm">
    <ComposerPrimitive.Input rows={2} placeholder="输入消息，Enter 发送，Shift + Enter 换行" className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground" />
    <div className="mt-2 flex items-center gap-2"><label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground"><input type="checkbox" checked={allowLocal} disabled={blocked||categories.length===0} onChange={event=>onPermissionChange({...permission,allowLocal:event.target.checked})}/>允许查询本地资料</label>
      <button type="button" onClick={()=>void record()} disabled={busy||blocked||running} className={`rounded-lg p-2 ${recording?'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400':'text-muted-foreground hover:bg-muted'}`} aria-label={recording?'结束录音':'语音输入'} title={recording?'结束录音':'语音输入'}>{busy?<LoaderCircle size={17} className="animate-spin"/>:recording?<Square size={17}/>:<Mic size={17}/>}</button>
      <ComposerPrimitive.Cancel className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="停止生成"><Square size={16}/></ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send disabled={busy||recording||blocked} className="rounded-lg bg-primary p-2 text-primary-foreground disabled:opacity-40" aria-label="发送"><ArrowUp size={17}/></ComposerPrimitive.Send>
    </div><p className="mt-2 text-[11px] leading-5 text-muted-foreground">{allowLocal?'本对话可按需查询已勾选的资料；关闭开关会停止当前查询。':'本轮不查询本地资料；已有对话内容仍会作为聊天上下文发送。'}录音结束后可先编辑文字。</p>
    <details className="mt-1 text-[11px] leading-5 text-muted-foreground"><summary className="cursor-pointer">查询范围与数据说明</summary><div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{LOCAL_DATA_CATEGORIES.map(category=><label key={category} className="flex items-center gap-1"><input type="checkbox" checked={categories.includes(category)} disabled={blocked} onChange={event=>{const selected=event.target.checked?[...categories,category]:categories.filter(item=>item!==category);onPermissionChange({allowLocal:allowLocal&&selected.length>0,categories:selected});}}/>{LOCAL_DATA_LABELS[category]}</label>)}</div><p className="mt-2">读取到的文字片段将发送至：{destination}。只允许读取，不修改或删除资料，也不读取截图文件、系统文件或密钥设置。已有对话及回答保存在本机；已发送给服务商的内容无法通过关闭开关撤回。切换对话或离开此页面后需重新授权。</p></details>
  </ComposerPrimitive.Root>;
}
