import {markTranscriptSpeaker} from '@/lib/interviewEngine';
import {GenerationDetails} from './GenerationDetails';
import {selectSolverTurn} from '@/lib/examEngine';
/*
 * 面试浮窗：头部（拖拽/状态/剩余时长/穿透切换/结束）、
 * 对话视图（转写竖线气泡 + AI markdown 流式）、底部操作（开始/暂停/
 * 立即回答/笔试答题/语音提问）、内嵌笔试答题视图。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ArrowLeft,
  Camera,
  Columns2,
  Mic,
  MousePointerClick,
  Square,
} from 'lucide-react';
import { computeSkin, normalizeStyle } from '@/lib/overlayStyle';
import { DEFAULT_OVERLAY_STYLE, useSetting, type OverlayStyle } from '@/lib/store';
import {
  beginListening,
  endInterview,
  exposeEngineDebug,
  getInterviewEngineState,
  pauseListening,
  resumeInterviewSession,
  resumeListening,
  startInterview,
  subscribeEngine,
  answerQuestion,
  flushUtterance,
  reportInterviewError,
  waitForEnding,
  type EngineState,
} from '@/lib/interviewEngine';
import {
  capturePage,
  examModeInfo,
  followUp,
  getSolverState,
  nextExamMode,
  setSolverMode,
  solve,
  subscribeSolver,
  type SolverState,
} from '@/lib/examEngine';
import { encodeWav, transcribeAudio } from '@/lib/ai';
import { openMicrophone, type MicrophoneCapture } from '@/lib/microphone';
import { setOverlaySize } from '@/lib/bridge';
import { effectiveHotkeys, type ActionKey, type HotkeyScheme } from '@/lib/hotkeys';
import { t } from '@/lib/i18n';
import { showToast } from '@/ui/primitives';
import { Md, mdToPlain } from './Md';
import { ThinkingLine } from './ThinkingLine';
import {
  DwellButton,
  DwellIconButton,
  DwellDisclosure,
  ConfirmPaletteButton,
  DragHandle,
  HOVER_MS,
  ScrollEdgePill,
  registerOverlayList,
} from './widgets';
import { useDwell, usePlatform } from './platform';
import {getSpeechProfile,useSpeechProfile} from '@/lib/speechPreferences';
import { applyOverlayPalette } from '@/lib/overlayPalette';
import { bus } from '@/lib/events';

/** 收尾最多等这么久，超时就先回主窗口，剩下的写盘在后台继续。 */
const END_WAIT_MS = 6000;

/**
 * 结束面试并回到主窗口。
 * 窗口切换不能依赖收尾是否顺利：停麦、写记录、完成会话任何一步卡住或失败，
 * 都不能把用户关在一个已经结束的浮窗里，所以超时后照样切窗口。
 */
async function endInterviewAndReturn() {
  const bridge = await import('@/lib/bridge');
  let timer: number | undefined;
  try {
    await Promise.race([
      endInterview(true).catch(error => {
        showToast({ type: 'error', title: t('面试已停止，但结束状态尚未保存'), description: String((error as Error).message || error) });
      }),
      new Promise<void>(resolve => { timer = window.setTimeout(resolve, END_WAIT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
  await bridge.setSessionActive(false).catch(() => {});
  try {
    // 先亮主窗口再收浮窗：主窗口万一没起来，用户手里至少还有浮窗可以再点一次。
    await bridge.showMain();
  } catch (error) {
    showToast({ type: 'error', title: t('没能切回主窗口，请再点一次「结束面试」'), description: String((error as Error).message || error) });
    return;
  }
  await bridge.hideOverlay().catch(() => {});
}

// 挂载期间共用的取消信号：挂载 effect 建一个，用户点「重试收音」沿用同一个。
let bootAbort: AbortController | null = null;

export function InterviewOverlay({ preview }: { preview?: boolean }) {
  exposeEngineDebug();
  const rawStyle = useSetting('overlay.style', DEFAULT_OVERLAY_STYLE)[0];
  const style: OverlayStyle = normalizeStyle(rawStyle);
  const skin = useMemo(() => computeSkin(style, 'interview'), [style]);

  useEffect(() => {
    if (preview) return;
    setOverlaySize(style.interviewWidth, style.interviewHeight).catch(() => {});
  }, [preview, style.interviewWidth, style.interviewHeight]);

  // 浮窗侧负责创建会话并开始采集（工作台只传参数）
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    bootAbort = controller;
    void bootInterviewSession(controller.signal).catch((e) => {
      if (!controller.signal.aborted) reportInterviewError(e);
    });
    return () => {
      controller.abort();
      if (bootAbort === controller) bootAbort = null;
    };
  }, [preview]);

  return <InterviewShell skin={skin} preview={preview} />;
}

/**
 * 建立/恢复会话并开始收音。启动失败后「重试收音」也走这里，
 * 避免 sessionId 为空时重试按钮只是空转。
 */
async function bootInterviewSession(signal?: AbortSignal, retried = false): Promise<void> {
  const cfg = (
    window as unknown as { __ml_pendingConfig?: { goalId: string | null; resumeId: string | null; materialIds: string[]; audioSource: 'SPEAKER' | 'PHONE' | 'MICROPHONE' } }
  ).__ml_pendingConfig;
  const { getSetting, setSetting } = await import('@/lib/store');
  if (signal?.aborted) return;
  type PendingCfg = {
    goalId: string | null;
    resumeId: string | null;
    materialIds: string[];
    audioSource: 'SPEAKER' | 'PHONE' | 'MICROPHONE';
  };
  const pending: PendingCfg | null =
    cfg ?? (getSetting<PendingCfg | null>('interview.pendingConfig', null) ?? null);
  if (!pending) return;
  const current = getInterviewEngineState();
  if (current.sessionId) {
    if (current.status === 'connecting') await beginListening(current.audio.source, current.sessionId);
    // 浮窗刚被收起又重新显示时，上一场的收尾可能还在跑（状态已是 ended）。
    // 直接 return 会让引擎停在「已结束、无会话」，用户得再点一次开始；这里等收尾结束再按恢复流程走一遍。
    else if (current.status === 'ended' && !retried) {
      await waitForEnding();
      if (!signal?.aborted) await bootInterviewSession(signal, true);
    }
    return;
  }
  // 已有进行中的会话（浮窗重载/重新显示）→ 恢复历史，不新建
  const storedId = getSetting<string | null>('interview.sessionId', null);
  if (storedId && resumeInterviewSession(storedId, pending.goalId, pending.resumeId)) {
    await beginListening(pending.audioSource ?? 'SPEAKER', storedId);
    return;
  }
  const session = await startInterview({
    goalId: pending.goalId,
    resumeId: pending.resumeId,
    materialIds: pending.materialIds ?? [],
    audioSource: pending.audioSource ?? 'SPEAKER',
  }, signal);
  const ownsSession = () => !signal?.aborted && getInterviewEngineState().sessionId === session.id && getInterviewEngineState().status !== 'ended';
  if (!ownsSession()) return;
  await setSetting('interview.sessionId', session.id);
  if (!ownsSession()) return;
  await beginListening(pending.audioSource ?? 'SPEAKER', session.id);
}

function useEngineState(): EngineState {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeEngine(force), [force]);
  return getInterviewEngineState();
}

function useSolverState(): SolverState {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeSolver(force), [force]);
  return getSolverState();
}

function InterviewShell({
  skin,
  preview,
}: {
  skin: ReturnType<typeof computeSkin>;
  preview?: boolean;
}) {
  const [speechProfile,saveSpeechProfile]=useSpeechProfile('interview');
  const switchLanguage=()=>{const next=speechProfile.answerLanguage==='en-US'?'zh-CN':'en-US';void saveSpeechProfile({...speechProfile,answerLanguage:next}).catch(error=>showToast({type:'error',title:t('语言切换未保存'),description:String(error)}));};
  const engine = useEngineState();
  const solver = useSolverState();
  const [tab, setTab] = useState<'chat' | 'solver'>('chat');
  const scheme = useSetting<HotkeyScheme>('overlay.hotkeyScheme', 'simple')[0];
  const customKeys = useSetting('overlay.actionHotkeys', {} as Partial<Record<ActionKey, string>>)[0];
  const hotkeys = effectiveHotkeys(scheme, customKeys);
  const { interactive, toggleInteractive, bindHotkey } = usePlatform();
  const isDark = skin.theme === 'dark';
  const configuredSource = useSetting<'SPEAKER' | 'PHONE' | 'MICROPHONE'>('interview.audioSource', 'SPEAKER')[0];
  const captureQuestion=()=>{
    if(!engine.sessionId || engine.status==='ended')return;
    setTab('solver');
    void solve();
  };

  // 热键：answer = 立即回答；capture = 切 solver 截屏
  useEffect(() => {
    if (preview) return;
    const offAnswer = bindHotkey('answer', () => {
      if (tab === 'chat') {
        const lastQ = lastInterviewer(engine.messages);
        if (lastQ) void answerQuestion(lastQ);
      } else {
        void solve();
      }
    });
    const offCapture = bindHotkey('capture', () => {
      // 与独立的笔试浮窗保持一致：chat 页这个键是「截图提问」（截一张就直接作答），
      // solver 页是「加页」——只截不发，发送交给 answer 键。之前两页都走 solve()，
      // 「加页」按钮上的徽标写着只截，按下去却直接发送。
      if (tab === 'chat') { captureQuestion(); return; }
      if (!engine.sessionId || engine.status === 'ended') return;
      void capturePage();
    });
    const offVoice = bindHotkey('voice-ask', () => bus.emit('voice-ask:toggle', null));
    return () => {
      offAnswer();
      offCapture();
      offVoice();
    };
  }, [bindHotkey, tab, engine.messages, preview,interactive,engine.sessionId]);

  const started = engine.status !== 'idle' && engine.status !== 'ended';
  const statusInfo = statusOf(engine);

  return (
    <div
      className={`relative flex h-screen flex-col gap-1.5 overflow-hidden rounded-xl p-2 ${isDark ? 'overlay-dark' : ''}`}
      data-overlay-theme={skin.theme}
      style={{
        color: skin.textColor,
        background: skin.shellBg,
        boxShadow: skin.shellShadow,
        ...skin.vars,
      }}
    >
      {/* 头部 */}
      <div className="flex h-6 items-center gap-1.5">
        <DragHandle hoverMs={900} />
        <span className={`ov-dot size-1.5 rounded-full ${started ? '' : 'opacity-40'}`} />
        <span className="ov-text-2 truncate text-[11px] font-semibold">{statusInfo.text}</span>
        <div className="flex-1" />
        {/* 穿透/窗口切换 */}
        <DwellIconButton id="iv-mode" hoverMs={HOVER_MS.switchInteractive}
          label={interactive ? t('切回穿透模式') : t('悬停切到窗口模式')}
          icon={interactive ? <MousePointerClick size={13} /> : <Columns2 size={13} />}
          onTrigger={toggleInteractive} />
        {/* 一键配色 */}
        <PaletteBtn />
        {/* 结束面试 */}
        <EndButton onEnd={() => { void endInterviewAndReturn(); }} />
      </div>

      <AudioInputFeedback engine={engine} />
      {engine.contextSources.length > 0 && <DwellDisclosure
        id="context-sources"
        label={t('本次回答参考 {n} 段简历 / JD / 资料', { n: engine.contextSources.length })}
        className="ov-panel rounded-md px-2 py-1 text-[10px]"
      >
        <div className="max-h-32 overflow-y-auto space-y-2">{engine.contextSources.map(source => <div key={source.id}>
          <div className="font-medium">{source.title} · {source.location}</div><p className="whitespace-pre-wrap opacity-75">{source.excerpt}</p>
        </div>)}</div>
      </DwellDisclosure>}
      {engine.errorMessage && (
        <div role="alert" className="ov-text rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-[11px]">
          {engine.errorMessage}
        </div>
      )}

      {tab === 'chat' ? (
        <ChatView engine={engine} hotkeys={hotkeys} />
      ) : (
        <SolverView
          solver={solver}
          onBack={() => setTab('chat')}
          hotkeys={hotkeys}
        />
      )}

      {/* 底部操作栏 */}
      <div className="flex max-h-[50vh] shrink-0 flex-col gap-1.5 overflow-y-auto">
        {tab === 'chat' ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              <DwellButton id="chat-language" variant="muted" hoverMs={HOVER_MS.action} onTrigger={switchLanguage}>{t('答案 · {lang}', { lang: speechProfile.answerLanguage==='en-US'?'English':speechProfile.answerLanguage==='follow'?t('跟随'):speechProfile.answerLanguage==='yue-HK'?t('粤语'):t('中文') })}</DwellButton>
              <DwellButton
                id="chat-toggle"
                variant={started && engine.status !== 'paused' ? 'muted' : 'primary'}
                hoverMs={HOVER_MS.action}
                onTrigger={() => {
                  if (!started || engine.status === 'error') {
                    // 会话没建起来时（如创建失败/被清理）先补建，再开始收音。
                    if (!engine.sessionId) void bootInterviewSession(bootAbort?.signal).catch(error => {
                      if (!bootAbort?.signal.aborted) reportInterviewError(error);
                    });
                    else void beginListening(configuredSource);
                  } else if (engine.status === 'paused') {
                    void resumeListening();
                  } else {
                    void pauseListening();
                  }
                }}
              >
                {engine.status === 'error' ? t('重试收音') : !started ? t('开始') : engine.status === 'paused' ? t('继续') : t('暂停')}
              </DwellButton>
              <DwellButton id="chat-transcribe" variant="muted" hoverMs={HOVER_MS.action} onTrigger={() => flushUtterance()} disabled={engine.audio.recognitionMode === 'realtime'}>
                {engine.audio.recognitionMode === 'realtime' ? t('自动断句') : t('立即转写')}
              </DwellButton>
              <DwellButton
                id="chat-answer"
                variant="primary"
                hoverMs={HOVER_MS.action}
                hotkey={hotkeys.answer}
                onTrigger={() => {
                  const lastQ = lastInterviewer(engine.messages);
                  if (lastQ) void answerQuestion(lastQ);
                }}
              >
                {t('立即回答')}
              </DwellButton>
              <DwellButton
                id="chat-screenshot"
                variant="muted"
                hoverMs={HOVER_MS.capture}
                hotkey={hotkeys.capture}
                disabled={!engine.sessionId || engine.status==='ended'}
                onTrigger={() => void captureQuestion()}
              >
                <span className="flex items-center gap-1"><Camera size={12}/>{t('截图提问')}</span>
              </DwellButton>
            </div>
            <VoiceAskRow kind="chat" hotkey={hotkeys['voice-ask']} />
          </>
        ) : (
          <SolverActions solver={solver} hotkeys={hotkeys} onBack={() => setTab('chat')} />
        )}
      </div>
      {preview ? null : null}
    </div>
  );
}

function AudioInputFeedback({ engine }: { engine: EngineState }) {
  const [now, setNow] = useState(Date.now());
  const startedAt = useRef(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const audio = engine.audio;
  const active = engine.status === 'listening' || engine.status === 'answering';
  const noInput = active && now - (audio.lastInputAt || startedAt.current) > 6000;
  const label = engine.status === 'connecting' ? t('正在连接音频设备…')
    : engine.status === 'paused' ? t('收音已暂停')
      : engine.status === 'error' ? t('收音不可用')
        : !active ? t('收音未启动')
          : audio.realtimeState === 'reconnecting' ? t('语音重连中…')
          : audio.speaking ? audio.recognitionMode === 'realtime' ? t('正在实时识别') : t('正在收音 · {s} 秒', { s: (audio.bufferedMs / 1000).toFixed(1) })
            : audio.pending ? (audio.pending > 1 ? t('正在转写（{n} 段）…', { n: audio.pending }) : t('正在转写…'))
              : audio.bufferedMs ? t('已收音，等待停顿后转写')
                : audio.lastTranscriptAt ? t('转写已完成，等待继续说话') : t('等待说话');
  return (
    <div className="ov-text-3 px-1 text-[10px]" data-testid="audio-input-feedback">
      <div className="ov-text-2 flex items-center gap-1.5"><Mic size={10} className="shrink-0 opacity-50" /><span className="min-w-0 flex-1 truncate" title={audio.deviceLabel}>{audio.source === 'SPEAKER' ? (audio.deviceLabel ? t('系统声音 · {label}', { label: audio.deviceLabel }) : t('系统声音')) : audio.deviceLabel || t('麦克风')}</span><span role="status" className="shrink-0">{label}</span></div>
      {noInput && <div className="ov-text-2 mt-1">{t('尚未收到音频数据，请暂停后继续，或返回工作台检查输入设备。')}</div>}

    </div>
  );
}

function lastInterviewer(messages: EngineState['messages']): string | null {
  messages=messages.filter(m=>!m.metadata?.speaker||m.metadata.speaker.role==='interviewer');
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'INTERVIEWER') return messages[i].text;
  }
  return null;
}

function statusOf(engine: EngineState): { text: string; live: boolean } {
  switch (engine.status) {
    case 'connecting':
      return { text: t('连接中'), live: false };
    case 'listening':
      return { text: t('聆听中'), live: true };
    case 'answering':
      return { text: t('生成回答'), live: true };
    case 'paused':
      return { text: t('已暂停'), live: false };
    case 'error':
      return { text: engine.errorMessage ? t('出错') : t('连接已断开'), live: false };
    case 'ended':
      return { text: t('会话已结束'), live: false };
    default:
      return { text: t('待开始'), live: false };
  }
}

/** 对话视图：转写（左竖线）+ AI 答案（markdown 流式），newestFirst/answerFirst */
function ChatView({ engine, hotkeys }: { engine: EngineState; hotkeys: Record<ActionKey, string> }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // 作答进度：思维链阶段没有任何别的 UI 更新，靠这个 1 秒的定时重渲染让秒表走起来。
  const answering = engine.status === 'answering';
  const [, bumpAnswerClock] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!answering) return;
    const id = window.setInterval(bumpAnswerClock, 1000);
    return () => window.clearInterval(id);
  }, [answering]);
  const progress = engine.answerProgress;
  const progressNow = progress.lastDataAt || progress.startedAt || 0;
  const answerElapsedSec = progress.startedAt ? Math.max(0, Math.floor((Date.now() - progress.startedAt) / 1000)) : 0;
  const answerQuietSec = progressNow ? Math.max(0, Math.floor((Date.now() - progressNow) / 1000)) : answerElapsedSec;
  const newestFirst = useSetting('interview.newestFirst', false)[0];
  const answerFirst = useSetting('interview.answerFirst', false)[0];
  const followNewRound = useSetting('interview.followNewRound', true)[0];
  const followStreaming = useSetting('interview.followStreaming', false)[0];
  const following = useRef(true);
  const {interactive,toggleInteractive}=usePlatform();
  const [editingQuestion,setEditingQuestion]=useState<{id:string;text:string}|null>(null);

  useEffect(() => {
    registerOverlayList(listRef.current);
    return () => registerOverlayList(null);
  }, []);

  // 自动跟随：新回合 / 流式
  useEffect(() => {
    const el = listRef.current;
    if (!el || !followNewRound || !following.current) return;
    const live = el.querySelector('[data-testid=live-transcript]:last-child');
    const anchor = live ?? el.querySelector('[data-overlay-scroll-anchor]');
    if (anchor) {
      anchor.scrollIntoView({ block: live ? 'end' : 'start' });
    }
  }, [engine.messages.length, engine.liveTranscripts.length, followNewRound]);

  useEffect(() => {
    if (!followStreaming || !following.current) return;
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) {
      el.scrollTop = el.scrollHeight;
    }
  }, [engine.messages, followStreaming]);

  // 回合分组：面试官消息开新组
  const groups: EngineState['messages'][] = [];
  for (const m of engine.messages) {
    if (m.role === 'INTERVIEWER' || groups.length === 0) {
      groups.push([m]);
    } else {
      groups[groups.length - 1].push(m);
    }
  }
  const ordered = newestFirst ? [...groups].reverse() : groups;

  return (
    <>
      <ScrollEdgePillProxy id="scroll-up" direction="up" label={t('悬停回看')} hotkey={hotkeys['scroll-up']} />
      <div ref={listRef} onScroll={() => {
        const el = listRef.current;
        if (el) following.current = newestFirst ? el.scrollTop < 160 : el.scrollHeight - el.scrollTop - el.clientHeight < 160;
      }} className="min-h-0 flex-1 overflow-y-auto px-1">
        {engine.messages.length === 0 && engine.partial === '' && engine.liveTranscripts.length === 0 ? (
          <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="ov-text text-[13px] font-medium">
              {engine.status === 'connecting'
                ? t('正在连接面试会话…')
                : engine.status === 'idle'
                  ? t('点下方「开始」进入聆听')
                  : engine.status === 'paused' ? t('收音已暂停')
                    : engine.status === 'error' ? t('收音遇到问题，请查看上方提示')
                      : engine.audio.source === 'SPEAKER' ? t('正在聆听面试官') : t('请对着麦克风说话')}
            </div>
            <div className="ov-text-2 text-[11px] opacity-80">
              {engine.audio.recognitionMode === 'segmented' ? t('说话过程中更新字幕，定稿后生成参考答案') : t('停顿后显示识别文字，开启自动回答后生成参考答案')}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {ordered.map((group, gi) => {
              const msgs = answerFirst && newestFirst ? [...group].reverse() : group;
              const isLatest = newestFirst ? gi === 0 : gi === ordered.length - 1;
              return (
                <div key={gi} className="flex flex-col gap-1.5" data-overlay-scroll-anchor={isLatest || undefined}>
                  {msgs.map((m) =>
                    m.role === 'INTERVIEWER' ? (
                      <div
                        key={m.id}
                        className="ov-line-strong ov-text-2 ov-body-sm flex items-start gap-1 whitespace-pre-wrap border-l-2 pl-1.5"
                      >
                        <div className="min-w-0 flex-1">{m.text}
                          {m.metadata?.origin==='screenshot'&&<span className="ov-text-3 ml-2 text-[10px]">{t('屏幕题目')}</span>}
                          {m.metadata?.speaker&&<SpeakerIdentity message={m}/>}
                          {m.metadata?.translation&&<div className="ov-text-3 mt-1 text-xs">{m.metadata.translation.text||m.metadata.translation.error}</div>}
                          {m.metadata?.superseded ? <span className="ov-text-3 ml-2 text-[10px]">{t('已更正')}</span> : (!m.metadata?.speaker||m.metadata.speaker.role==='interviewer')&&<DwellButton id={`correct-${m.id}`} compact hoverMs={1200} onTrigger={()=>{if(!interactive)toggleInteractive();setEditingQuestion({id:m.id,text:m.text});}}>{t('更正并重答')}</DwellButton>}
                        </div>
                      </div>
                    ) : (
                      <div key={m.id} className="ov-text ov-body relative">
                        {m.metadata?.superseded && <div className="ov-text-3 mb-1 text-[10px]">{t('更正前的参考答案')}</div>}
                        {m.metadata?.origin==='candidate_response' && <div className="ov-text-3 text-[10px]">{t('我的实际回答')}</div>}
                        <Md text={m.text} />
                        {m.metadata?.speaker&&<SpeakerIdentity message={m}/>}
                        {m.metadata?.translation&&<div className="ov-text-3 mt-1 text-xs">{m.metadata.translation.text||m.metadata.translation.error}</div>}
                        {!m.pending && <GenerationDetails status={m.metadata?.completionStatus} request={m.metadata?.request}/>}
                        {!!m.metadata?.sources?.length && <DwellDisclosure id={`sources-${m.id}`} label={t('本轮参考资料')} className="ov-text-3 mt-1 text-[10px]">{m.metadata.sources.map(source=><div key={source.id} className="mt-1 whitespace-pre-wrap"><strong>{source.title} · {source.location}</strong><div>{source.excerpt}</div></div>)}</DwellDisclosure>}
                        {m.pending && (
                          <div className="mt-1">
                            <ThinkingLine
                              zoneId={`live-reasoning-${m.id}`}
                              elapsedSec={answerElapsedSec}
                              chars={progress.chars}
                              preview={progress.preview}
                              quietSec={answerQuietSec}
                            />
                          </div>
                        )}
                      </div>
                    ),
                  )}
                </div>
              );
            })}
            {engine.partial && (
              <div className="ov-line ov-text-2 ov-body-sm border-l-2 border-dashed pl-1.5 opacity-80">
                {engine.partial}
                <div className="ov-text-3 mt-0.5 text-[10px] opacity-70">
                  {t('短句确认中，稍后自动入列；也可点击「立即回答」')}
                </div>
              </div>
            )}
            {engine.liveTranscripts.map(draft => (
              <div key={draft.id} data-testid="live-transcript" data-phase={draft.phase} className="ov-line ov-text-2 ov-body-sm whitespace-pre-wrap border-l-2 border-dashed pl-1.5" aria-live="polite">
                {draft.text || (draft.phase === 'finalizing' ? t('正在校正整句…') : t('正在识别语音…'))}
                <div className="ov-text-3 mt-0.5 text-[10px]">{draft.phase === 'preview' ? t('实时字幕 · 尚未定稿，不触发回答') : draft.phase === 'finalizing' ? t('正在定稿…') : t('本段识别失败，请查看提示后重试')}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      {editingQuestion && <form className="ov-chip mx-1 mt-2 rounded-md border p-2" onSubmit={event=>{event.preventDefault();const target=editingQuestion;if(!target.text.trim())return;setEditingQuestion(null);void answerQuestion(target.text,{correction:true,questionMessageId:target.id});}}>
        <label className="ov-text-2 text-[11px]">{t('更正识别内容')}<textarea autoFocus className="ov-input mt-1 min-h-16 w-full rounded border bg-transparent p-1 text-xs" value={editingQuestion.text} onChange={event=>setEditingQuestion({...editingQuestion,text:event.target.value})}/></label>
        <div className="mt-1 flex gap-3 text-[11px]"><button type="submit" disabled={!editingQuestion.text.trim()}>{t('更正并重新回答')}</button><button type="button" onClick={()=>setEditingQuestion(null)}>{t('取消')}</button></div>
      </form>}
      <ScrollEdgePillProxy id="scroll-down" direction="down" label={t('悬停看新')} hotkey={hotkeys['scroll-down']} />
    </>
  );
}

/** 内嵌笔试答题视图 */
function SolverView({
  solver,
  onBack,
  hotkeys,
}: {
  solver: SolverState;
  onBack: () => void;
  hotkeys: Record<ActionKey, string>;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    registerOverlayList(listRef.current);
    return () => registerOverlayList(null);
  }, []);
  const last = solver.turns.find(turn=>turn.id===solver.selectedTurnId) || solver.turns[solver.turns.length - 1];
  return (
    <>
      <ScrollEdgePillProxy id="scroll-up" direction="up" label={t('悬停回看')} hotkey={hotkeys['scroll-up']} />
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1">
      {solver.turns.length === 0 ? (
        <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
          <div className="ov-text text-[13px] font-medium">{t('面试里的笔试助手')}</div>
          <div className="ov-text-2 text-[11px] opacity-80">
            {t('把题目摆到屏幕上，按「重新截屏」直接答；一屏放不下按「加页」一页页截完再一起发')}
          </div>
        </div>
      ) : (
        <div className="ov-text ov-body">
          <div className="mb-2 flex flex-wrap gap-1">{solver.turns.map((turn,index)=><DwellButton key={turn.id} id={`select-${turn.id}`} compact hoverMs={1200} onTrigger={()=>selectSolverTurn(turn.id)}>{index+1}{turn.parentTurnId?t(' · 追问'):t(' · 原题')}{turn.id===last?.id?' ✓':''}</DwellButton>)}</div>
          <Md text={last?.body ?? ''} />
          <GenerationDetails status={last?.completionStatus} request={last?.request}/>
        </div>
      )}
      {solver.statusText && (
        <div className="ov-text-2 mt-1 flex items-center gap-1.5 text-[11px]">
          <span className="ov-dot size-1.5 animate-pulse rounded-full" />
          {solver.statusText}
        </div>
      )}
      {solver.phase === 'done' && last && <div className="mt-2 flex flex-wrap gap-1.5">
        {[...new Set(last.followUpOptions)].slice(0,3).map((option,index)=><DwellButton key={option}
          id={`iv-suggested-${index}`} compact hoverMs={HOVER_MS.followUp} onTrigger={() => void followUp({message:option})}>{option}</DwellButton>)}
      </div>}
      <div className="mt-2 flex gap-1.5">
        <DwellButton id="sv-back" inline hoverMs={HOVER_MS.action} onTrigger={onBack}>
          <span className="flex items-center gap-1">
            <ArrowLeft size={11} />
            {t('返回对话')}
          </span>
        </DwellButton>
      </div>
      </div>
      <ScrollEdgePillProxy id="scroll-down" direction="down" label={t('悬停看新')} hotkey={hotkeys['scroll-down']} />
    </>
  );
}

/** solver 页动作条 */
function SolverActions({
  solver,
  hotkeys,
  onBack,
}: {
  solver: SolverState;
  hotkeys: Record<ActionKey, string>;
  onBack: () => void;
}) {
  const modeInfo = examModeInfo(solver.mode);
  const multiPage = solver.pendingScreenshots.length > 0;
  const solving =
    solver.phase === 'thinking' || solver.phase === 'streaming' || solver.phase === 'capturing';
  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        <DwellIconButton
          id="sv-back-bar"
          hoverMs={HOVER_MS.action}
          label={t('返回对话')}
          icon={<ArrowLeft size={12} />}
          onTrigger={onBack}
        />
        {multiPage ? (
          <DwellButton
            id="sv-send"
            variant="primary"
            hoverMs={HOVER_MS.sendPages}
            hotkey={hotkeys.answer}
            onTrigger={() => void solve()}
          >
            {t('发送 {n} 页', { n: solver.pendingScreenshots.length })}
          </DwellButton>
        ) : (
          <DwellButton
            id="sv-resolve"
            variant="primary"
            hoverMs={HOVER_MS.answer}
            hotkey={hotkeys.answer}
            onTrigger={() => void solve()}
          >
            {t('重新截屏')}
          </DwellButton>
        )}
        <DwellButton
          id="sv-addpage"
          variant="muted"
          hoverMs={HOVER_MS.addPage}
          hotkey={hotkeys.capture}
          onTrigger={() => void capturePage()}
        >
          {t('加页')}
        </DwellButton>
        <DwellButton
          id="sv-hold"
          variant="muted"
          hoverMs={HOVER_MS.action}
          onTrigger={() => {
            const lastBody = solver.turns[solver.turns.length - 1]?.body ?? '';
            const q = lastInterviewer(getInterviewEngineState().messages);
            void followUp({ message: `请结合面试官的最新问题继续作答：${q ?? ''}\n\n之前的答案：${mdToPlain(lastBody).slice(-1500)}` });
          }}
        >
          {t('接住追问')}
        </DwellButton>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <DwellButton
          id="sv-mode"
          variant="muted"
          hoverMs={HOVER_MS.mode}
          compact
          onTrigger={() => setSolverMode(nextExamMode(solver.mode))}
        >
          {modeInfo.shortLabel}
        </DwellButton>
        <DwellButton
          id="sv-fu1"
          variant="muted"
          compact
          hoverMs={HOVER_MS.followUp}
          onTrigger={() => void followUp({ message: '请更详细地解释这个解法的核心思路，以及为什么这样是最优的' })}
        >
          {t('详解')}
        </DwellButton>
        <DwellButton
          id="sv-fu2"
          variant="muted"
          compact
          hoverMs={HOVER_MS.followUp}
          onTrigger={() => void followUp({ message: '请给出另一种解法，要求同样是面试常见的经典写法' })}
        >
          {t('换解法')}
        </DwellButton>
        <DwellButton
          id="sv-fu3"
          variant="muted"
          compact
          hoverMs={HOVER_MS.followUp}
          onTrigger={() => void followUp({ intent: 'simplify' })}
        >
          {t('优化')}
        </DwellButton>
      </div>
      <VoiceAskRow kind="solver" hotkey={hotkeys['voice-ask']} />
      <span className="hidden">{solving}</span>
    </>
  );
}

/** 手动语音提问与自动收音互斥，点击开始，再点击结束并转写。 */
function VoiceAskRow({ kind, hotkey }: { kind: 'chat' | 'solver'; hotkey: string }) {
  const [recording, setRecording] = useState(false);
  const [opening, setOpening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState('');
  const deviceId = useSetting('interview.microphoneId', '')[0];
  const recorderRef = useRef<MicrophoneCapture | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const countRef = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const resumeSession = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const toggleRef = useRef<() => void>(() => {});
  // 热键与按钮共用同一套开始/结束逻辑。
  useEffect(() => bus.on('voice-ask:toggle', () => toggleRef.current()), []);
  const restore = () => {
    const state = getInterviewEngineState();
    const sessionId = resumeSession.current;
    resumeSession.current = null;
    if (sessionId && state.sessionId === sessionId && state.status === 'paused') void resumeListening();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
      void recorderRef.current?.close();
      recorderRef.current = null;
      restore();
    };
  }, []);

  const start = async () => {
    if (busy.current) return;
    busy.current = true; setOpening(true); setError('');
    try {
      const state = getInterviewEngineState();
      if (state.status === 'listening' || state.status === 'answering') {
        resumeSession.current = state.sessionId;
        await pauseListening();
      }
      chunksRef.current = []; countRef.current = 0;
      const capture = await openMicrophone({ deviceId, onPcm: pcm => {
        if (!alive.current) return;
        if (countRef.current + pcm.length <= 16000 * 60) { chunksRef.current.push(pcm); countRef.current += pcm.length; }
        else setError(t('录音已满 60 秒，请点击「结束并提问」。'));
      }, onError: message => {
        if (!alive.current) return;
        setError(message); setRecording(false);
        void recorderRef.current?.close(); recorderRef.current = null;
        busy.current = false; restore();
      } });
      if (!alive.current) { await capture.close(); return; }
      recorderRef.current = capture;
      setRecording(true);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
      restore();
    } finally { busy.current = false; if (alive.current) setOpening(false); }
  };

  const stop = async () => {
    const capture = recorderRef.current;
    if (!capture || busy.current) return;
    busy.current = true; recorderRef.current = null;
    await capture.close();
    setRecording(false); restore();
    const total = countRef.current;
    if (total < 8000) { setError(t('录音太短，请至少说半秒后再结束。')); busy.current = false; return; }
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunksRef.current) { pcm.set(chunk, offset); offset += chunk.length; }
    chunksRef.current = []; countRef.current = 0;
    setTranscribing(true);
    const controller = new AbortController(); request.current = controller;
    try {
      const text = await transcribeAudio(encodeWav(pcm), { signal: controller.signal,...(kind==='chat'?{lang:getSpeechProfile('interview').inputLanguage}:{}) });
      if (!alive.current || controller.signal.aborted) return;
      if (!text) { setError(t('本段未识别到有效文字，请靠近麦克风说完整一句话后稍作停顿。')); return; }
      if (kind === 'chat') await answerQuestion(text, { voiceAsk: true });
      else await followUp({ message: text });
    } catch (e) { if (alive.current && !controller.signal.aborted) setError(t('语音识别失败：{msg}', { msg: (e as Error).message })); }
    finally { busy.current = false; request.current = null; if (alive.current) setTranscribing(false); }
  };

  toggleRef.current = () => { if (busy.current) return; if (recording) void stop(); else void start(); };

  return (
    <div className="flex flex-col gap-1">
      <DwellButton id={`voice-ask-${kind}`} variant={recording ? 'primary' : 'muted'} hoverMs={HOVER_MS.voiceAsk} hotkey={hotkey}
        onTrigger={() => toggleRef.current()} disabled={opening || transcribing}>
        <span className="flex items-center gap-1">
          {recording ? <Square size={10} /> : <Mic size={11} />}
          {opening ? t('正在打开麦克风…') : transcribing ? t('识别中…') : recording ? t('结束并提问') : t('语音提问')}
        </span>
      </DwellButton>

      {error && <div role="alert" className="ov-text-2 px-1 text-[11px]">{error}</div>}
    </div>
  );
}

function PaletteBtn() {
  return <ConfirmPaletteButton id="iv-auto-palette" onApply={() => applyOverlayPalette('interview')} />;
}

function SpeakerIdentity({message}:{message:EngineState['messages'][number]}){
 const decision=message.metadata?.speaker;
 const update=(role:'candidate'|'interviewer')=>void markTranscriptSpeaker(message.id,role).catch(error=>showToast({type:'error',title:t('身份更正未完成'),description:String((error as Error).message||error)}));
 return <div className="ov-text-3 mt-1 flex flex-wrap items-center gap-2 text-[10px]"><span>{decision?.role==='candidate'?t('我'):decision?.role==='interviewer'?t('面试官'):t('身份待确认 · 不自动作答')}</span>{decision?.role!=='candidate'&&<DwellButton id={`speaker-me-${message.id}`} compact hoverMs={1000} onTrigger={()=>update('candidate')}>{t('这是我')}</DwellButton>}{decision?.role!=='interviewer'&&<DwellButton id={`speaker-peer-${message.id}`} compact hoverMs={1000} onTrigger={()=>update('interviewer')}>{t('面试官 · 作答')}</DwellButton>}</div>;
}

function EndButton({ onEnd }: { onEnd: () => void }) {
  const { interactive, registerZone, simulate } = usePlatform();
  const progress = useDwell('iv-end', HOVER_MS.endInterview, onEnd, { disabled: interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone('iv-end', refEl);
    return () => registerZone('iv-end', null);
  }, [refEl, registerZone]);
  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      title={t('结束面试')}
      aria-label={t('结束面试')}
      data-dwell-ms={HOVER_MS.endInterview}
      onClick={interactive && !simulate ? onEnd : undefined}
      className="ov-text-2 relative flex h-6 w-6 items-center justify-center rounded-md border border-dashed"
    >
      <Square size={11} />
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current opacity-25" />
      )}
    </button>
  );
}

/** ScrollEdgePill 代理 */
function ScrollEdgePillProxy(props: {
  id: string;
  direction: 'up' | 'down';
  label: string;
  hotkey?: string;
}) {
  return <ScrollEdgePill {...props} />;
}
