/*
 * 面试浮窗（原版 Yq/Zq/Aq/wq）：头部（拖拽/状态/剩余时长/穿透切换/结束）、
 * 对话视图（转写竖线气泡 + AI markdown 流式）、底部操作（开始/暂停/
 * 立即回答/笔试答题/语音提问）、内嵌笔试答题视图。文案对齐原版。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  ArrowLeft,
  Columns2,
  Mic,
  MousePointerClick,
  Palette,
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
import { Md, mdToPlain } from './Md';
import {
  DwellButton,
  DragHandle,
  HOVER_MS,
  ScrollEdgePill,
  registerOverlayList,
} from './widgets';
import { useDwell, usePlatform } from './platform';

let bootstrapping: Promise<void> | null = null;

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
    if (bootstrapping) return;
    const state = getInterviewEngineState();
    if (state.sessionId || state.status === 'connecting') return;
    const cfg = (
      window as unknown as { __ml_pendingConfig?: { goalId: string | null; resumeId: string | null; materialIds: string[]; audioSource: 'SPEAKER' | 'PHONE' | 'MICROPHONE' } }
    ).__ml_pendingConfig;
    bootstrapping = (async () => {
      const { getSetting } = await import('@/lib/store');
      type PendingCfg = {
        goalId: string | null;
        resumeId: string | null;
        materialIds: string[];
        audioSource: 'SPEAKER' | 'PHONE' | 'MICROPHONE';
      };
      const pending: PendingCfg | null =
        cfg ?? (getSetting<PendingCfg | null>('interview.pendingConfig', null) ?? null);
      if (!pending) return;
      // 已有进行中的会话（浮窗重载/重新显示）→ 恢复历史，不新建
      const storedId = getSetting<string | null>('interview.sessionId', null);
      if (storedId && resumeInterviewSession(storedId, pending.goalId, pending.resumeId)) {
        await beginListening(pending.audioSource ?? 'SPEAKER');
        return;
      }
      const session = await startInterview({
        goalId: pending.goalId,
        resumeId: pending.resumeId,
        materialIds: pending.materialIds ?? [],
        audioSource: pending.audioSource ?? 'SPEAKER',
      });
      if (getInterviewEngineState().sessionId !== session.id || getInterviewEngineState().status === 'ended') return;
      const { setSetting } = await import('@/lib/store');
      await setSetting('interview.sessionId', session.id);
      await beginListening(pending.audioSource ?? 'SPEAKER');
    })().catch((e) => {
      reportInterviewError(e);
    }).finally(() => { bootstrapping = null; });
  }, [preview]);

  return <InterviewShell skin={skin} preview={preview} />;
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
  const engine = useEngineState();
  const solver = useSolverState();
  const [tab, setTab] = useState<'chat' | 'solver'>('chat');
  const scheme = useSetting<HotkeyScheme>('overlay.hotkeyScheme', 'simple')[0];
  const customKeys = useSetting('overlay.actionHotkeys', {} as Partial<Record<ActionKey, string>>)[0];
  const hotkeys = effectiveHotkeys(scheme, customKeys);
  const { interactive, toggleInteractive, bindHotkey } = usePlatform();
  const isDark = skin.theme === 'dark';
  const configuredSource = useSetting<'SPEAKER' | 'PHONE' | 'MICROPHONE'>('interview.audioSource', 'SPEAKER')[0];

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
      setTab('solver');
      void solve();
    });
    return () => {
      offAnswer();
      offCapture();
    };
  }, [bindHotkey, tab, engine.messages, preview]);

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
        <button
          type="button"
          className="ov-text-2 flex h-6.5 w-6.5 items-center justify-center rounded-md"
          title={interactive ? '切回穿透模式' : '悬停或点击切到窗口模式'}
          onClick={() => toggleInteractive()}
        >
          {interactive ? <MousePointerClick size={13} /> : <Columns2 size={13} />}
        </button>
        {/* 一键配色 */}
        <PaletteBtn />
        {/* 结束面试 */}
        <EndButton
          onEnd={async () => {
            await endInterview(true);
            const { setSessionActive, hideOverlay, showMain } = await import('@/lib/bridge');
            await setSessionActive(false);
            await hideOverlay();
            await showMain();
          }}
        />
      </div>

      <AudioInputFeedback engine={engine} />
      {engine.contextSources.length > 0 && <details className="ov-panel rounded-md px-2 py-1 text-[10px]">
        <summary className="cursor-pointer">本次回答参考 {engine.contextSources.length} 段简历 / JD / 资料</summary>
        <div className="mt-1 max-h-32 overflow-y-auto space-y-2">{engine.contextSources.map(source => <div key={source.id}>
          <div className="font-medium">{source.title} · {source.location}</div><p className="whitespace-pre-wrap opacity-75">{source.excerpt}</p>
        </div>)}</div>
      </details>}
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
      <div className="flex flex-col gap-1.5">
        {tab === 'chat' ? (
          <>
            <div className="flex gap-1.5">
              <DwellButton
                id="chat-toggle"
                variant={started && engine.status !== 'paused' ? 'muted' : 'primary'}
                hoverMs={HOVER_MS.action}
                onTrigger={() => {
                  if (!started || engine.status === 'error') {
                    void beginListening(configuredSource);
                  } else if (engine.status === 'paused') {
                    void resumeListening();
                  } else {
                    void pauseListening();
                  }
                }}
              >
                {engine.status === 'error' ? '重试收音' : !started ? '开始' : engine.status === 'paused' ? '继续' : '暂停'}
              </DwellButton>
              <DwellButton id="chat-transcribe" variant="muted" hoverMs={HOVER_MS.action} onTrigger={() => flushUtterance()} disabled={engine.audio.recognitionMode === 'realtime'}>
                {engine.audio.recognitionMode === 'realtime' ? '自动断句' : '立即转写'}
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
                立即回答
              </DwellButton>
              <DwellButton
                id="chat-solver"
                variant="muted"
                hoverMs={HOVER_MS.capture}
                hotkey={hotkeys.capture}
                onTrigger={() => {
                  setTab('solver');
                  if (solver.turns.length === 0) void solve();
                }}
              >
                笔试答题
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
  const label = engine.status === 'connecting' ? '正在连接音频设备…'
    : engine.status === 'paused' ? '收音已暂停'
      : engine.status === 'error' ? '收音不可用'
        : !active ? '收音未启动'
          : audio.realtimeState === 'reconnecting' ? '语音重连中…'
          : audio.speaking ? audio.recognitionMode === 'realtime' ? '正在实时识别' : `正在收音 · ${(audio.bufferedMs / 1000).toFixed(1)} 秒`
            : audio.pending ? `正在转写${audio.pending > 1 ? `（${audio.pending} 段）` : ''}…`
              : audio.bufferedMs ? '已收音，等待停顿后转写'
                : audio.lastTranscriptAt ? '转写已完成，等待继续说话' : '等待说话';
  return (
    <div className="ov-panel rounded-md px-2 py-1.5 text-[10px]" data-testid="audio-input-feedback">
      <div className="ov-text-2 flex items-center gap-1.5"><Mic size={12} /><span className="min-w-0 flex-1 truncate" title={audio.deviceLabel}>{audio.source === 'SPEAKER' ? `系统声音${audio.deviceLabel ? ` · ${audio.deviceLabel}` : ''}` : audio.deviceLabel || '麦克风'}</span><span role="status" className="shrink-0">{label}</span></div>
      <div role="meter" aria-label="收音音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={active ? audio.level : 0} className="mt-1.5 h-1 overflow-hidden rounded-full bg-current/10">
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${active ? audio.level : 0}%` }} />
      </div>
      {noInput && <div className="ov-text-2 mt-1">尚未收到音频数据，请暂停后继续，或返回工作台检查输入设备。</div>}
      {active && !noInput && <div className="ov-text-3 mt-1">{audio.recognitionMode === 'realtime' ? '持续音频流 · 边说边更新字幕，句子定稿后回答' : audio.recognitionMode === 'segmented' ? '分段实时 · 约每 2.5 秒更新字幕，停顿后校正并回答' : '说完停顿后自动转写，也可点「立即转写」'}</div>}
    </div>
  );
}

function lastInterviewer(messages: EngineState['messages']): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'INTERVIEWER') return messages[i].text;
  }
  return null;
}

function statusOf(engine: EngineState): { text: string; live: boolean } {
  switch (engine.status) {
    case 'connecting':
      return { text: '连接中', live: false };
    case 'listening':
      return { text: '聆听中', live: true };
    case 'answering':
      return { text: '生成回答', live: true };
    case 'paused':
      return { text: '已暂停', live: false };
    case 'error':
      return { text: engine.errorMessage ? '出错' : '连接已断开', live: false };
    case 'ended':
      return { text: '会话已结束', live: false };
    default:
      return { text: '待开始', live: false };
  }
}

/** 对话视图：转写（左竖线）+ AI 答案（markdown 流式），newestFirst/answerFirst */
function ChatView({ engine, hotkeys }: { engine: EngineState; hotkeys: Record<ActionKey, string> }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const newestFirst = useSetting('interview.newestFirst', false)[0];
  const answerFirst = useSetting('interview.answerFirst', false)[0];
  const followNewRound = useSetting('interview.followNewRound', true)[0];
  const followStreaming = useSetting('interview.followStreaming', false)[0];

  useEffect(() => {
    registerOverlayList(listRef.current);
    return () => registerOverlayList(null);
  }, []);

  // 自动跟随：新回合 / 流式
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const live = el.querySelector('[data-testid=live-transcript]:last-child');
    const anchor = live ?? el.querySelector('[data-overlay-scroll-anchor]');
    if (followNewRound && anchor) {
      anchor.scrollIntoView({ block: live ? 'end' : 'start' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [engine.messages.length, engine.liveTranscripts.length, followNewRound]);

  useEffect(() => {
    if (!followStreaming) return;
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
      <ScrollEdgePillProxy id="scroll-up" direction="up" label="悬停回看" hotkey={hotkeys['scroll-up']} />
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1">
        {engine.messages.length === 0 && engine.partial === '' && engine.liveTranscripts.length === 0 ? (
          <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="ov-text text-[13px] font-medium">
              {engine.status === 'connecting'
                ? '正在连接面试会话…'
                : engine.status === 'idle'
                  ? '点下方「开始」进入聆听'
                  : engine.status === 'paused' ? '收音已暂停'
                    : engine.status === 'error' ? '收音遇到问题，请查看上方提示'
                      : engine.audio.source === 'SPEAKER' ? '正在聆听面试官' : '请对着麦克风说话'}
            </div>
            <div className="ov-text-2 text-[11px] opacity-80">
              {engine.audio.recognitionMode === 'segmented' ? '说话过程中更新字幕，定稿后生成参考答案' : '停顿后显示识别文字，开启自动回答后生成参考答案'}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {ordered.map((group, gi) => {
              const msgs = answerFirst && newestFirst ? [...group].reverse() : group;
              const isLatest = gi === ordered.length - 1;
              return (
                <div key={gi} className="flex flex-col gap-1.5" data-overlay-scroll-anchor={isLatest || undefined}>
                  {msgs.map((m) =>
                    m.role === 'INTERVIEWER' ? (
                      <div
                        key={m.id}
                        className="ov-line-strong ov-text-2 ov-body-sm flex items-start gap-1 whitespace-pre-wrap border-l-2 pl-1.5"
                      >
                        {m.text}
                      </div>
                    ) : (
                      <div key={m.id} className="ov-text ov-body relative">
                        <Md text={m.text} />
                        {m.pending && (
                          <span className="ov-text-3 mt-0.5 inline-block size-3 animate-spin rounded-full border border-current border-t-transparent" />
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
                  短句确认中，稍后自动入列；也可点击「立即回答」
                </div>
              </div>
            )}
            {engine.liveTranscripts.map(draft => (
              <div key={draft.id} data-testid="live-transcript" data-phase={draft.phase} className="ov-line ov-text-2 ov-body-sm whitespace-pre-wrap border-l-2 border-dashed pl-1.5" aria-live="polite">
                {draft.text || (draft.phase === 'finalizing' ? '正在校正整句…' : '正在识别语音…')}
                <div className="ov-text-3 mt-0.5 text-[10px]">{draft.phase === 'preview' ? '实时字幕 · 尚未定稿，不触发回答' : draft.phase === 'finalizing' ? '正在定稿…' : '本段识别失败，请查看提示后重试'}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <ScrollEdgePillProxy id="scroll-down" direction="down" label="悬停看新" hotkey={hotkeys['scroll-down']} />
    </>
  );
}

/** 内嵌笔试答题视图（原版 Iq） */
function SolverView({
  solver,
  onBack,
  hotkeys: _hotkeys,
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
  const last = solver.turns[solver.turns.length - 1];
  return (
    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1">
      {solver.turns.length === 0 ? (
        <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
          <div className="ov-text text-[13px] font-medium">面试里的笔试助手</div>
          <div className="ov-text-2 text-[11px] opacity-80">
            把题目摆到屏幕上，按「重新截屏」直接答；一屏放不下按「加页」一页页截完再一起发
          </div>
        </div>
      ) : (
        <div className="ov-text ov-body">
          <Md text={last?.body ?? ''} />
        </div>
      )}
      {solver.statusText && (
        <div className="ov-text-2 mt-1 flex items-center gap-1.5 text-[11px]">
          <span className="ov-dot size-1.5 animate-pulse rounded-full" />
          {solver.statusText}
        </div>
      )}
      <div className="mt-2 flex gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="ov-chip ov-text-2 flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]"
        >
          <ArrowLeft size={11} />
          返回对话
        </button>
      </div>
    </div>
  );
}

/** solver 页动作条（原版 Rq） */
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
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={onBack}
          className="ov-chip ov-text-2 flex h-9 items-center rounded-md border px-2 text-[12px]"
        >
          <ArrowLeft size={12} />
        </button>
        <DwellButton
          id="sv-resolve"
          variant="primary"
          hoverMs={HOVER_MS.answer}
          hotkey={hotkeys.answer}
          onTrigger={() => void solve()}
        >
          重新截屏
        </DwellButton>
        {multiPage ? (
          <DwellButton
            id="sv-send"
            variant="primary"
            hoverMs={HOVER_MS.sendPages}
            onTrigger={() => void solve()}
          >
            发送 {solver.pendingScreenshots.length} 页
          </DwellButton>
        ) : (
          <DwellButton
            id="sv-addpage"
            variant="muted"
            hoverMs={HOVER_MS.addPage}
            hotkey={hotkeys.capture}
            onTrigger={() => void capturePage()}
          >
            加页
          </DwellButton>
        )}
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
          接住追问
        </DwellButton>
      </div>
      <div className="flex gap-1.5">
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
          详解
        </DwellButton>
        <DwellButton
          id="sv-fu2"
          variant="muted"
          compact
          hoverMs={HOVER_MS.followUp}
          onTrigger={() => void followUp({ message: '请给出另一种解法，要求同样是面试常见的经典写法' })}
        >
          换解法
        </DwellButton>
        <DwellButton
          id="sv-fu3"
          variant="muted"
          compact
          hoverMs={HOVER_MS.followUp}
          onTrigger={() => void followUp({ intent: 'simplify' })}
        >
          优化
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
  const [level, setLevel] = useState(0);
  const deviceId = useSetting('interview.microphoneId', '')[0];
  const recorderRef = useRef<MicrophoneCapture | null>(null);
  const chunksRef = useRef<Int16Array[]>([]);
  const countRef = useRef(0);
  const busy = useRef(false);
  const alive = useRef(true);
  const resumeSession = useRef<string | null>(null);
  const request = useRef<AbortController | null>(null);
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
      let lastMeter = 0;
      const capture = await openMicrophone({ deviceId, onPcm: (pcm, volume) => {
        if (!alive.current) return;
        if (countRef.current + pcm.length <= 16000 * 60) { chunksRef.current.push(pcm); countRef.current += pcm.length; }
        else setError('录音已满 60 秒，请点击「结束并提问」。');
        if (performance.now() - lastMeter > 100) { lastMeter = performance.now(); setLevel(Math.min(100, Math.round(volume / 80 * 100))); }
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
    setRecording(false); setLevel(0); restore();
    const total = countRef.current;
    if (total < 8000) { setError('录音太短，请至少说半秒后再结束。'); busy.current = false; return; }
    const pcm = new Int16Array(total);
    let offset = 0;
    for (const chunk of chunksRef.current) { pcm.set(chunk, offset); offset += chunk.length; }
    chunksRef.current = []; countRef.current = 0;
    setTranscribing(true);
    const controller = new AbortController(); request.current = controller;
    try {
      const text = await transcribeAudio(encodeWav(pcm), { signal: controller.signal });
      if (!alive.current || controller.signal.aborted) return;
      if (!text) { setError('没有识别到文字，请检查音量条后重试。'); return; }
      if (kind === 'chat') await answerQuestion(text, { voiceAsk: true });
      else await followUp({ message: text });
    } catch (e) { if (alive.current && !controller.signal.aborted) setError(`语音识别失败：${(e as Error).message}`); }
    finally { busy.current = false; request.current = null; if (alive.current) setTranscribing(false); }
  };

  return (
    <div className="flex flex-col gap-1">
      <DwellButton id={`voice-ask-${kind}`} variant={recording ? 'primary' : 'muted'} hoverMs={HOVER_MS.voiceAsk} hotkey={hotkey}
        onTrigger={() => { if (busy.current) return; if (recording) void stop(); else void start(); }} disabled={opening || transcribing}>
        <span className="flex items-center gap-1">
          {recording ? <Square size={10} /> : <Mic size={11} />}
          {opening ? '正在打开麦克风…' : transcribing ? '识别中…' : recording ? '结束并提问' : '语音提问'}
        </span>
      </DwellButton>
      {recording && <div role="meter" aria-label="语音提问音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} className="h-1 overflow-hidden rounded-full bg-current/10"><div className="h-full bg-emerald-500" style={{ width: `${level}%` }} /></div>}
      {error && <div role="alert" className="ov-text-2 px-1 text-[11px]">{error}</div>}
    </div>
  );
}

function PaletteBtn() {
  const { interactive, registerZone } = usePlatform();
  const progress = useDwell('iv-auto-palette', HOVER_MS.palette, () => void applyIvPalette(), {
    disabled: interactive,
  });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone('iv-auto-palette', refEl);
    return () => registerZone('iv-auto-palette', null);
  }, [refEl, registerZone]);
  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      className="ov-text-2 relative flex h-6 w-6 items-center justify-center rounded-md"
      title="一键配色：按浮窗背后的画面自动换一身配色"
      onClick={interactive ? () => void applyIvPalette() : undefined}
    >
      <Palette size={13} />
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[2px]" style={{ width: `${progress * 100}%` }} />
      )}
    </button>
  );
}

async function applyIvPalette() {
  const { captureScreen } = await import('@/lib/bridge');
  const doc = document.documentElement;
  try {
    doc.classList.add('ov-palette-capturing');
    await new Promise((r) => setTimeout(r, 150));
    const shot = await captureScreen({ protectedOnTop: true });
    doc.classList.remove('ov-palette-capturing');
    doc.classList.add('ov-palette-fade');
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = shot;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 64 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (data) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const { getSetting, setSetting } = await import('@/lib/store');
      const current = normalizeStyle(getSetting('overlay.style', DEFAULT_OVERLAY_STYLE));
      setSetting('overlay.style', {
        ...current,
        paletteBg: hex,
        paletteFg: lum > 0.4 ? '#0f172a' : '#f8fafc',
        theme: lum > 0.4 ? 'light' : 'dark',
      });
    }
    window.setTimeout(() => doc.classList.remove('ov-palette-fade'), 1500);
  } catch {
    doc.classList.remove('ov-palette-capturing');
  }
}

function EndButton({ onEnd }: { onEnd: () => void }) {
  const { interactive, registerZone } = usePlatform();
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
      title="结束面试"
      onClick={interactive ? onEnd : undefined}
      className="ov-text-2 relative flex h-6 w-6 items-center justify-center rounded-md border border-dashed"
    >
      <Square size={11} />
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[2px]" style={{ width: `${progress * 100}%` }} />
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
