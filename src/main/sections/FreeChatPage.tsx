import {createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {ActionBarPrimitive, AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useLocalRuntime, unstable_useComposerInput, type ChatModelAdapter, type ThreadMessage} from '@assistant-ui/react';
import {ArrowDown, ArrowUp, AudioLines, Brain, Check, ChevronDown, FileText, Image as ImageIcon, LoaderCircle, Mic, Paperclip, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Phone, PhoneOff, Plus, Search, ShieldQuestion, Square, Trash2, Volume2, VolumeX, Wrench, X} from 'lucide-react';
import {useData} from '@/lib/backend';
import {askFreeChat, saveFreeChat, setFreeChatModel, renameFreeChat, deleteFreeChat, displayFreeChatText, readFreeChatQueries, LOCAL_DATA_CATEGORIES, LOCAL_DATA_LABELS, type LocalDataCategory, type FreeChatQuery, type FreeChatMessage, type FreeChatSession, type FreeChatApproval, type FreeChatApprovalRequest, type FreeChatStep} from '@/lib/freeChat';
import {ModelPicker, describeRoute} from './ModelPicker';
import type {AiRoute, AiSettings} from '@/lib/aiConfig';
import {openMicrophone, type MicrophoneCapture} from '@/lib/microphone';
import {encodeWav, transcribeAudio} from '@/lib/ai';
import {questionSpeaker} from '@/lib/questionSpeech';
import {Md} from '@/overlay/Md';
import {createVoiceCall, type VoiceCallPhase} from '@/lib/voiceCall';
import {useAiReady, useAiSettings} from '@/lib/aiSettings';
import {showToast, useClickOutside} from '@/ui/primitives';
import { t } from '@/lib/i18n';
import {CHAT_ATTACH_ACCEPT, CHAT_ATTACH_MAX, IMAGE_MARKER, chatFileKind, composeAttachmentContent, conversationFiles, formatFileSize, readChatAttachment, splitAttachments, stripAttachmentBlocks, type ChatAttachment, type ParsedFile} from '@/lib/chatFiles';
import {useSetting} from '@/lib/store';
import './voice-call.css';
import {useModalFocus} from '@/ui/useModalFocus';

type LocalPermission = {allowLocal:boolean;categories:LocalDataCategory[]};
const STEP_KINDS=['reasoning','tool'] as const, STEP_STATES=['running','done','error'] as const;
/** Kept separate from the chat payload so a stored step log can never crash a render. */
export function readFreeChatSteps(value:unknown):FreeChatStep[] {
  if(!Array.isArray(value))return [];
  return value.flatMap(item=>{
    if(!item||typeof item!=='object')return [];
    const step=item as Record<string,unknown>;
    if(typeof step.id!=='string'||!STEP_KINDS.includes(step.kind as typeof STEP_KINDS[number])||typeof step.text!=='string')return [];
    return [{id:step.id.slice(0,200),kind:step.kind as FreeChatStep['kind'],label:typeof step.label==='string'?step.label.slice(0,80):'',text:step.text.slice(0,4000),...(STEP_STATES.includes(step.status as typeof STEP_STATES[number])?{status:step.status as FreeChatStep['status']}:{}),...(typeof step.input==='string'?{input:step.input.slice(0,4000)}:{}),...(typeof step.output==='string'?{output:step.output.slice(0,4000)}:{})}];
  }).slice(0,60);
}
function savedMessages(messages:readonly ThreadMessage[]):FreeChatMessage[] {
  return messages.flatMap(message=>{
    if(message.role!=='user'&&message.role!=='assistant')return [];
    const content=message.content.filter(part=>part.type==='text').map(part=>part.text).join('');
    const incomplete=message.role==='assistant'&&message.status.type==='incomplete';
    if(!content.trim()&&!(incomplete&&message.status.reason==='error'))return [];
    return [{role:message.role,content,...(message.role==='assistant'?{queries:readFreeChatQueries(message.metadata.custom.localQueries),...(()=>{const steps=readFreeChatSteps(message.metadata.custom.localSteps);return steps.length?{steps}:{};})(),...(()=>{const elapsed=Number(message.metadata.custom.localElapsedMs);return Number.isFinite(elapsed)&&elapsed>0?{elapsedMs:Math.round(elapsed)}:{};})()}:{}),...(incomplete?{status:content?'partial' as const:'failed' as const,error:message.status.reason==='error'?String(message.status.error || t('回答失败')):undefined}:{})}];
  });
}
export function FreeChatPage() {
  const [sessions]=useData<FreeChatSession[]>('freeChats',[]);
  const [id,setId]=useState<string>(()=>crypto.randomUUID());
  const [revision,setRevision]=useState(0);
  const [permission,setPermission]=useState<LocalPermission>({allowLocal:false,categories:[...LOCAL_DATA_CATEGORIES]});
  const [query,setQuery]=useState('');
  const [renaming,setRenaming]=useState<string|null>(null);
  const [draft,setDraft]=useState('');
  const [collapsed,setCollapsed]=useSetting<boolean>('freechat.sidebarCollapsed',false);
  const openSession=(next:string)=>{setPermission({allowLocal:false,categories:[...LOCAL_DATA_CATEGORIES]});setQuery('');setId(next);};
  const callEnded=useCallback(()=>setRevision(value=>value+1),[]);
  const current=sessions.find(session=>session.id===id);
  const visible=useMemo(()=>{
    const needle=query.trim().toLowerCase();
    return needle?sessions.filter(session=>session.title.toLowerCase().includes(needle)):sessions;
  },[sessions,query]);
  const commitRename=async(session:FreeChatSession)=>{
    const title=draft.trim();
    setRenaming(null);
    if(!title||title===session.title)return;
    try{await renameFreeChat(session.id,title);}catch{showToast({type:'error',title:t('重命名失败')});}
  };
  const remove=async(session:FreeChatSession)=>{
    if(!window.confirm(t('删除「{title}」？此操作无法撤销。',{title:session.title})))return;
    try{await deleteFreeChat(session.id);if(session.id===id)openSession(crypto.randomUUID());}
    catch{showToast({type:'error',title:t('删除失败')});}
  };
  return <div className="-mx-7 -my-7 flex h-[calc(100vh-6rem)] min-h-[520px] bg-background">
    <aside className={`hidden shrink-0 flex-col border-r bg-muted/20 md:flex ${collapsed?'w-14':'w-60'}`}>
      {collapsed?<div className="flex flex-col items-center gap-1 p-2">
        <button onClick={()=>setCollapsed(false)} aria-label={t('展开侧栏')} title={t('展开侧栏')} className="rounded-lg p-2 text-muted-foreground hover:bg-muted"><PanelLeftOpen size={16}/></button>
        <button onClick={()=>openSession(crypto.randomUUID())} aria-label={t('新对话')} title={t('新对话')} className="rounded-lg border bg-background p-2 shadow-xs hover:bg-muted"><Plus size={16}/></button>
      </div>:<>
      <div className="flex items-center gap-1 p-3"><button className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-medium shadow-xs hover:bg-muted" onClick={()=>openSession(crypto.randomUUID())}><Plus size={15}/>{t('新对话')}</button><button onClick={()=>setCollapsed(true)} aria-label={t('收起侧栏')} title={t('收起侧栏')} className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted"><PanelLeftClose size={15}/></button></div>
      <div className="px-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"/>
          <input value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('搜索对话')} aria-label={t('搜索对话')} className="w-full rounded-lg border bg-background py-1.5 pl-8 pr-7 text-xs outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring/30"/>
          {query&&<button onClick={()=>setQuery('')} aria-label={t('清除搜索')} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"><X size={12}/></button>}
        </div>
      </div>
      <div className="px-3 pb-1 pt-4 text-[11px] font-medium text-muted-foreground">{t('最近对话')}</div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {visible.map(session=>renaming===session.id
          ? <input key={session.id} autoFocus value={draft} onChange={event=>setDraft(event.target.value)} onBlur={()=>void commitRename(session)} onKeyDown={event=>{if(event.key==='Enter')void commitRename(session);if(event.key==='Escape')setRenaming(null);}} className="w-full rounded-md border border-primary/40 bg-background px-2 py-1.5 text-xs outline-none"/>
          : <div key={session.id} className={`group flex items-center gap-1 rounded-md pr-1 ${id===session.id?'bg-primary/10 text-primary':'hover:bg-muted'}`}>
              <button onClick={()=>{if(id!==session.id)openSession(session.id);}} onDoubleClick={()=>{setDraft(session.title);setRenaming(session.id);}} title={t('双击可重命名')} className="min-w-0 flex-1 truncate px-2 py-2 text-left text-xs">{stripAttachmentBlocks(session.title)||session.title}</button>
              <button onClick={()=>void remove(session)} aria-label={t('删除对话')} className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-background hover:text-destructive group-hover:opacity-100 focus:opacity-100"><Trash2 size={12}/></button>
            </div>)}
        {visible.length===0&&<p className="px-2 py-6 text-center text-xs text-muted-foreground">{query?t('没有匹配的对话'):t('还没有对话，说点什么开始吧。')}</p>}
      </div>
      </>}
    </aside>
    <ChatThread key={`${id}:${revision}`} id={id} initial={current?.messages || []} initialModel={current?.model ?? null} permission={permission} onPermissionChange={setPermission} onCallEnd={callEnded} onDelete={async()=>{
      if(!window.confirm(t('删除这段对话？此操作无法撤销。')))return;
      await deleteFreeChat(id);
      openSession(crypto.randomUUID());
    }}/>
  </div>;
}

function ChatThread({id,initial,initialModel,permission,onPermissionChange,onDelete,onCallEnd}:{id:string;initial:FreeChatMessage[];initialModel:AiRoute|null;permission:LocalPermission;onPermissionChange:(permission:LocalPermission)=>void;onDelete:()=>Promise<void>;onCallEnd:()=>void}) {
  const {allowLocal,categories}=permission;
  const [speak,setSpeak]=useState(false),[speaking,setSpeaking]=useState(false),[tool,setTool]=useState(''),[error,setError]=useState('');
  const [model,setModel]=useState<AiRoute|null>(initialModel);
  const modelRef=useRef<AiRoute|null>(initialModel);modelRef.current=model;
  const [approval,setApproval]=useState<FreeChatApprovalRequest|null>(null);
  const [receipt,setReceipt]=useState('');
  const approvalRef=useRef<FreeChatApprovalRequest|null>(null);approvalRef.current=approval;
  const approvalResolve=useRef<((decision:FreeChatApproval)=>void)|null>(null);
  const grants=useRef<Set<string>>(new Set());
  const [attachments,setAttachments]=useState<ChatAttachment[]>([]);
  const attachmentsRef=useRef<ChatAttachment[]>([]);attachmentsRef.current=attachments;
  /** Pictures of the message being sent: they go to the model as vision input, never to disk. */
  const imagesRef=useRef<string[]>([]);
  const [sentFiles,setSentFiles]=useState<ParsedFile[]>([]);
  // Attachments live outside the message text once it is stored, so keep a map from
  // message id to the files that were sent with it and render them as chips.
  const [attachmentIndex,setAttachmentIndex]=useState<Record<string,ParsedFile[]>>({});
  const [resourcesOpen,setResourcesOpen]=useSetting<boolean>('freechat.resourcesOpen',true);
  const [askBeforeRead,setAskBeforeRead]=useSetting<boolean>('freechat.askBeforeRead',true);
  const askRef=useRef(askBeforeRead);askRef.current=askBeforeRead;
  const files=useMemo(()=>{
    const merged=new Map<string,ParsedFile>();
    for(const file of conversationFiles(initial))merged.set(file.name,file);
    for(const file of sentFiles)merged.set(file.name,file);
    return [...merged.values()];
  },[initial,sentFiles]);
  const askApproval=useCallback((request:FreeChatApprovalRequest)=>new Promise<FreeChatApproval>(resolve=>{
    if(request.category&&grants.current.has(request.category)){resolve('once');return;}
    if(!askRef.current){resolve('once');return;}
    setReceipt('');setApproval(request);approvalResolve.current=resolve;
  }),[]);
  const decideApproval=useCallback((decision:FreeChatApproval)=>{
    const settle=approvalResolve.current,request=approvalRef.current;
    approvalResolve.current=null;approvalRef.current=null;setApproval(null);
    if(decision==='always'&&request?.category)grants.current.add(request.category);
    setReceipt(decision==='deny'
      ?t('已拒绝读取：{title}',{title:request?.title || t('本地资料')})
      :decision==='always'&&request?.category
        ?t('已允许：{title}（本对话不再询问同类读取）',{title:request.title})
        :t('已允许读取：{title}',{title:request?.title || t('本地资料')}));
    settle?.(decision);
  },[]);
  const recordTool=useCallback((name:string)=>{const label=name==='app_guide'?t('应用功能'):name==='list_local_data'?t('本地记录清单'):name==='read_local_record'?t('本地记录详情'):name==='search_local_knowledge'?t('本地资料搜索'):t('未知工具');setTool(t('正在查询{label}…',{label}));},[]);
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
  const permissionEpoch=useRef(0),textRequest=useRef<AbortController|null>(null),reasoningRef=useRef('');
  const speaker=useMemo(()=>questionSpeaker(value=>{setSpeaking(value);const current=playback.current;if(!current)return;if(value)current.started=true;else if(current.started){playback.current=null;current.finished();}},reason=>{const current=playback.current;playback.current=null;if(current)current.failed(reason);else setError(t('语音播放失败：{message}',{message:String((reason as Error)?.message || reason)}));}),[]);
  useEffect(()=>()=>speaker.dispose(),[speaker]);
  useEffect(()=>()=>{textRequest.current?.abort();voiceRequest.current?.abort();},[]);
  const adapter=useMemo<ChatModelAdapter>(()=>({async *run({messages,abortSignal}) {
    setError('');setTool('');speaker.stop();
    const controller=new AbortController(),epoch=permissionEpoch.current,grant=config.current;
    const cancel=()=>controller.abort(abortSignal.reason);abortSignal.addEventListener('abort',cancel,{once:true});if(abortSignal.aborted)cancel();textRequest.current=controller;
    const history=savedMessages(messages);
    const pending=attachmentsRef.current;
    if(pending.length&&history.length&&history[history.length-1].role==='user'){
      const last=history[history.length-1];
      history[history.length-1]={...last,content:composeAttachmentContent(last.content,pending)};
      imagesRef.current=pending.filter(item=>item.dataUrl).map(item=>item.dataUrl!);
      attachmentsRef.current=[];setAttachments([]);
      const owner=messages[messages.length-1];
      if(owner){const list=pending.map(item=>({name:item.name,body:item.dataUrl?IMAGE_MARKER:item.text,chars:item.text.length,image:Boolean(item.dataUrl)}));setAttachmentIndex(prev=>({...prev,[owner.id]:list}));}
      setSentFiles(list=>{const merged=new Map(list.map(file=>[file.name,file]));for(const item of pending)merged.set(item.name,{name:item.name,body:item.dataUrl?IMAGE_MARKER:item.text,chars:item.text.length,image:Boolean(item.dataUrl)});return [...merged.values()];});
    }
    try {
      try {
        await saveFreeChat(id,history,modelRef.current);
      } catch(e) {
        const message=t('对话保存失败：{message}',{message:String((e as Error).message || e)});
        yield {status:{type:'incomplete',reason:'error',error:message}};
        return;
      }
      if(controller.signal.aborted)return;
      let full='', complete=false, wake:(()=>void)|undefined, version=0;
      const startedAt=Date.now();
      let elapsedMs=0;
      const queries:FreeChatQuery[]=[],steps:FreeChatStep[]=[];reasoningRef.current='';
      const stepChanged=()=>{version+=1;wake?.();};
      const upsertStep=(step:FreeChatStep)=>{const index=steps.findIndex(item=>item.id===step.id);if(index>=0)steps[index]=step;else steps.push(step);stepChanged();};
      const shots=imagesRef.current;imagesRef.current=[];
      const work=askFreeChat(history,{
        signal:controller.signal,allowLocal:grant.allowLocal,categories:grant.categories,...(modelRef.current?{model:modelRef.current}:{}),...(shots.length?{images:shots}:{}),
        canQueryLocal:()=>permissionEpoch.current===epoch&&config.current.allowLocal,
        onDelta:delta=>{if(!controller.signal.aborted){full+=delta;stepChanged();}},
        onReasoning:text=>{reasoningRef.current+=text;},
        onStep:upsertStep,
        onTool:recordTool,onToolResult:query=>{queries.push(query);stepChanged();},requestApproval:askApproval,
      });
      let failure:unknown;
      void work.then(()=>{complete=true;wake?.();},e=>{failure=e;complete=true;wake?.();});
      let sent=0;
      while(!complete || sent!==version){
        if(sent!==version){sent=version;yield {content:[{type:'text' as const,text:full}],metadata:{custom:{localQueries:queries,localSteps:[...steps],localElapsedMs:elapsedMs||Date.now()-startedAt}}};continue;}
        await new Promise<void>(resolve=>{wake=resolve;});wake=undefined;
      }
      elapsedMs=Date.now()-startedAt;
      const pendingStep=steps.find(step=>step.status==='running');
      if(pendingStep)upsertStep({...pendingStep,status:failure?'error':'done'});
      setTool('');
      const message=failure?t('对话失败：{message}',{message:String((failure as Error).message || failure)}):undefined;
      if(full || (failure&&!controller.signal.aborted)){
        try {
          await saveFreeChat(id,[...history,{role:'assistant',content:full,queries,elapsedMs,...(steps.length?{steps}:{}),...(message?{status:full?'partial' as const:'failed' as const,error:message}:{})}]);
        } catch(e) {setError(t('回答保存失败：{message}',{message:String((e as Error).message || e)}));}
      }
      if(controller.signal.aborted){yield {metadata:{custom:{localQueries:queries,localSteps:[...steps],localElapsedMs:elapsedMs||Date.now()-startedAt}},status:{type:'incomplete',reason:'cancelled'}};return;}
      if(failure){yield {metadata:{custom:{localQueries:queries,localSteps:[...steps],localElapsedMs:elapsedMs||Date.now()-startedAt}},status:{type:'incomplete',reason:'error',error:message}};return;}
      yield {metadata:{custom:{localQueries:queries,localSteps:[...steps],localElapsedMs:elapsedMs||Date.now()-startedAt}}};
      if(config.current.speak&&full&&!inputOwner.current)void speaker.speak(full);
    } finally {
      abortSignal.removeEventListener('abort',cancel);
      if(textRequest.current===controller)textRequest.current=null;
      approvalResolve.current?.('deny');approvalResolve.current=null;
      controller.abort();
    }
  }}),[id,speaker,recordTool,askApproval]);
  const runtime=useLocalRuntime(adapter,{initialMessages:initial.map(message=>({role:message.role,content:[{type:'text' as const,text:message.content}],metadata:{custom:{localQueries:readFreeChatQueries(message.queries),localSteps:readFreeChatSteps(message.steps),localElapsedMs:message.elapsedMs ?? 0}},...(message.role==='assistant'&&message.status?{status:{type:'incomplete' as const,reason:'error' as const,error:message.error || t('上次回答未完成，请重试。')}}:{})}))});
  const changePermission=(next:LocalPermission)=>{permissionEpoch.current++;config.current={...config.current,...next};textRequest.current?.abort();runtime.thread.cancelRun();voiceRequest.current?.abort();speaker.stop();setTool('');onPermissionChange(next);};
  const voiceCall=useMemo(()=>createVoiceCall({
    ...(speechInputMode==='realtime'?{openRealtime:async (onPreview:(text:string)=>void,onError:(message:string)=>void,signal:AbortSignal)=>{
      const {openConfiguredRealtimeAsr}=await import('@/lib/realtimeAsr');
      let finals:string[]=[];
      return openConfiguredRealtimeAsr({onResult:result=>{if(result.isFinal)finals.push(result.text);onPreview([...finals,...(!result.isFinal?[result.text]:[])].join(' '));},onError:error=>onError(error.message),onState:state=>{if(state==='reconnecting')onError(t('实时识别连接中断，请重新开始通话并重说刚才的话。'));}},{signal,silenceMs:800});
    }}:{}),
    preview:setVoicePreview,
    open:(onPcm,onError)=>openMicrophone({onPcm:(pcm,volume)=>{onPcm(pcm,volume);if(performance.now()-lastMeter.current>100){lastMeter.current=performance.now();setVoiceLevel(Math.min(1,volume/45));}},onError}),
    transcribe:(pcm,signal)=>transcribeAudio(encodeWav(pcm),{signal}),
    send:async text=>{
      const controller=new AbortController();voiceRequest.current=controller;
      const epoch=permissionEpoch.current,grant=config.current,queries:FreeChatQuery[]=[];
      const history:FreeChatMessage[]=[...voiceHistory.current,{role:'user',content:text}];
      voiceHistory.current=history;setVoiceMessages(history.slice(voiceStartIndex.current));
      let answer='';
      try {
        voiceSave.current=saveFreeChat(id,history);await voiceSave.current;
        await askFreeChat(history,{signal:controller.signal,allowLocal:grant.allowLocal,categories:grant.categories,canQueryLocal:()=>permissionEpoch.current===epoch&&config.current.allowLocal,voice:true,
          onDelta:delta=>{if(controller.signal.aborted)return;answer+=delta;setVoiceMessages([...history.slice(voiceStartIndex.current),{role:'assistant',content:answer}]);},
          onTool:recordTool,onToolResult:query=>queries.push(query),requestApproval:askApproval});
        if(controller.signal.aborted)return;
        const completed:FreeChatMessage[]=[...history,{role:'assistant',content:answer,queries}];voiceHistory.current=completed;
        voiceSave.current=saveFreeChat(id,completed);await voiceSave.current;
        if(!controller.signal.aborted)call.current?.answer(answer);
      } catch(error) {
        if(!controller.signal.aborted){
          const failed:FreeChatMessage[]=[...history,{role:'assistant',content:answer,queries,status:answer?'partial':'failed',error:t('语音对话失败：{message}',{message:String((error as Error).message || error)})}];
          voiceHistory.current=failed;
          voiceSave.current=saveFreeChat(id,failed);await voiceSave.current.catch(()=>{});
          if(!controller.signal.aborted)call.current?.answerFailed(error);
        }
      }
      finally {approvalResolve.current?.('deny');approvalResolve.current=null;if(voiceRequest.current===controller)voiceRequest.current=null;setTool('');}
    },
    speak:(text,finished,failed)=>{playback.current={started:false,finished,failed};void speaker.speak(text);},
    stopSpeech:()=>{playback.current=null;speaker.stop();},
    cancelAnswer:()=>{voiceRequest.current?.abort();voiceRequest.current=null;},
    state:phase=>{if(phase==='idle'&&inputOwner.current==='call')inputOwner.current=null;setCallPhase(phase);},
    error:message=>{showToast({type:'error',title:t('语音通话已停止'),description:message});refreshAfterVoice();},
  }),[speaker,id,refreshAfterVoice,speechInputMode,recordTool,askApproval]);
  call.current=voiceCall;
  useEffect(()=>()=>{if(voiceCall.getPhase()!=='idle')voiceCall.stop();},[voiceCall]);
  const endVoice=useCallback(()=>{voiceCall.stop();refreshAfterVoice();},[voiceCall,refreshAfterVoice]);
  return <AssistantRuntimeProvider runtime={runtime}><div className="flex min-w-0 flex-1"><ThreadPrimitive.Root inert={callPhase!=='idle'||closingCall} className="flex min-w-0 flex-1 flex-col">
    <div className="flex items-center gap-3 border-b px-6 py-4"><div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary"><AudioLines size={18}/></div><div className="min-w-0 flex-1"><div className="text-sm font-semibold">{t('自由对话')}</div><div className="text-xs text-muted-foreground">{t('文字、语音与本地资料')}</div></div>
      <button onClick={()=>{setSpeak(!speak);if(speak)speaker.stop();}} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted" aria-label={speak?t('关闭语音回复'):t('开启语音回复')} title={speak?t('关闭语音回复'):t('开启语音回复')}>{speak?<Volume2 size={16}/>:<VolumeX size={16}/>}</button>
      <CallButton disabled={callPhase!=='idle'||closingCall||manualBusy} onStart={()=>{if(inputOwner.current)return;if(!chatReady||!sttReady){setError(t('请先在「设置 → AI 服务」配置对话模型和语音转写模型。'));return;}inputOwner.current='call';voiceHistory.current=savedMessages(runtime.thread.getState().messages);voiceStartIndex.current=voiceHistory.current.length;setVoiceMessages([]);setVoicePreview('');setError('');voiceCall.start();}}/>
      <DeleteButton onDelete={onDelete} onError={setError}/>
      {speaking&&<button className="text-xs text-primary" onClick={()=>speaker.stop()}>{t('停止播放')}</button>}
    </div>
    <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <FileIndexContext.Provider value={attachmentIndex}><div className="mx-auto max-w-2xl"><ThreadPrimitive.Empty><div className="flex min-h-[18rem] flex-col justify-center">
          <p className="text-[11px] font-medium tracking-[0.18em] text-primary">{t('MIANXU · 对话')}</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">{t('今天想聊点什么？')}</h2>
          <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{t('可以问我知识、梳理思路，也可以开启本地资料查询，了解自己的岗位和面试记录。')}</p>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">{[t('帮我梳理一下最近的项目经历'),t('面试官问「为什么离职」怎么答？'),t('把这段技术方案讲得更清楚些'),t('我有哪些本地资料可以查询？')].map(item=><ThreadPrimitive.Suggestion key={item} prompt={item} send className="rounded-xl border bg-card px-3 py-2.5 text-left text-xs leading-5 text-muted-foreground shadow-xs transition hover:border-primary/40 hover:text-foreground">{item}</ThreadPrimitive.Suggestion>)}</div>
        </div></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages>{({message})=><ChatMessage role={message.role}/>}</ThreadPrimitive.Messages>
        <ScrollToBottomButton/>
        {error&&<p role="alert" className="py-2 text-xs text-destructive">{error}</p>}
      </div></FileIndexContext.Provider>
    </ThreadPrimitive.Viewport>
    <div className="mx-auto w-full max-w-2xl px-5 pb-4">{approval&&<ApprovalCard request={approval} onDecide={decideApproval}/>}{!approval&&receipt&&<p role="status" aria-live="polite" className="mb-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"><Check size={12} className="text-primary"/>{receipt}</p>}<Composer settings={aiSettings} model={model} onModelChange={next=>{setModel(next);void setFreeChatModel(id,next).catch(()=>{});}} permission={permission} onPermissionChange={changePermission} askBeforeRead={askBeforeRead} onAskBeforeReadChange={setAskBeforeRead} attachments={attachments} onAttach={next=>setAttachments(list=>[...list,...next])} onDetach={target=>setAttachments(list=>list.filter(item=>item.id!==target))} destination={model?describeRoute(aiSettings,model):provider?`${provider.name} · ${aiSettings.routes.chat?.modelId}`:t('未配置对话服务')} setError={setError} speakerStop={speaker.stop} inputOwner={inputOwner} blocked={callPhase!=='idle'||closingCall} onInputBusy={setManualBusy}/></div>
    {callPhase!=='idle'&&createPortal(<VoiceCallDialog phase={callPhase} messages={voicePreview?[...voiceMessages,{role:'user',content:voicePreview}]:voiceMessages} level={voiceLevel} tool={tool} onStop={endVoice} onInterrupt={voiceCall.interrupt} localAccess={allowLocal?categories.map(category=>t(LOCAL_DATA_LABELS[category])).join('、'):undefined} onRevokeLocal={()=>{changePermission({...permission,allowLocal:false});endVoice();}}/>,document.body)}
  </ThreadPrimitive.Root>
    {resourcesOpen?<ResourcePanel files={files} pending={attachments} onClose={()=>setResourcesOpen(false)} onQuote={file=>setAttachments(list=>list.some(item=>item.name===file.name)?list:[...list,{id:`att-${Date.now().toString(36)}`,name:file.name,size:0,kind:chatFileKind(file.name) || 'text',text:file.body}])} onRemove={target=>setAttachments(list=>list.filter(item=>item.id!==target))}/>:<button type="button" onClick={()=>setResourcesOpen(true)} title={t('展开资源栏')} aria-label={t('展开资源栏')} className="flex w-8 shrink-0 items-center justify-center border-l bg-muted/20 text-muted-foreground transition hover:bg-muted hover:text-foreground"><PanelRightOpen size={15}/></button>}
  </div></AssistantRuntimeProvider>;
}

function CallButton({disabled,onStart}:{disabled:boolean;onStart:()=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={disabled||running} onClick={onStart} className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground disabled:opacity-40"><Phone size={14}/>{t('语音通话')}</button>;
}

export function VoiceCallDialog({phase,messages,level,tool,onStop,onInterrupt,localAccess,onRevokeLocal}:{phase:VoiceCallPhase;messages:FreeChatMessage[];level:number;tool:string;onStop:()=>void;onInterrupt:()=>void;localAccess?:string;onRevokeLocal?:()=>void}) {
  const transcript=useRef<HTMLDivElement>(null),endButton=useRef<HTMLButtonElement>(null),dialog=useRef<HTMLDivElement>(null);
  useModalFocus(dialog,true,onStop,endButton);
  useEffect(()=>{const element=transcript.current;if(element)element.scrollTop=element.scrollHeight;},[messages]);
  const status={connecting:t('正在连接'),listening:t('正在聆听'),transcribing:t('正在识别'),thinking:t('正在思考'),speaking:t('正在回答'),idle:''}[phase];
  const hint={connecting:t('请允许麦克风访问'),listening:t('你可以直接说话，说完稍作停顿'),transcribing:t('正在将你的声音转换成文字'),thinking:tool || t('正在整理回答'),speaking:t('播放时麦克风暂停，避免回声'),idle:''}[phase];
  return <div ref={dialog} tabIndex={-1} className="voice-backdrop" role="dialog" aria-modal="true" aria-label={t('语音通话')}>
    <div className="voice-dialog" data-phase={phase}>
      <header className="voice-header"><span className="voice-brand"><span className="voice-brand-mark"><AudioLines size={15}/></span>{t('语音对话')}</span><span className="voice-live"><span/> {status}</span></header>
      <div className="voice-body">
        <div className="voice-visual" aria-hidden="true" style={{'--voice-level':phase==='listening'?level:0} as CSSProperties}>
          <div className="voice-orbit voice-orbit-outer"/><div className="voice-orbit voice-orbit-inner"/><div className="voice-glow"/><div className="voice-orb"><span/></div>
        </div>
        <div className="voice-state"><div role="status" aria-live="polite">{status}</div><p>{hint}</p></div>
        <div ref={transcript} className="voice-transcript" role="log" aria-label={t('通话内容')} aria-live="polite">
          {messages.length===0?<div className="voice-empty">{t('想聊什么，都可以直接说')}</div>:messages.map((message,index)=><div key={index} className={`voice-line voice-line-${message.role}`}><span>{message.role==='user'?t('你'):t('助手')}</span><p>{message.content}</p></div>)}
          {phase==='thinking' && messages[messages.length-1]?.role==='user' && <div className="voice-line voice-line-assistant"><span>{t('助手')}</span><p className="voice-wait">{t('正在思考')}<span> · · ·</span></p></div>}
        </div>
      </div>
      <footer className="voice-footer"><p>{t('语音会发送至你配置的识别服务')}{localAccess&&<><br/>{t('已允许查询：{access}',{access:localAccess})} <button onClick={onRevokeLocal} className="underline">{t('关闭资料查询并结束通话')}</button></>}</p><div className="voice-actions">{(phase==='speaking'||phase==='thinking')&&<button onClick={onInterrupt} className="voice-interrupt"><Mic size={16}/>{t('打断并说话')}</button>}<button ref={endButton} onClick={onStop} className="voice-end"><PhoneOff size={17}/>{t('结束通话')}</button></div></footer>
    </div>
  </div>;
}

function DeleteButton({onDelete,onError}:{onDelete:()=>Promise<void>;onError:(message:string)=>void}) {
  const running=useAuiState(state=>state.thread.isRunning);
  return <button disabled={running} onClick={()=>void onDelete().catch(e=>onError(t('删除失败：{message}',{message:String((e as Error).message || e)})))} className="rounded-lg border p-2 text-muted-foreground hover:bg-muted disabled:opacity-40" aria-label={t('删除当前对话')} title={t('删除当前对话')}><Trash2 size={16}/></button>;
}

const FileIndexContext=createContext<Record<string,ParsedFile[]>>({});

function ScrollToBottomButton() {
  const empty=useAuiState(state=>state.thread.isEmpty);
  if(empty)return null;
  return <div className="sticky bottom-2 flex justify-center pb-1"><ThreadPrimitive.ScrollToBottom className="flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-md hover:text-foreground" aria-label={t('滚动到底部')}><ArrowDown size={16}/></ThreadPrimitive.ScrollToBottom></div>;
}

function StepRow({step}:{step:FreeChatStep}) {
  const running=step.status==='running';
  return <details className="group">
    <summary className="flex cursor-pointer list-none items-center gap-2 py-0.5 text-[11px] leading-5 text-muted-foreground transition hover:text-foreground">
      <span className="shrink-0 text-foreground/70">{step.kind==='tool'?<Wrench size={12}/>:<Brain size={12}/>}</span>
      <span className="shrink-0 font-medium text-foreground/80">{step.kind==='tool'?t('工具调用'):t('思考')}</span>
      <span className="min-w-0 flex-1 truncate">{step.label&&step.kind==='tool'?`${step.label} · `:''}{step.text}</span>
      {running?<LoaderCircle size={12} className="shrink-0 animate-spin"/>:step.status==='error'?<X size={12} className="shrink-0 text-destructive"/>:null}
      <ChevronDown size={12} className="shrink-0 transition group-open:rotate-180"/>
    </summary>
    <div className="mt-1 space-y-1.5 pb-1 pl-5">
      {step.input&&<div><p className="text-[10px] font-medium text-muted-foreground">{t('输入')}</p><pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 text-[10px] leading-4">{step.input}</pre></div>}
      {step.output&&<div><p className="text-[10px] font-medium text-muted-foreground">{t('输出')}</p><pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1.5 text-[10px] leading-4">{step.output}</pre></div>}
      {!step.output&&step.kind==='reasoning'&&<p className="whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">{step.text}</p>}
    </div>
  </details>;
}

function formatElapsed(ms:number) {
  const total=Math.max(1,Math.round(ms/1000));
  if(total<60)return t('{seconds} 秒',{seconds:total});
  return t('{minutes} 分 {seconds} 秒',{minutes:Math.floor(total/60),seconds:total%60});
}

function StepsView({steps,elapsedMs}:{steps:FreeChatStep[];elapsedMs:number}) {
  const [open,setOpen]=useState(true);
  const known=steps.filter(step=>step.kind==='tool'||step.text.trim());
  if(!known.length)return null;
  const busy=known.some(step=>step.status==='running');
  const failed=known.some(step=>step.status==='error');
  return <div className="mb-1">
    <button type="button" onClick={()=>setOpen(value=>!value)} className="flex w-full items-center gap-2 py-1 text-left text-[11px] leading-5 text-muted-foreground transition hover:text-foreground">
      {busy?<LoaderCircle size={12} className="shrink-0 animate-spin"/>:failed?<X size={12} className="shrink-0 text-destructive"/>:<Check size={12} className="shrink-0"/>}
      <span className="min-w-0 flex-1 truncate">{busy?t('正在处理…'):elapsedMs>0?t('已完成，用时 {duration}',{duration:formatElapsed(elapsedMs)}):t('已完成')}</span>
      <ChevronDown size={12} className={`shrink-0 transition ${open?'rotate-180':''}`}/>
    </button>
    {open&&<div className="pl-1">{known.map(step=><StepRow key={step.id} step={step}/>)}</div>}
  </div>;
}

function ChatMessage({role}:{role:string}) {
  const text=useAuiState(s=>s.message.content.filter(part=>part.type==='text').map(part=>part.text).join(''));
  const parsed=useMemo(()=>splitAttachments(text),[text]);
  const fileIndex=useContext(FileIndexContext);
  const messageId=useAuiState(state=>state.message.id);
  const files=parsed.files.length?parsed.files:fileIndex[messageId]??[];
  const status=useAuiState(s=>s.message.status),rawQueries=useAuiState(s=>s.message.metadata.custom.localQueries),rawSteps=useAuiState(s=>s.message.metadata.custom.localSteps);
  const steps=readFreeChatSteps(rawSteps);
  const rawElapsed=useAuiState(s=>s.message.metadata.custom.localElapsedMs);
  const elapsedMs=Number(rawElapsed);
  const queries=readFreeChatQueries(rawQueries);
  const failed=role==='assistant'&&status?.type==='incomplete'&&status.reason==='error';
  const waiting=role==='assistant'&&status?.type==='running'&&!text;
  return <MessagePrimitive.Root className={`mb-5 flex ${role==='user'?'justify-end':'justify-start'}`}><div className={role==='user'?'max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm leading-6 text-primary-foreground':'w-full text-sm leading-6 text-foreground'}>
    {role==='assistant'?<>{steps.length>0&&<StepsView steps={steps} elapsedMs={elapsedMs}/>}{text&&<Md text={displayFreeChatText(text)}/>}{waiting&&<span role="status" className="text-muted-foreground">{t('正在思考或查询资料…')}</span>}{failed&&<div role="alert" className="text-destructive">{String(status.error || t('回答失败，请重试。'))}</div>}{status?.type==='incomplete'&&status.reason==='cancelled'&&<p className="text-xs text-muted-foreground">{t('已停止回答')}</p>}{queries&&queries.length>0&&<details className="mt-3 border-t pt-2 text-xs text-muted-foreground"><summary className="cursor-pointer select-none">{t('查询记录（{count}）',{count:queries.length})}</summary><ul className="mt-2 space-y-1">{queries.map((query,index)=><li key={index}>{query.category&&t(LOCAL_DATA_LABELS[query.category as LocalDataCategory]) || (query.name==='app_guide'?t('应用功能'):t('资料搜索'))}{query.title?` · ${query.title}`:''}{query.count!==undefined?t(' · {count} 条',{count:query.count}):''} · {query.status==='error'?t('查询失败'):query.status==='cached'?t('复用本轮结果'):t('已查询')}{query.recordId&&<span className="block break-all opacity-70">{t('记录编号：{id}',{id:query.recordId})}</span>}</li>)}</ul></details>}{text&&<ActionBarPrimitive.Root hideWhenRunning autohide="not-last" className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground"><ActionBarPrimitive.Copy className="transition hover:text-foreground data-[copied=true]:text-primary">{t('复制')}</ActionBarPrimitive.Copy><ActionBarPrimitive.Reload disabled={status?.type==='running'} className="transition hover:text-foreground disabled:opacity-40">{t('重新生成')}</ActionBarPrimitive.Reload></ActionBarPrimitive.Root>}</>:<>{parsed.text&&<div className="whitespace-pre-wrap break-words">{parsed.text}</div>}{files.length>0&&<ul className="mt-2 space-y-1">{files.map(file=><li key={file.name} className="flex items-center gap-1.5 rounded-lg bg-primary-foreground/10 px-2 py-1 text-[11px]"><FileText size={12}/><span className="min-w-0 flex-1 truncate">{file.name}</span><span className="shrink-0 opacity-70">{file.image ? t('图片') : t('{count} 字',{count:file.chars})}</span></li>)}</ul>}</>}
  </div></MessagePrimitive.Root>;
}

function ApprovalCard({request,onDecide}:{request:FreeChatApprovalRequest;onDecide:(decision:FreeChatApproval)=>void}) {
  return <div role="group" aria-label={t('需要你确认')} className="mb-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
    <div className="flex items-start gap-2">
      <ShieldQuestion size={16} className="mt-0.5 shrink-0 text-primary"/>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">{t('要读取本地资料：{title}',{title:request.title})}</p>
        {request.summary&&<p className="mt-1 line-clamp-2 break-all text-[11px] leading-5 text-muted-foreground">{request.summary}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={()=>onDecide('once')} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">{t('允许一次')}</button>
          {request.category&&<button type="button" onClick={()=>onDecide('always')} className="rounded-lg border bg-background px-3 py-1.5 text-xs hover:bg-muted">{t('本对话始终允许')}</button>}
          <button type="button" onClick={()=>onDecide('deny')} className="rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-destructive">{t('拒绝')}</button>
        </div>
      </div>
    </div>
  </div>;
}

function Composer({settings,model,onModelChange,permission,onPermissionChange,askBeforeRead,onAskBeforeReadChange,attachments,onAttach,onDetach,destination,setError,speakerStop,inputOwner,blocked,onInputBusy}:{settings:AiSettings;model:AiRoute|null;onModelChange:(next:AiRoute|null)=>void;permission:LocalPermission;onPermissionChange:(permission:LocalPermission)=>void;askBeforeRead:boolean;onAskBeforeReadChange:(value:boolean)=>void;attachments:ChatAttachment[];onAttach:(files:ChatAttachment[])=>void;onDetach:(id:string)=>void;destination:string;setError:(v:string)=>void;speakerStop:()=>void;inputOwner:RefObject<'call'|'manual'|null>;blocked:boolean;onInputBusy:(busy:boolean)=>void}) {
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
      const total=count.current;if(total<8000){setError(t('录音太短，请至少说半秒。'));return;}
      const pcm=new Int16Array(total);let offset=0;for(const chunk of chunks.current){pcm.set(chunk,offset);offset+=chunk.length;}
      const text=await transcribeAudio(encodeWav(pcm),{signal:request.signal});if(alive.current&&!request.signal.aborted)currentComposer.current.setText([currentComposer.current.value,text].filter(Boolean).join(' '));}
      catch(e){if(alive.current&&!request.signal.aborted)setError(t('语音识别失败：{message}',{message:String((e as Error).message || e)}));}
      finally{if(controller.current===request)controller.current=null;chunks.current=[];count.current=0;release();if(alive.current)setBusy(false);}return;
    }
    if(inputOwner.current)return;inputOwner.current='manual';onInputBusy(true);
    opening.current=true;setBusy(true);setError('');speakerStop();chunks.current=[];count.current=0;
    try{const mic=await openMicrophone({onPcm:pcm=>{if(count.current+pcm.length<=16000*60){chunks.current.push(pcm);count.current+=pcm.length;}else if(alive.current)setError(t('已录满 60 秒，请结束录音。'));},onError:message=>{if(alive.current){setError(message);setRecording(false);}void capture.current?.close().catch(()=>{});capture.current=null;release();}});
      if(!alive.current){await mic.close();return;}capture.current=mic;setRecording(true);
    }catch(e){release();if(alive.current)setError(t('无法录音：{message}',{message:String((e as Error).message || e)}));}finally{opening.current=false;if(alive.current)setBusy(false);}
  };
  const [permOpen,setPermOpen]=useState(false);
  const permRef=useClickOutside(()=>setPermOpen(false));
  const [parsing,setParsing]=useState(0);
  const fileInput=useRef<HTMLInputElement|null>(null);
  const attach=async(files:FileList|null)=>{
    if(!files||!files.length)return;
    const picked=[...files];
    if(attachments.length+picked.length>CHAT_ATTACH_MAX){setError(t('一条消息最多附带 {max} 个文件。',{max:CHAT_ATTACH_MAX}));return;}
    setError('');setParsing(picked.length);
    const parsed:ChatAttachment[]=[];
    for(const file of picked){
      try{parsed.push(await readChatAttachment(file));}
      catch(error){if(!(error instanceof DOMException&&error.name==='AbortError'))setError(t('解析失败：{message}',{message:String((error as Error).message || error)}));}
      finally{setParsing(count=>Math.max(0,count-1));}
    }
    if(parsed.length)onAttach(parsed);
    if(fileInput.current)fileInput.current.value='';
  };
  const [dragging,setDragging]=useState(false);
  return <ComposerPrimitive.Root
    onDragOver={event=>{event.preventDefault();setDragging(true);}}
    onDragLeave={()=>setDragging(false)}
    onDrop={event=>{event.preventDefault();setDragging(false);void attach(event.dataTransfer?.files ?? null);}}
    onKeyDownCapture={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&(busy||recording||blocked)){event.preventDefault();event.stopPropagation();}}}
    className={`rounded-2xl border bg-card shadow-sm transition focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-ring/20 ${dragging?'border-primary ring-2 ring-primary/20':''}`}>
    {(attachments.length>0||parsing>0)&&<div className="flex flex-wrap items-center gap-1.5 px-3 pt-2">
      {attachments.map(item=><span key={item.id} className="flex max-w-[15rem] items-center gap-1.5 rounded-lg border bg-muted/40 px-2 py-1 text-[11px]">{item.kind==='image'?<ImageIcon size={12}/>:<FileText size={12}/>}<span className="min-w-0 flex-1 truncate" title={`${item.name} · ${formatFileSize(item.size)}`}>{item.name}</span><button type="button" onClick={()=>onDetach(item.id)} aria-label={t('移除附件')} title={t('移除附件')} className="rounded p-0.5 text-muted-foreground hover:text-destructive"><X size={11}/></button></span>)}
      {parsing>0&&<span className="flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-1 text-[11px] text-muted-foreground"><LoaderCircle size={12} className="animate-spin"/>{t('正在解析…')}</span>}
    </div>}
    <ComposerPrimitive.Input rows={2} onPaste={event=>{const files=event.clipboardData?.files;if(files&&files.length){event.preventDefault();void attach(files);}}} placeholder={t('输入消息，Enter 发送，Shift + Enter 换行，可直接粘贴或拖入图片')} className="max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-6 outline-none placeholder:text-muted-foreground"/>
    <div className="flex items-center gap-1.5 px-2 pb-2">
      <div className="relative" ref={permRef}>
        <button type="button" onClick={()=>setPermOpen(value=>!value)} aria-expanded={permOpen} className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] transition ${allowLocal?'border-primary/40 bg-primary/10 text-primary':'text-muted-foreground hover:bg-muted'}`}><ShieldQuestion size={13}/>{allowLocal?t('资料：{count} 类',{count:categories.length}):t('资料：关闭')}<ChevronDown size={12}/></button>
        {permOpen&&<div className="absolute bottom-full left-0 z-20 mb-2 w-72 rounded-xl border bg-[hsl(var(--popover))] p-3 shadow-xl">
          <label className="flex items-center justify-between gap-3 text-xs font-medium"><span>{t('允许查询本地资料')}</span><input type="checkbox" checked={allowLocal} disabled={blocked||categories.length===0} onChange={event=>onPermissionChange({...permission,allowLocal:event.target.checked})}/></label>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">{LOCAL_DATA_CATEGORIES.map(category=><label key={category} className="flex items-center gap-1.5 text-[11px] text-muted-foreground"><input type="checkbox" checked={categories.includes(category)} disabled={blocked} onChange={event=>{const selected=event.target.checked?[...categories,category]:categories.filter(item=>item!==category);onPermissionChange({allowLocal:allowLocal&&selected.length>0,categories:selected});}}/>{t(LOCAL_DATA_LABELS[category])}</label>)}</div>
          <label className="mt-2 flex items-center justify-between gap-3 border-t pt-2 text-[11px] text-muted-foreground"><span>{t('每次读取前询问')}</span><input type="checkbox" checked={askBeforeRead} onChange={event=>onAskBeforeReadChange(event.target.checked)}/></label>
          <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{allowLocal?(askBeforeRead?t('每次读取前会先问你，允许一次或在本对话内始终允许。读取到的文字片段将发送至：{destination}。',{destination}):t('已关闭逐次确认，开启本地资料后会直接读取。读取到的文字片段将发送至：{destination}。',{destination})):t('本轮不查询本地资料，已有对话仍会作为上下文发送。')}</p>
          <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{t('只允许读取，不修改或删除资料，也不读取截图文件、系统文件或密钥设置。切换对话或离开本页后需重新授权。')}</p>
        </div>}
      </div>
      <input ref={fileInput} type="file" multiple accept={CHAT_ATTACH_ACCEPT} className="hidden" onChange={event=>void attach(event.target.files)}/>
      <button type="button" onClick={()=>fileInput.current?.click()} disabled={blocked||parsing>0} className="shrink-0 rounded-lg p-2 text-muted-foreground transition hover:bg-muted disabled:opacity-40" aria-label={t('添加附件')} title={t('添加附件：PDF、图片、文本')}><Paperclip size={17}/></button>
      <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-muted-foreground">{recording?t('正在录音，再点一次结束'):busy?t('正在识别…'):''}</span>
      <ModelPicker settings={settings} value={model} onChange={onModelChange} placement="up"/>
      <button type="button" onClick={()=>void record()} disabled={busy||blocked||running} className={`shrink-0 rounded-lg p-2 transition ${recording?'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400':'text-muted-foreground hover:bg-muted'}`} aria-label={recording?t('结束录音'):t('语音输入')} title={recording?t('结束录音'):t('语音输入')}>{busy?<LoaderCircle size={17} className="animate-spin"/>:recording?<Square size={17}/>:<Mic size={17}/>}</button>
      <ComposerPrimitive.Cancel className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label={t('停止生成')}><Square size={16}/></ComposerPrimitive.Cancel>
      <ComposerPrimitive.Send disabled={busy||recording||blocked} className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition disabled:opacity-40" aria-label={t('发送')}><ArrowUp size={16}/></ComposerPrimitive.Send>
    </div>
  </ComposerPrimitive.Root>;
}

function ResourcePanel({files,pending,onQuote,onRemove,onClose}:{files:ParsedFile[];pending:ChatAttachment[];onQuote:(file:ParsedFile)=>void;onRemove:(id:string)=>void;onClose:()=>void}) {
  return <aside className="hidden w-72 shrink-0 flex-col border-l bg-muted/10 lg:flex">
    <div className="flex items-start gap-2 border-b px-3 py-3"><div className="min-w-0 flex-1"><p className="text-xs font-semibold">{t('对话资源')}</p><p className="mt-1 text-[11px] leading-5 text-muted-foreground">{t('文件会解析成文字随消息发送，原文件不上传，也不写入磁盘。')}</p></div><button type="button" onClick={onClose} title={t('收起资源栏')} aria-label={t('收起资源栏')} className="shrink-0 rounded-lg p-1 text-muted-foreground hover:bg-muted"><PanelRightClose size={14}/></button></div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {pending.length>0&&<div className="space-y-1.5"><p className="text-[11px] font-medium text-muted-foreground">{t('待发送（{count}）',{count:pending.length})}</p>{pending.map(item=><div key={item.id} className="flex items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 text-[11px]">{item.kind==='image'?<ImageIcon size={12}/>:<FileText size={12}/>}<span className="min-w-0 flex-1 truncate" title={`${item.name} · ${formatFileSize(item.size)}`}>{item.name}</span><button type="button" onClick={()=>onRemove(item.id)} aria-label={t('移除附件')} className="rounded p-0.5 text-muted-foreground hover:text-destructive"><X size={11}/></button></div>)}</div>}
      <div className="space-y-1.5"><p className="text-[11px] font-medium text-muted-foreground">{t('已引用（{count}）',{count:files.length})}</p>{files.map(file=><div key={file.name} className="rounded-lg border bg-background px-2 py-1.5 text-[11px]"><div className="flex items-center gap-1.5"><FileText size={12}/><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span></div><div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground"><span>{file.image ? t('图片') : t('{count} 字',{count:file.chars})}</span><button type="button" onClick={()=>onQuote(file)} className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground">{t('再次引用')}</button></div></div>)}{files.length===0&&<p className="py-6 text-center text-[11px] leading-5 text-muted-foreground">{t('还没有资源。点输入框左边的回形针上传 PDF、图片或文本。')}</p>}</div>
    </div>
  </aside>;
}
