import { getAiSettings, useAiReady, useAiSettings } from '@/lib/aiSettings';
import { openMicrophone, type MicrophoneCapture } from '@/lib/microphone';
import { getSetting, useSetting } from '@/lib/store';
import type { RealtimeCapture } from '@/lib/realtimeAsr';
/*
 * 模拟面试窗口（#mock，对齐原版 LT/NT 的服务端行为）：
 * - 动态对话：面试官按简历/岗位出题，答完根据回答决定追问或换新题；
 * - 全部对话与复盘落 session（data.json），跨重启可续场；
 * - 语音播报 TTS、空格键录音 → STT、静音提示、AI 辅助提示。
 *
 * 写入约定：session.messages 只能在「读到 → 追加 → 写回」的单向流里更新，
 * 每次写回都基于本次读到的数组，避免覆盖另一个窗口/协程的追加。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Sparkles, Square, Send, Volume2, VolumeX, MessagesSquare, X } from 'lucide-react';
import { Button, Textarea, showToast, ToastViewport, ConfirmDialog } from '@/ui/primitives';
import { encodeWav, transcribeAudio } from '@/lib/ai';
import {
  askedQuestionCount,
  generateHint,
  generateMockReport,
  generateNextQuestion,
  generateOpeningQuestion,
  mockMeta,
  type MockConfig,
} from '@/lib/mock';
import { updateSession, useData, type ChatMessage, type InterviewSession } from '@/lib/backend';
import { AvatarMark } from './AvatarMark';
import { questionSpeaker } from '@/lib/questionSpeech';
import './room.css';

const SILENCE_HINT_AFTER_MS = 4000;
interface VoiceRecording { capture:MicrophoneCapture|null; realtime?:RealtimeCapture; controller:AbortController; chunks:Int16Array[]; length:number; voicedMs:number; finals:string[]; stopping:boolean }

function newMessage(role: ChatMessage['role'], text: string, turnKind?: 'NEW' | 'CONT'): ChatMessage {
  return {
    id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    role,
    text,
    createdAt: Date.now(),
    ...(turnKind ? { metadata: { turnKind } } : {}),
  };
}

export function MockApp() {
  return <><MockRoom /><ToastViewport /></>;
}
function MockRoom() {
  const sessionId = useMemo(() => {
    const m = /[?&]sid=([^&]+)/.exec(window.location.hash);
    return m ? decodeURIComponent(m[1]) : '';
  }, []);
  const [sessions] = useData<InterviewSession[]>('interviewSessions', []);
  const session = sessions.find((s) => s.id === sessionId) ?? null;
  const config: MockConfig | null = session ? (mockMeta(session)?.config ?? null) : null;

  const [draft, setDraft] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [silentSince, setSilentSince] = useState<number | null>(null);
  const [ttsOn, setTtsOn] = useSetting('mock.speechEnabled', true);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [assistOverride, setAssistOverride] = useState<boolean | null>(null);
  const assistEnabled = assistOverride ?? config?.assistMode ?? false;
  const [speaking, setSpeaking] = useState(false);
  const [hints, setHints] = useState<Record<string, string>>({});
  const [report, setReport] = useState<string | null>(null);
  const [generatingReport, setGeneratingReport] = useState(false);
  const [finished, setFinished] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /** 出题失败的自动重试计数：提交/开场失败后触发 effect 重跑 */
  const [retryTick, setRetryTick] = useState(0);
  const recorderRef = useRef<VoiceRecording|null>(null);
  const [voicePreview,setVoicePreview] = useState('');
  const [voiceStatus,setVoiceStatus] = useState('');
  const player = useMemo(() => questionSpeaker(setSpeaking, reason => showToast({type:'error', title:'面试官语音暂时不可用', description:String((reason as Error).message || reason)})), []);
  const busyRef = useRef(false);
  const finishingRef = useRef(false);
  const requestGeneration = useRef(0);
  const questionRequest = useRef<AbortController | null>(null);
  const retryTimer = useRef<number | null>(null);
  const aiReady = useAiReady('chat');
  const speechSettings = useAiSettings();

  const messages = session?.messages ?? [];
  const asked = askedQuestionCount(messages);
  const currentQuestion = [...messages].reverse().find((m) => m.role === 'INTERVIEWER') ?? null;
  const done = finished || session?.status === 'COMPLETED';
  useEffect(() => () => {
    requestGeneration.current++; questionRequest.current?.abort();
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    const rec=recorderRef.current; recorderRef.current=null;
    rec?.controller.abort();void rec?.capture?.close();void rec?.realtime?.close();
  }, []);

  // Opening/resume requests are cancelled when the room ends or unmounts.
  useEffect(() => {
    if (!session || !config || done || busyRef.current) return;
    const msgs = session.messages;
    if (msgs[msgs.length - 1]?.role === 'INTERVIEWER' || !aiReady) return;
    const generation = ++requestGeneration.current;
    const controller = new AbortController(); questionRequest.current = controller;
    busyRef.current = true; setThinking(true);
    void (async () => {
      try {
        const reply = msgs.length === 0
          ? {question: await generateOpeningQuestion(config, controller.signal), turnKind:'NEW' as const}
          : await generateNextQuestion(config, msgs, controller.signal);
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        await updateSession(session.id, {messages:[...msgs, newMessage('INTERVIEWER',reply.question,reply.turnKind)]});
      } catch (error) {
        if (controller.signal.aborted || generation !== requestGeneration.current) return;
        showToast({type:'error',title:'面试官出题失败',description:String((error as Error).message || error)});
        retryTimer.current = window.setTimeout(() => setRetryTick(t => t + 1), 1500);
      } finally {
        if (generation === requestGeneration.current) {busyRef.current = false; setThinking(false);}
      }
    })();
    return () => {
      controller.abort();
      // A refreshed record may replace this effect while opening is pending.
      // Release only this request's ownership so its replacement can start.
      if (questionRequest.current === controller) {
        questionRequest.current = null;
        busyRef.current = false;
      }
    };
  }, [session, config, done, aiReady, retryTick]);

  // Route presence chooses configured TTS; otherwise the OS voice is used.
  useEffect(() => {
    if (currentQuestion && ttsOn && !done) void player.speak(currentQuestion.text);
    return () => player.stop();
  }, [currentQuestion?.id, ttsOn, done, player, speechSettings.routes.tts, speechSettings.ttsVoice]);

  // AI 辅助提示（练手用，开始前在工作台开关）
  useEffect(() => {
    if (!config || !assistEnabled || !aiReady || done || !currentQuestion) return;
    if (hints[currentQuestion.id] !== undefined) return;
    const controller = new AbortController();
    setHints((h) => ({ ...h, [currentQuestion.id]: '' }));
    void (async () => {
      try {
        const hint = await generateHint(config, currentQuestion.text, controller.signal);
        if (!controller.signal.aborted) setHints((h) => ({ ...h, [currentQuestion.id]: hint }));
      } catch {
        if (controller.signal.aborted) return;
        setHints((h) => {
          const next = { ...h };
          delete next[currentQuestion.id];
          return next;
        });
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestion?.id, assistEnabled, aiReady, done]);

  // 计时器
  useEffect(() => {
    if (!session || done) return;
    setElapsed(Date.now() - session.createdAt);
    const timer = window.setInterval(() => setElapsed(Date.now() - session.createdAt), 1000);
    return () => window.clearInterval(timer);
  }, [session, done]);

  // 静音提示：开麦后一直没声音
  useEffect(() => {
    if (!recording || silentSince == null) return;
    const timer = window.setInterval(() => {
      if (Date.now() - silentSince > SILENCE_HINT_AFTER_MS) {
        showToast({ type: 'info', title: '一直没听到你的声音', description: '检查一下系统用的是哪支麦克风。' });
        setSilentSince(null);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording, silentSince]);

  const startRec = async () => {
    if (recorderRef.current || transcribing || thinking || done) return;
    player.stop();setSpeaking(false);
    const rec: VoiceRecording = {capture:null,controller:new AbortController(),chunks:[],length:0,voicedMs:0,finals:[],stopping:false};
    recorderRef.current=rec;setTranscribing(true);setVoicePreview('');setVoiceStatus('正在连接语音输入…');
    try {
      if (getAiSettings().speechInputMode === 'realtime') {
        const {openConfiguredRealtimeAsr}=await import('@/lib/realtimeAsr');
        rec.realtime=await openConfiguredRealtimeAsr({
          onResult:result=>{
            if(recorderRef.current!==rec)return;
            if(result.isFinal)rec.finals.push(result.text);
            setVoicePreview([...rec.finals,...(result.isFinal?[]:[result.text])].join(' '));
          },
          onState:state=>{if(recorderRef.current===rec)setVoiceStatus(state==='reconnecting'?'连接中断，正在重连；中断期间的语音请重说。':state==='ready'?'实时字幕连接就绪':'正在连接语音服务…');},
          onError:error=>{
            if(recorderRef.current!==rec)return;
            recorderRef.current=null;rec.controller.abort();void rec.capture?.close();void rec.realtime?.close();
            setRecording(false);setMicLevel(0);setVoiceStatus('语音已中断，定稿文字已保留。');setVoicePreview('');
            if(rec.finals.length)setDraft(text=>[text,...rec.finals].filter(Boolean).join(' '));
            showToast({type:'error',title:'实时语音中断',description:error.message});
          },
        },{signal:rec.controller.signal});
      }
      if(recorderRef.current!==rec) {await rec.realtime?.close();return;}
      rec.capture=await openMicrophone({deviceId:getSetting('interview.microphoneId',''),onPcm:(pcm,volume)=>{
        if(recorderRef.current!==rec)return;
        setMicLevel(Math.min(1,volume/80));
        if(volume>3){setSilentSince(null);rec.voicedMs+=pcm.length/16;}
        if(rec.length>=16000*120){void stopRec();return;}
        rec.length+=pcm.length;
        if(rec.realtime)rec.realtime.push(pcm);else rec.chunks.push(pcm.slice());
      },onError:message=>{showToast({type:'error',title:message});void stopRec();}});
      if(recorderRef.current!==rec){await rec.capture.close();return;}
      setRecording(true);
      setSilentSince(Date.now());
      if(!rec.realtime)setVoiceStatus('正在录音，结束后转写；单次最多两分钟。');
    } catch(error) {
      recorderRef.current=null;rec.controller.abort();await rec.capture?.close();await rec.realtime?.close();
      setVoiceStatus(`语音输入未启动：${String((error as Error).message||error)}`);
      showToast({ type: 'error', title: '语音输入启动失败，可以先用文字作答',description:String((error as Error).message||error) });
    } finally {setTranscribing(false);}
  };

  const stopRec = async () => {
    const rec = recorderRef.current;
    if (!rec || rec.stopping) return;
    rec.stopping=true;
    await rec.capture?.close();
    setRecording(false);
    setMicLevel(0);
    setSilentSince(null);
    if (rec.length < 6400 || rec.voicedMs < 250) {
      recorderRef.current=null;rec.controller.abort();await rec.realtime?.close();setVoicePreview('');setVoiceStatus('未检测到足够的人声');
      showToast({ type: 'info', title: '没听到你说话，再说一次' });
      return;
    }
    const pcm = new Int16Array(rec.realtime?0:rec.length);
    let off = 0;
    for (const c of rec.chunks) {
      pcm.set(c, off);
      off += c.length;
    }
    setTranscribing(true);
    try {
      const text = rec.realtime ? await rec.realtime.finish() : await transcribeAudio(encodeWav(pcm),{signal:rec.controller.signal});
      if (text && recorderRef.current===rec) setDraft((d) => (d ? `${d} ${text}` : text));
      else showToast({ type: 'info', title: '没听到你说话，再说一次' });
    } catch (e) {
      showToast({ type: 'error', title: '语音识别失败，请再说一次', description: String((e as Error).message ?? e) });
    } finally {
      if(recorderRef.current===rec)recorderRef.current=null;
      rec.controller.abort();await rec.realtime?.close();setVoicePreview('');setVoiceStatus('');
      setTranscribing(false);
    }
  };

  // 空格键开关麦克风
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat) return;
      const el = e.target as HTMLElement;
      if (['TEXTAREA','INPUT','BUTTON','SELECT'].includes(el.tagName) || el.isContentEditable) return;
      e.preventDefault();
      if (recording) void stopRec();
      else void startRec();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  const finish = useCallback(
    async (finalMessages: ChatMessage[]) => {
      if (!session || finishingRef.current) return;
      finishingRef.current = true;
      requestGeneration.current++; questionRequest.current?.abort();
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      player.stop(); setFinished(true); setThinking(false); busyRef.current = false;
      const rec=recorderRef.current;recorderRef.current=null;rec?.controller.abort();
      const closing = await Promise.allSettled([rec?.capture?.close(), rec?.realtime?.close()]);
      setRecording(false);
      if (closing.some(result => result.status === 'rejected')) showToast({type:'info', title:'音频清理遇到错误，关闭窗口后系统会回收设备。'});
      const answered = finalMessages.filter((m) => m.role === 'ASSISTANT');
      try {
        await updateSession(session.id, {
          status: 'COMPLETED', endedAt: Date.now(),
          metadata: { ...(session.metadata ?? {}), reportStatus: aiReady && answered.length > 0 ? 'pending' : undefined },
        });
      } catch (error) {
        finishingRef.current = false; setFinished(false);
        showToast({type:'error', title:'结束状态未保存，请重试', description:String((error as Error).message || error)});
        return;
      }
      if (!aiReady || answered.length === 0) return;
      setGeneratingReport(true);
      const reportRequest = new AbortController(); questionRequest.current = reportRequest;
      try {
        const text = await generateMockReport(finalMessages, reportRequest.signal);
        if (reportRequest.signal.aborted) return;
        await updateSession(session.id, {
          metadata: { ...(session.metadata ?? {}), report: text, reportStatus: 'ready', reportError: undefined },
        });
        setReport(text);
      } catch (e) {
        const message = reportRequest.signal.aborted ? '复盘已取消，可在历史记录中重新生成。' : String((e as Error).message ?? e);
        await updateSession(session.id, {
          metadata: { ...(session.metadata ?? {}), reportStatus: 'error', reportError: message },
        });
        setReport(`报告生成失败：${message}。稍后可在「历史记录」里重新生成。`);
      } finally {
        setGeneratingReport(false);
      }
    },
    [session, aiReady],
  );

  const submit = async () => {
    if(recording || transcribing)return;
    const text = draft.trim();
    if (!text || !session || !config || busyRef.current || done) return;
    const generation = ++requestGeneration.current;
    const controller = new AbortController(); questionRequest.current = controller;
    setDraft('');
    busyRef.current = true;
    setThinking(true);
    let answerSaved = false;
    try {
      const base = session.messages;
      const answer = newMessage('ASSISTANT', text);
      await updateSession(session.id, { messages: [...base, answer] });
      answerSaved = true;
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      const withAnswer = [...base, answer];
      if (asked >= config.turnBudget) {
        busyRef.current = false;
        await finish(withAnswer);
        return;
      }
      const next = await generateNextQuestion(config, withAnswer, controller.signal);
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      await updateSession(session.id, {
        messages: [...withAnswer, newMessage('INTERVIEWER', next.question, next.turnKind)],
      });
    } catch (e) {
      if (controller.signal.aborted || generation !== requestGeneration.current) return;
      if (!answerSaved) setDraft(text);
      showToast({ type: 'error', title: answerSaved ? '回答已保存，正在重试出题' : '回答未保存，请重试', description: String((e as Error).message ?? e) });
      if (answerSaved) retryTimer.current = window.setTimeout(() => setRetryTick((t) => t + 1), 1500);
    } finally {
      if (generation === requestGeneration.current) {busyRef.current = false; setThinking(false);}
    }
  };

  if (!sessionId || !session || !config) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-300">
        <p className="text-sm">这场模拟面试没打开成功，回到工作台重新开始一场。</p>
      </div>
    );
  }

  const fmtElapsed = (ms: number) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };

  if (done) {
    const meta = mockMeta(session);
    const shownReport = report ?? meta?.report ?? null;
    return (
      <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto p-8">
          <h1 className="text-lg font-semibold">模拟面试复盘</h1>
          <p className="text-sm text-neutral-400">
            {config.goalName}
            {config.company ? ` · ${config.company}` : ''} · 用时{' '}
            {fmtElapsed((session.endedAt ?? Date.now()) - session.createdAt)} ·{' '}
            {session.messages.filter((m) => m.role === 'ASSISTANT').length} 轮问答
          </p>
          {generatingReport && <p className="text-sm text-neutral-400">正在生成复盘报告…（生成后会保存到历史记录）</p>}
          {shownReport && (
            <pre className="whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-[13px] leading-relaxed">
              {shownReport}
            </pre>
          )}
          {!shownReport && !generatingReport && (
            <pre className="whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-[13px] leading-relaxed">
              {session.messages
                .map((m) => `${m.role === 'INTERVIEWER' ? 'Q' : 'A'}：${m.text}`)
                .join('\n\n')}
            </pre>
          )}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => window.close()}>
              关闭窗口
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mock-room">
      <header className="mock-room-header">
        <div className="mock-room-identity"><span className="mock-live-dot" /><div><h1>模拟面试 <span>· {config.goalName || '综合面试'}</span></h1><p>{config.company || config.difficultyLabel} · 第 {Math.min(asked, config.turnBudget)} / {config.turnBudget} 题</p></div></div>
        <time className="mock-clock">{fmtElapsed(elapsed)}</time>
        <div className="mock-room-actions">
          <button aria-label={transcriptOpen ? '收起对话记录' : '展开对话记录'} aria-pressed={transcriptOpen} title="对话记录" onClick={() => setTranscriptOpen(!transcriptOpen)}><MessagesSquare size={18} /></button>
          <button aria-label={ttsOn ? '关闭面试官语音' : '开启面试官语音'} aria-pressed={ttsOn} title={speechSettings.routes.tts ? '使用已配置的语音服务' : '使用系统默认语音'} onClick={() => setTtsOn(!ttsOn)}>{ttsOn ? <Volume2 size={18} /> : <VolumeX size={18} />}</button>
          <button className="mock-end" onClick={() => setConfirmEnd(true)}>结束面试</button>
        </div>
      </header>
      <div className={`mock-room-workspace ${transcriptOpen ? '' : 'without-transcript'}`}>
        <section className="mock-stage" aria-label="面试现场">
          <div className="mock-participants">
            <div className={`mock-participant ${speaking ? 'is-speaking' : ''}`}>
              <span className="mock-role">面试官</span><div className="mock-avatar-halo"><AvatarMark size={112} /></div>
              <div className="mock-participant-caption"><span className={speaking ? 'mock-live-dot' : 'mock-muted-dot'} />{speaking ? '正在提问' : thinking ? '正在思考下一问' : '面试官'}</div>
            </div>
            <div className={`mock-participant candidate ${recording ? 'is-speaking' : ''}`}>
              <span className="mock-role">候选人</span><div className="mock-candidate-avatar">我</div>
              <div className="mock-participant-caption"><Mic size={13} />{recording ? '正在听你回答' : '文字或语音作答'}</div>
            </div>
          </div>
          <div className="mock-question" aria-live="polite"><span className="mock-question-label">{thinking ? '面试官正在思考' : '当前问题'}</span><p>{currentQuestion?.text || (thinking ? '面试官正在准备开场问题…' : '准备好后开始对话。')}</p>
            {currentQuestion && <button title="重新朗读当前问题" aria-label="朗读当前问题" onClick={() => {if (!ttsOn) setTtsOn(true); else void player.speak(currentQuestion.text);}}><Volume2 size={16} /></button>}
          </div>
          {assistEnabled && currentQuestion && hints[currentQuestion.id] && <div className="mock-hint"><Sparkles size={14} /><p>{hints[currentQuestion.id]}</p></div>}
          <button className={`mock-assist-toggle ${assistEnabled ? 'enabled' : ''}`} aria-pressed={assistEnabled} onClick={() => setAssistOverride(!assistEnabled)}><Sparkles size={14} /> AI 辅助 {assistEnabled ? '已开启' : '已关闭'}</button>
        </section>
        {transcriptOpen && (<aside className="mock-transcript" aria-label="对话记录"><div className="mock-transcript-heading"><span>对话记录</span><button aria-label="收起对话记录" onClick={() => setTranscriptOpen(false)}><X size={15} /></button></div>
        {!aiReady && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12.5px] text-amber-300">
            还没有配置 AI 接口，面试官无法出题。回到主窗口「设置 → AI 服务」配置后重新打开这场面试。
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'ASSISTANT' ? 'flex justify-end' : 'flex items-start gap-2.5'}>
            {m.role === 'INTERVIEWER' && <AvatarMark size={28} />}
            <div
              className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-[14px] leading-relaxed ${
                m.role === 'ASSISTANT' ? 'rounded-tr-sm bg-primary/20' : 'rounded-tl-sm bg-neutral-800'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}
        {assistEnabled && currentQuestion && hints[currentQuestion.id] && (
          <div className="ml-9 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[12.5px] leading-relaxed text-emerald-200">
            <div className="mb-0.5 text-[11px] font-medium opacity-70">提示</div>
            <pre className="whitespace-pre-wrap font-sans">{hints[currentQuestion.id]}</pre>
          </div>
        )}
        {thinking && (
          <div className="flex items-start gap-2.5 opacity-60">
            <AvatarMark size={28} />
            <div className="rounded-lg rounded-tl-sm bg-neutral-800 px-3.5 py-2.5 text-[13px]">面试官正在考虑下一个问题…</div>
          </div>
        )}
      </aside>)}
      </div>
      <footer className="mock-response">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-2">
          <Textarea
            className="border-neutral-700 bg-neutral-900 text-neutral-100"
            rows={3}
            placeholder="回答当前问题：直接打字，或按空格开始/结束说话"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
            }}
            disabled={thinking}
          />
          {(voiceStatus || voicePreview) && <div role="status" aria-live="polite" className="rounded border border-neutral-700 p-2 text-xs text-neutral-300"><p className="text-neutral-500">{voiceStatus}</p>{voicePreview&&<p className="mt-1 whitespace-pre-wrap">{voicePreview}</p>}</div>}
          <div className="flex items-center gap-2">
            <Button
              variant={recording ? 'default' : 'outline'}
              size="sm"
              onClick={() => (recording ? void stopRec() : void startRec())}
              disabled={transcribing || thinking}
            >
              {recording ? <Square size={12} /> : <Mic size={13} />}
              {transcribing ? '识别中…' : recording ? '结束录音' : '空格说话'}
            </Button>
            {recording && (
              <span className="flex h-4 items-end gap-0.5" aria-hidden>
                {[0.35, 0.7, 1, 0.7, 0.35].map((f, i) => (
                  <span
                    key={i}
                    className="w-1 rounded-sm bg-emerald-400 transition-all duration-100"
                    style={{ height: `${Math.max(12, micLevel * 100 * f)}%` }}
                  />
                ))}
              </span>
            )}
            <div className="flex-1 text-[11px] text-neutral-500">Ctrl/⌘ + Enter 提交，面试官会接着追问或换题</div>
            <Button size="sm" onClick={() => void submit()} disabled={!draft.trim() || thinking || recording || transcribing}>
              <Send size={12} />
              提交回答
            </Button>
          </div>
        </div>
      </footer>
      <ConfirmDialog open={confirmEnd} title="结束本场模拟面试？" body="已提交的问答会保留，并生成本场复盘。未提交的文字请先作答。" confirmText="结束并复盘" onCancel={() => setConfirmEnd(false)} onConfirm={() => {setConfirmEnd(false); void finish(session.messages);}} />
    </div>
  );
}
