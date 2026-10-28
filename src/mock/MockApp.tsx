import { getAiSettings, useAiReady } from '@/lib/aiSettings';
import { openMicrophone, type MicrophoneCapture } from '@/lib/microphone';
import { getSetting } from '@/lib/store';
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
import { Mic, Sparkles, Square, Send, Volume2, VolumeX } from 'lucide-react';
import { Button, Textarea, showToast, ToastViewport } from '@/ui/primitives';
import { encodeWav, synthesizeSpeech, transcribeAudio } from '@/lib/ai';
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
  const [ttsOn, setTtsOn] = useState(true);
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const busyRef = useRef(false);
  const aiReady = useAiReady('chat');
  const ttsReady = useAiReady('tts');

  const messages = session?.messages ?? [];
  const asked = askedQuestionCount(messages);
  const currentQuestion = [...messages].reverse().find((m) => m.role === 'INTERVIEWER') ?? null;
  const done = finished || session?.status === 'COMPLETED';
  useEffect(() => () => {
    const rec=recorderRef.current; recorderRef.current=null;
    rec?.controller.abort();void rec?.capture?.close();void rec?.realtime?.close();
  }, []);

  // 面试官说话：开场 / 续场恢复 / 答完后接问。最后一条已经是问题就说明在等回答。
  useEffect(() => {
    if (!session || !config || done || busyRef.current) return;
    const msgs = session.messages;
    const last = msgs[msgs.length - 1];
    if (last && last.role === 'INTERVIEWER') return;
    if (!aiReady) return;
    busyRef.current = true;
    setThinking(true);
    void (async () => {
      try {
        const question =
          msgs.length === 0
            ? await generateOpeningQuestion(config)
            : (await generateNextQuestion(config, msgs)).question;
        await updateSession(session.id, { messages: [...msgs, newMessage('INTERVIEWER', question, 'NEW')] });
      } catch (e) {
        showToast({ type: 'error', title: '面试官出题失败', description: String((e as Error).message ?? e) });
        window.setTimeout(() => setRetryTick((t) => t + 1), 1500);
      } finally {
        busyRef.current = false;
        setThinking(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, config, done, aiReady, retryTick]);

  // 朗读当前问题
  useEffect(() => {
    if (!currentQuestion || !ttsOn || !ttsReady || done) return;
    let cancelled = false;
    void (async () => {
      try {
        const buf = await synthesizeSpeech(currentQuestion.text);
        if (!buf || cancelled) return;
        const blob = new Blob([buf], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onplay = () => setSpeaking(true);
        audio.onended = () => setSpeaking(false);
        audio.onerror = () => setSpeaking(false);
        audioRef.current = audio;
        await audio.play().catch(() => setSpeaking(false));
      } catch {
        setSpeaking(false);
      }
    })();
    return () => {
      cancelled = true;
      setSpeaking(false);
      audioRef.current?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestion?.id, ttsOn, ttsReady, done]);

  // AI 辅助提示（练手用，开始前在工作台开关）
  useEffect(() => {
    if (!config?.assistMode || !aiReady || done || !currentQuestion) return;
    if (hints[currentQuestion.id] !== undefined) return;
    setHints((h) => ({ ...h, [currentQuestion.id]: '' }));
    void (async () => {
      try {
        const hint = await generateHint(config, currentQuestion.text);
        setHints((h) => ({ ...h, [currentQuestion.id]: hint }));
      } catch {
        setHints((h) => {
          const next = { ...h };
          delete next[currentQuestion.id];
          return next;
        });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuestion?.id, config?.assistMode, aiReady, done]);

  // 计时器
  useEffect(() => {
    if (!session || done) return;
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
    audioRef.current?.pause();setSpeaking(false);
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
      if (e.code !== 'Space') return;
      const el = e.target as HTMLElement;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return;
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
      if (!session) return;
      const rec=recorderRef.current;recorderRef.current=null;rec?.controller.abort();await rec?.capture?.close();await rec?.realtime?.close();setRecording(false);
      setFinished(true);
      const answered = finalMessages.filter((m) => m.role === 'ASSISTANT');
      await updateSession(session.id, {
        status: 'COMPLETED',
        endedAt: Date.now(),
        metadata: { ...(session.metadata ?? {}), reportStatus: 'pending' },
      });
      if (!aiReady || answered.length === 0) return;
      setGeneratingReport(true);
      try {
        const text = await generateMockReport(finalMessages);
        await updateSession(session.id, {
          metadata: { ...(session.metadata ?? {}), report: text, reportStatus: 'ready', reportError: undefined },
        });
        setReport(text);
      } catch (e) {
        const message = String((e as Error).message ?? e);
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
    setDraft('');
    busyRef.current = true;
    setThinking(true);
    try {
      const base = session.messages;
      const answer = newMessage('ASSISTANT', text);
      await updateSession(session.id, { messages: [...base, answer] });
      const withAnswer = [...base, answer];
      if (asked >= config.turnBudget) {
        busyRef.current = false;
        await finish(withAnswer);
        return;
      }
      const next = await generateNextQuestion(config, withAnswer);
      await updateSession(session.id, {
        messages: [...withAnswer, newMessage('INTERVIEWER', next.question, next.turnKind)],
      });
    } catch (e) {
      showToast({ type: 'error', title: '提交失败，正在重试出题', description: String((e as Error).message ?? e) });
      window.setTimeout(() => setRetryTick((t) => t + 1), 1500);
    } finally {
      busyRef.current = false;
      setThinking(false);
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
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
        <span
          className={`relative flex size-9 items-center justify-center rounded-full ring-2 transition-all ${
            speaking ? 'ring-emerald-400 shadow-[0_0_24px_-4px_rgba(52,211,153,0.6)]' : 'ring-neutral-700'
          }`}
        >
          <AvatarMark size={36} />
        </span>
        <div>
          <div className="text-sm font-semibold">AI 面试官</div>
          <div className="text-[11px] text-neutral-400">
            {config.goalName}
            {config.company ? ` · ${config.company}` : ''} · 第 {Math.min(asked, config.turnBudget)}/{config.turnBudget}{' '}
            题 · {fmtElapsed(elapsed)}
          </div>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          onClick={() => setTtsOn((v) => !v)}
        >
          {ttsOn ? <Volume2 size={13} /> : <VolumeX size={13} />}
          {ttsOn ? '关掉面试官语音' : '打开面试官语音'}
        </button>
        <button
          type="button"
          className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
            config.assistMode
              ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
              : 'border-neutral-700 text-neutral-300 hover:bg-neutral-800'
          }`}
          onClick={() => {
            showToast({ type: 'info', title: '辅助模式在开始面试前设置，本场内不切换' });
          }}
        >
          <Sparkles size={13} />
          AI 辅助{config.assistMode ? '开' : '关'}
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto p-6">
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
        {config.assistMode && currentQuestion && hints[currentQuestion.id] && (
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
      </main>

      <footer className="border-t border-neutral-800 p-4">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
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
            <Button size="sm" variant="ghost" onClick={() => void finish(session.messages)}>
              提前结束
            </Button>
            <Button size="sm" onClick={() => void submit()} disabled={!draft.trim() || thinking || recording || transcribing}>
              <Send size={12} />
              提交回答
            </Button>
          </div>
        </div>
      </footer>
    </div>
  );
}
