import { getAiSettings } from './aiSettings';
import { isRoleConfigured, resolveAiRoute } from './aiConfig';
/*
 * 面试引擎：本地实现原版的「采集 → 分句 → 转写 → AI 作答」管线。
 * - SPEAKER：原生 system-audio-chunk 事件（PCM16/16k/mono base64）；
 * - PHONE / MICROPHONE：getUserMedia 麦克风（脚本处理器降采样到 16k）。
 * - 静音门限 silenceGateMs（300-6000，默认 1600；未说完句 +800ms）分句；
 * - STT 走配置的 /audio/transcriptions；作答走 chat/completions 流式。
 * 状态通过 subscribe 供浮窗渲染。
 */
import { listenEvent } from './bridge';
import {
  buildInterviewSystemPrompt,
  chatStream,
  transcribeAudio,
  liveSpeechEnabled,
  type AnswerStyle,
} from './ai';
import {
  ChatMessage,
  Goal,
  InterviewSession,
  Material,
  Resume,
  createSession,
  readData,
  completeSession,
  updateSession,
} from './backend';
import { getSetting } from './store';
import { bus } from './events';
import { openMicrophone, type MicrophoneCapture } from './microphone';
import { joinTranscript } from './speechProtocol';
import { buildKnowledgeContext, type ContextSource } from './knowledgeContext';
import type { RealtimeCapture } from './realtimeAsr';

export interface LiveTranscript { id: number; text: string; phase: 'preview' | 'finalizing' | 'failed' }

export type AudioSource = 'SPEAKER' | 'PHONE' | 'MICROPHONE';
export interface AudioInputState {
  source: AudioSource;
  deviceLabel: string;
  level: number;
  speaking: boolean;
  bufferedMs: number;
  pending: number;
  lastInputAt: number;
  lastTranscriptAt: number;
  recognitionMode: 'file' | 'segmented' | 'realtime';
  realtimeState?: 'connecting' | 'ready' | 'reconnecting' | 'closed';
  previewing: boolean;
}
const emptyAudio = (): AudioInputState => ({ source: 'SPEAKER', deviceLabel: '', level: 0, speaking: false, bufferedMs: 0, pending: 0, lastInputAt: 0, lastTranscriptAt: 0, recognitionMode: 'file', previewing: false });

export type EngineStatus =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'answering'
  | 'paused'
  | 'ended'
  | 'error';

export interface InterviewTurn {
  id: string;
  interviewer: string;
  answer: string;
  answerPending: boolean;
  startedAt: number;
  /** 生成中取消 */
  abort?: AbortController;
}

export interface EngineState {
  contextSources: ContextSource[];
  liveTranscripts: LiveTranscript[];
  audio: AudioInputState;
  status: EngineStatus;
  errorMessage: string | null;
  sessionId: string | null;
  /** STT 实时句（未定稿） */
  partial: string;
  /** 定稿的历史消息流（INTERVIEWER/ASSISTANT） */
  messages: ChatMessage[];
  turns: InterviewTurn[];
  /** 服务/配置不可用提示 */
  aiDown: boolean;
  /** 当前会话的目标岗位 / 简历 / 资料 */
  goalId: string | null;
  resumeId: string | null;
  materialIds: string[];
}

let state: EngineState = {
  contextSources: [],
  liveTranscripts: [],
  audio: emptyAudio(),
  status: 'idle',
  errorMessage: null,
  sessionId: null,
  partial: '',
  messages: [],
  turns: [],
  aiDown: false,
  goalId: null,
  resumeId: null,
  materialIds: [],
};

const listeners = new Set<() => void>();
function setState(patch: Partial<EngineState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function getInterviewEngineState(): EngineState {
  return state;
}

/** 诊断钩子（CDP 验证用）：把引擎与音频缓冲暴露到 window */
export function exposeEngineDebug() {
  const w = window as unknown as {
    __ml_engine?: () => EngineState;
    __ml_audio?: () => { buffered: number; speechStarted: boolean; lastVoiceAgoMs: number };
  };
  w.__ml_engine = () => state;
  w.__ml_audio = () => ({
    buffered: audioBuf.length,
    speechStarted,
    lastVoiceAgoMs: lastVoiceAt ? Math.round(performance.now() - lastVoiceAt) : -1,
  });
}

export function subscribeEngine(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------------- 音频缓冲与静音分句 ----------------

interface AudioRing {
  samples: Int16Array;
  length: number;
}

let audioBuf: AudioRing = { samples: new Int16Array(16000 * 30), length: 0 };
let lastVoiceAt = 0;
let speechStarted = false;
let voicedMs = 0;
const MIN_VOICED_MS = 250;
const VOLUME_ON_THRESHOLD = 12; // 原版音量公式 avg|x|*800，静音阈值 15 略放宽
const PREVIEW_SAMPLES = 16000 * 2.5;
let utteranceSequence = 0;
interface LiveUtterance { id: number; offset: number; nextPreview: number; prefix: string; controller?: AbortController }
let currentUtterance: LiveUtterance | null = null;
function updateLive(id: number, patch: Partial<Omit<LiveTranscript, 'id'>>) {
  const previous = state.liveTranscripts.find(draft => draft.id === id);
  const draft: LiveTranscript = { id, text: '', phase: 'preview', ...previous, ...patch };
  setState({ liveTranscripts: previous ? state.liveTranscripts.map(item => item.id === id ? draft : item) : [...state.liveTranscripts, draft],
    audio: { ...state.audio, previewing: !!currentUtterance?.controller } });
}
function removeLive(id: number) {
  setState({ liveTranscripts: state.liveTranscripts.filter(draft => draft.id !== id) });
}

function resetAudio() {
  audioBuf = { samples: new Int16Array(16000 * 30), length: 0 };
  lastVoiceAt = 0;
  speechStarted = false;
  voicedMs = 0;
  currentUtterance = null;
  setState({ liveTranscripts: [], partial: '', audio: { ...state.audio, previewing: false } });
  if (gateCheckTimer !== null) {
    window.clearInterval(gateCheckTimer);
    gateCheckTimer = null;
  }
}

function pushPcm(pcm: Int16Array, volume: number) {
  if (state.status !== 'listening' && state.status !== 'answering') return;
  const now = performance.now();
  if (state.audio.recognitionMode === 'realtime') {
    realtimeCapture?.push(pcm);
    if (now - lastMeterAt >= 100) {
      lastMeterAt = now;
      setState({ audio: { ...state.audio, level: Math.min(100, Math.round(volume / 80 * 100)),
        speaking: volume >= VOLUME_ON_THRESHOLD, lastInputAt: Date.now(), bufferedMs: 0 } });
    }
    return;
  }
  if (volume >= VOLUME_ON_THRESHOLD) {
    voicedMs += pcm.length / 16;
    lastVoiceAt = now;
    if (!speechStarted) {
      speechStarted = true;
      if (state.audio.recognitionMode === 'segmented') currentUtterance = { id: ++utteranceSequence, offset: 0, nextPreview: PREVIEW_SAMPLES, prefix: '' };
    }
  }
  if (currentUtterance && voicedMs >= MIN_VOICED_MS && audioBuf.length >= currentUtterance.nextPreview && !currentUtterance.controller) {
    void previewUtterance(currentUtterance);
  }
  // 只要有声音（或说话后的静音窗内）就累积 PCM
  if (speechStarted) {
    const i16 = pcm;
    if (audioBuf.length + i16.length > audioBuf.samples.length) {
      // 溢出：丢弃最旧的一半
      audioBuf.samples.copyWithin(0, audioBuf.length - (audioBuf.samples.length - i16.length));
      audioBuf.length = audioBuf.samples.length - i16.length;
    }
    audioBuf.samples.set(i16, audioBuf.length);
    audioBuf.length += i16.length;
  }
  if (now - lastMeterAt >= 100) {
    lastMeterAt = now;
    setState({ audio: { ...state.audio, level: Math.min(100, Math.round(volume / 80 * 100)), speaking: volume >= VOLUME_ON_THRESHOLD, bufferedMs: Math.round(audioBuf.length / 16), lastInputAt: Date.now() } });
  }
  // Bound each request without discarding the beginning of long answers.
  if (audioBuf.length >= 16000 * 20) void finalizeUtterance();
  scheduleGateCheck();
}
let lastMeterAt = 0;
let captureGeneration = 0;
let sessionGeneration = 0;
let transcriptionQueue = Promise.resolve();
const transcriptionControllers = new Set<AbortController>();

async function previewUtterance(utterance: LiveUtterance) {
  const generation = captureGeneration;
  const end = audioBuf.length;
  // Only send the new window with 200ms of boundary context, rather than retransmitting growing prefixes.
  const wav = encodeWavFromPcm(audioBuf.samples.slice(Math.max(0, utterance.offset - 3200), end));
  const controller = new AbortController();
  utterance.controller = controller;
  transcriptionControllers.add(controller);
  let text = '';
  updateLive(utterance.id, { phase: 'preview' });
  try {
    const result = await transcribeAudio(wav, { lang: interviewLang(), signal: controller.signal, onDelta: delta => {
      if (generation !== captureGeneration || controller.signal.aborted) return;
      text += delta;
      updateLive(utterance.id, { text: joinTranscript(utterance.prefix, text) });
    } });
    if (generation !== captureGeneration || controller.signal.aborted) return;
    utterance.prefix = joinTranscript(utterance.prefix, result);
    utterance.offset = end;
    utterance.nextPreview = end + PREVIEW_SAMPLES;
    updateLive(utterance.id, { text: utterance.prefix });
  } catch (error) {
    if (generation !== captureGeneration || controller.signal.aborted) return;
    utterance.nextPreview = audioBuf.length + PREVIEW_SAMPLES;
    updateLive(utterance.id, { phase: 'failed' });
    setState({ errorMessage: `字幕预览失败，停顿后将重试整句识别：${(error as Error).message}` });
  } finally {
    transcriptionControllers.delete(controller);
    if (utterance.controller === controller) utterance.controller = undefined;
    if (generation === captureGeneration) setState({ audio: { ...state.audio, previewing: !!currentUtterance?.controller } });
  }
}

export function reportInterviewError(error: unknown) {
  setState({ status: 'error', errorMessage: String((error as Error)?.message ?? error), audio: { ...state.audio, level: 0, speaking: false } });
}

function effectiveGateMs(): number {
  const base = getSetting('interview.silenceGateMs', 1600);
  // 半句明显没说完时 +800ms（原版 Pv/Fv：句尾逗号或连接词）
  const p = state.partial;
  const unfinished = /[，、；：]$/.test(p) || /(那个|这个|就是|然后|因为|所以|比如|还有|emm+|嗯+)$/i.test(p.trim());
  return base + (unfinished ? 800 : 0);
}

let gateCheckTimer: number | null = null;
export function flushUtterance() {
  if (state.audio.recognitionMode === 'realtime') return;
  if (state.status !== 'listening' && state.status !== 'answering') return;
  if (audioBuf.length < 1600) {
    setState({ errorMessage: '还没有收到足够的语音，请先说一句话，并查看上方音量条是否跳动。' });
    return;
  }
  finalizeUtterance();
}

function scheduleGateCheck() {
  if (gateCheckTimer) return;
  gateCheckTimer = window.setInterval(() => {
    if (state.status !== 'listening' && state.status !== 'answering') return;
    if (!speechStarted) return;
    const now = performance.now();
    if (now - lastVoiceAt >= effectiveGateMs()) {
      finalizeUtterance();
    }
  }, 250);
}

function finalizeUtterance() {
  const live = currentUtterance;
  currentUtterance = null;
  live?.controller?.abort();
  const pcm = audioBuf.samples.slice(0, audioBuf.length);
  audioBuf.length = 0;
  const durationMs = (pcm.length / 16000) * 1000;
  speechStarted = false;
  const enoughVoice = voicedMs >= MIN_VOICED_MS;
  voicedMs = 0;
  if (!enoughVoice || pcm.length < 1600 || durationMs < 100) {
    if (live) removeLive(live.id);
    setState({ partial: '', audio: { ...state.audio, bufferedMs: 0, speaking: false } });
    return;
  }
  if (state.audio.pending >= 3) {
    if (live) removeLive(live.id);
    setState({ errorMessage: '语音转写服务处理较慢，本段未发送。请暂停说话，等待转写完成后重试。' });
    return;
  }
  const generation = captureGeneration;
  const wavBlob = encodeWavFromPcm(pcm);
  if (live) updateLive(live.id, { phase: 'finalizing' });
  setState({ audio: { ...state.audio, bufferedMs: 0, speaking: false, pending: state.audio.pending + 1 } });
  transcriptionQueue = transcriptionQueue.then(async () => {
    if (generation !== captureGeneration) return;
    const controller = new AbortController();
    transcriptionControllers.add(controller);
    try { await recognizeUtterance(wavBlob, controller, generation, live?.id); }
    finally {
      transcriptionControllers.delete(controller);
      if (generation === captureGeneration) setState({ audio: { ...state.audio, pending: Math.max(0, state.audio.pending - 1) } });
    }
  }).catch(error => { if (generation === captureGeneration) reportInterviewError(error); });
}

async function recognizeUtterance(wavBlob: Blob, controller: AbortController, generation: number, liveId?: number) {
  let text = '';
  let streamed = '';
  try {
    text = await transcribeAudio(wavBlob, { lang: interviewLang(), signal: controller.signal, onDelta: delta => {
      if (liveId === undefined || generation !== captureGeneration || controller.signal.aborted) return;
      streamed += delta;
      updateLive(liveId, { text: streamed, phase: 'finalizing' });
    } });
  } catch (e) {
    if (generation !== captureGeneration || controller.signal.aborted) return;
    const msg = String((e as Error)?.message ?? e);
    if (liveId !== undefined) updateLive(liveId, { phase: 'failed' });
    setState({ errorMessage: `语音识别失败：${msg}` });
    return;
  }
  if (generation !== captureGeneration || controller.signal.aborted) return;
  if (liveId !== undefined) removeLive(liveId);
  setState({ errorMessage: null, audio: { ...state.audio, lastTranscriptAt: Date.now() } });
  text = cleanTranscript(text);
  if (!text || isFillerSentence(text)) {
    setState({ partial: '', errorMessage: '本段未识别到有效文字，请靠近麦克风说完整一句话后稍作停顿。' });
    return;
  }
  if (text.length < 6 && liveId === undefined) {
    setState({ partial: text });
    window.setTimeout(() => {
      if (generation === captureGeneration && state.partial === text) {
        setState({ partial: '' });
        void deliverUtterance(text);
      }
    }, 3000);
    return;
  }
  setState({ partial: '' });
  await deliverUtterance(text);
}

/** 分句定稿：入列 + 自动作答 */
async function deliverUtterance(text: string) {
  bus.emit('interviewer:utterance', text);
  const msg: ChatMessage = {
    id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    role: 'INTERVIEWER',
    text,
    createdAt: Date.now(),
  };
  const messages = [...state.messages, msg];
  setState({ messages });
  await persistMessages(messages);
  if (getSetting('interview.autoAnswer', true)) {
    if (state.sessionId) {
      if (answerQueue.length >= 8) {
        setState({ errorMessage: '待回答的问题较多，已保留转写文字；请等当前回答结束后手动选择问题。' });
      } else {
        answerQueue.push({ question: text, sessionId: state.sessionId });
        void drainAnswers();
      }
    }
  }
}

const answerQueue: { question: string; sessionId: string }[] = [];
let drainingAnswers = false;
async function drainAnswers() {
  if (drainingAnswers || state.turns.some(turn => turn.answerPending) || !['listening', 'answering'].includes(state.status)) return;
  drainingAnswers = true;
  try {
    while (answerQueue.length && ['listening', 'answering'].includes(state.status)) {
      const next = answerQueue.shift()!;
      if (next.sessionId === state.sessionId) await answerQuestion(next.question);
    }
  } finally { drainingAnswers = false; }
}

// ---------------- AI 作答 ----------------

function interviewLang(): string {
  const prefs = getSetting<Record<string, unknown>>('interviewPreference', {});
  return String(prefs.lang ?? 'zh-CN');
}

export async function answerQuestion(question: string, opts?: { correction?: boolean; voiceAsk?: boolean }) {
  if (state.turns.some((t) => t.answerPending)) {
    bus.emit('toast', { type: 'info', title: 'AI 正在回答，请等回答结束后再发送' });
    return;
  }
  const sessionId = state.sessionId;
  if (!sessionId) return;
  const turn: InterviewTurn = {
    id: `t${Date.now()}`,
    interviewer: question,
    answer: '',
    answerPending: true,
    startedAt: Date.now(),
    abort: new AbortController(),
  };
  const turns = [...state.turns, turn];
  setState({ turns, status: 'answering', aiDown: false });
  const assistantMsg: ChatMessage = {
    id: `m${Date.now()}a`,
    role: 'ASSISTANT',
    text: '',
    createdAt: Date.now(),
    pending: true,
  };
  const messages = [...state.messages, assistantMsg];
  setState({ messages });

  try {
    const { prompt, sources } = buildSystemPromptForSession(question);
    setState({ contextSources: sources });
    const history = state.messages
      .filter((m) => !m.pending)
      .slice(-12)
      .map((m) => ({
        role: (m.role === 'INTERVIEWER' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.text,
      }));
    const answer = await chatStream({
      messages: [
        { role: 'system', content: prompt },
        ...history,
        {
          role: 'user',
          content: opts?.correction
            ? `（识别有误，请按正确的题意重新回答）\n${question}`
            : question,
        },
      ],
      signal: turn.abort!.signal,
      onDelta: (delta) => {
        if (turn.abort?.signal.aborted || state.sessionId !== sessionId) return;
        const t = state.turns.find((x) => x.id === turn.id);
        const m = state.messages.find((x) => x.id === assistantMsg.id);
        if (m) {
          setState({
            messages: state.messages.map((x) =>
              x.id === assistantMsg.id ? { ...x, text: x.text + delta } : x,
            ),
          });
        }
        if (t) {
          setState({
            turns: state.turns.map((x) =>
              x.id === turn.id ? { ...x, answer: x.answer + delta } : x,
            ),
          });
        }
      },
    });
    if (turn.abort?.signal.aborted || state.sessionId !== sessionId) return;
    const finalMessages = state.messages.map((x) =>
      x.id === assistantMsg.id ? { ...x, text: answer || x.text, pending: false } : x,
    );
    setState({
      messages: finalMessages,
      turns: state.turns.map((x) => (x.id === turn.id ? { ...x, answer, answerPending: false } : x)),
      status: state.status === 'answering' ? 'listening' : state.status,
    });
    await persistMessages(finalMessages);
  } catch (e) {
    if (state.sessionId !== sessionId || state.status === 'ended') return;
    const err = e as Error;
    const aborted = err?.name === 'AbortError';
    if (!aborted) {
      setState({
        status: state.status === 'answering' ? 'listening' : state.status,
        aiDown: true,
        errorMessage: `AI 作答失败：${err.message || '请检查对话服务配置后重试'}`,
      });
      const finalMessages = state.messages.map((x) =>
        x.id === assistantMsg.id ? { ...x, pending: false, text: x.text || '（生成失败）' } : x,
      );
      setState({ messages: finalMessages });
      await persistMessages(finalMessages);
    } else {
      setState({ status: state.status === 'answering' ? 'listening' : state.status });
    }
  } finally {
    if (state.sessionId === sessionId) setState({ turns: state.turns.map(t => t.id === turn.id ? { ...t, answerPending: false } : t) });
    void drainAnswers();
  }
}

function buildSystemPromptForSession(question: string): { prompt: string; sources: ContextSource[] } {
  const prefs = getSetting<Record<string, never>>('interviewPreference', {} as never) as unknown as {
    answerStyle?: AnswerStyle;
    customAnswerStyle?: string;
  };
  const goalId = state.goalId;
  const goals = readData<Goal[]>('goals', []);
  const goal = goals.find((g) => g.id === goalId);
  const resumes = readData<Resume[]>('resumes', []);
  const resumeId = state.resumeId ?? resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id;
  const resume = resumes.find((r) => r.id === resumeId);
  const materials = readData<Material[]>('materials', []);
  const materialIds = state.materialIds ?? [];
  const chosen = materials.filter((m) => materialIds.includes(m.id));
  const context = buildKnowledgeContext({ resume, goal, materials: chosen, query: question });
  const prompt = buildInterviewSystemPrompt({
    answerStyle: prefs.answerStyle ?? 'natural',
    customAnswerStyle: prefs.customAnswerStyle ?? '',
    goalName: goal?.name,
    goalCompany: goal?.companyName,
    contextBlock: context.text,
    lang: interviewLang(),
  });
  return { prompt, sources: context.sources };
}

// ---------------- 会话生命周期 ----------------


export async function startInterview(opts: {
  goalId: string | null;
  resumeId: string | null;
  materialIds: string[];
  audioSource: 'SPEAKER' | 'PHONE' | 'MICROPHONE';
}): Promise<InterviewSession> {
  const generation = ++sessionGeneration;
  answerQueue.length = 0;
  const goals = readData<Goal[]>('goals', []);
  const goal = goals.find((g) => g.id === opts.goalId);
  const session = await createSession({
    type: 'INTERVIEW',
    title: `${goal?.name ?? '面试'} · ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    goalId: opts.goalId,
    resumeId: opts.resumeId,
    metadata: { audioSource: opts.audioSource, materialIds: opts.materialIds },
  });
  if (generation !== sessionGeneration) {
    await completeSession(session.id);
    return session;
  }
  setState({
    ...state,
    audio: { ...emptyAudio(), source: opts.audioSource },
    sessionId: session.id,
    status: 'connecting',
    errorMessage: null,
    partial: '',
    messages: [],
    contextSources: [],
    turns: [],
    aiDown: false,
    goalId: opts.goalId,
    resumeId: opts.resumeId,
    materialIds: opts.materialIds,
  });
  return session;
}

/**
 * 恢复已有会话（浮窗 webview 重载/重新显示时）：把历史消息接回引擎，
 * 避免问答记录在界面上丢失（数据本身持久化在 data.json）。
 */
export function resumeInterviewSession(sessionId: string, goalId: string | null, resumeId: string | null) {
  const sessions = readData<InterviewSession[]>('interviewSessions', []);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return false;
  sessionGeneration++;
  setState({
    ...state,
    sessionId,
    status: state.status === 'idle' || state.status === 'ended' ? 'connecting' : state.status,
    messages: session.messages ?? [],
    goalId,
    resumeId,
    materialIds: (session.metadata?.materialIds as string[] | undefined) ?? [],
  });
  return true;
}

let engineUnlistenChunk: (() => void) | null = null;
let engineUnlistenError: (() => void) | null = null;
let microphone: MicrophoneCapture | null = null;
let realtimeCapture: RealtimeCapture | null = null;
let realtimeOpening: AbortController | null = null;
let opening: Promise<void> | null = null;
let openingGeneration = 0;

async function stopCapture(invalidate = true) {
  if (invalidate) captureGeneration++;
  realtimeOpening?.abort();realtimeOpening=null;
  transcriptionControllers.forEach(controller => controller.abort());
  transcriptionQueue = Promise.resolve();
  engineUnlistenChunk?.();
  engineUnlistenChunk = null;
  engineUnlistenError?.();
  engineUnlistenError = null;
  const previousRealtime = realtimeCapture; realtimeCapture = null;
  await previousRealtime?.close();
  const previous = microphone;
  microphone = null;
  await previous?.close();
  const { stopSystemAudioCapture } = await import('./bridge');
  await stopSystemAudioCapture().catch(() => {});
  resetAudio();
}

export function beginListening(audioSource: AudioSource): Promise<void> {
  if (opening && openingGeneration === captureGeneration) return opening;
  const generation = ++captureGeneration;
  openingGeneration = generation;
  const task = (async () => {
    await stopCapture(false);
    if (generation !== captureGeneration) return;
    lastMeterAt = 0;
    const realtime = getAiSettings().speechInputMode === 'realtime';
    setState({ status: 'connecting', errorMessage: null, audio: { ...emptyAudio(), source: audioSource, recognitionMode: realtime ? 'realtime' : liveSpeechEnabled() ? 'segmented' : 'file' } });
    try {
      resolveAiRoute(getAiSettings(), 'stt');
      if (realtime) {
        const controller = new AbortController();realtimeOpening=controller;
        const { openConfiguredRealtimeAsr } = await import('./realtimeAsr');
        const stream = await openConfiguredRealtimeAsr({
          onResult: result => {
            if (generation !== captureGeneration) return;
            if (!result.isFinal) { setState({ partial: result.text }); return; }
            const text = cleanTranscript(result.text);
            setState({ partial: '', audio: { ...state.audio, lastTranscriptAt: Date.now() } });
            if (text && !isFillerSentence(text)) void deliverUtterance(text).catch(error => {
              if (generation === captureGeneration) setState({ errorMessage: `转写文字已显示，但记录保存失败：${String(error.message || error)}` });
            });
          },
          onState: realtimeState => {
            if (generation !== captureGeneration) return;
            setState({ ...(realtimeState === 'reconnecting' ? { partial: '', errorMessage: '实时语音连接中断，正在重新连接；中断期间的语音请稍后重说。' } : realtimeState === 'ready' ? { errorMessage: null } : {}),
              audio: { ...state.audio, realtimeState } });
          },
          onError: error => { if (generation === captureGeneration) { reportInterviewError(error); void stopCapture(); } },
        }, { signal:controller.signal, language: interviewLang(), silenceMs: getSetting('interview.silenceGateMs', 1600) });
        if(realtimeOpening===controller)realtimeOpening=null;
        if (generation !== captureGeneration) { await stream.close(); return; }
        realtimeCapture = stream;
      }
      if (audioSource === 'SPEAKER') {
        const { startSystemAudioCapture, setSystemAudioExcludedOutputs } = await import('./bridge');
        const failCapture = (message: string) => {
          if (generation !== captureGeneration) return;
          reportInterviewError(new Error(message));
          void stopCapture();
        };
        const offError = await listenEvent<{ error: string }>('system-audio-error', p => {
          failCapture(p.error || '系统收音已中断，请暂停后继续以重新连接播放设备。');
        });
        if (generation !== captureGeneration) { offError(); return; }
        engineUnlistenError = offError;
        const offChunk = await listenEvent<{ volume: number; pcmBase64: string }>('system-audio-chunk', p => {
          if (generation !== captureGeneration) return;
          try {
            const bin = atob(p.pcmBase64);
            if (!bin.length || bin.length % 2 || bin.length > 64000) throw new Error('Invalid PCM packet');
            const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
            const view = new DataView(bytes.buffer);
            const pcm = new Int16Array(bin.length / 2);
            let amplitude = 0;
            for (let i = 0; i < pcm.length; i++) {
              pcm[i] = view.getInt16(i * 2, true);
              amplitude += Math.abs(pcm[i]) / 32768;
            }
            pushPcm(pcm, amplitude / pcm.length * 800);
          } catch {
            failCapture('系统收音数据格式异常，请重启应用后重试。');
          }
        });
        if (generation !== captureGeneration) { offChunk(); return; }
        engineUnlistenChunk = offChunk;
        await setSystemAudioExcludedOutputs(getSetting<string[]>('audio.excludedOutputs', []));
        if (generation !== captureGeneration) return;
        const info = await startSystemAudioCapture();
        if (generation !== captureGeneration) return;
        if (!info || info.sampleRate !== 16000 || info.channels !== 1) {
          throw new Error('系统收音组件版本不匹配，请完整重启更新后的桌面应用。');
        }
        setState({ audio: { ...state.audio, deviceLabel: info.devices.map(device => device.name).join(' / ') || '系统播放声音' } });
      } else {
        const capture = await openMicrophone({
          deviceId: getSetting('interview.microphoneId', ''),
          onPcm: (pcm, volume) => { if (generation === captureGeneration) pushPcm(pcm, volume); },
          onError: message => {
            if (generation !== captureGeneration) return;
            reportInterviewError(new Error(message));
            void stopCapture();
          },
        });
        if (generation !== captureGeneration) { await capture.close(); return; }
        microphone = capture;
        setState({ audio: { ...state.audio, deviceLabel: capture.label } });
      }
      setState({ status: 'listening' });
      void drainAnswers();
    } catch (error) {
      if (generation !== captureGeneration) return;
      await stopCapture(false);
      if (generation !== captureGeneration) return;
      reportInterviewError(error);
    }
  })().finally(() => { if (opening === task) opening = null; });
  opening = task;
  return task;
}

export async function pauseListening() {
  // Discard the unfinished segment and cancel in-flight transcription on pause.
  captureGeneration++;
  realtimeOpening?.abort();realtimeOpening=null;
  transcriptionControllers.forEach(controller => controller.abort());
  transcriptionQueue = Promise.resolve();
  resetAudio();
  const previousRealtime = realtimeCapture; realtimeCapture = null;
  await previousRealtime?.close();
  if (state.audio.source === 'SPEAKER') await stopCapture(false);
  await microphone?.setPaused(true);
  setState({ status: 'paused', partial: '', audio: { ...state.audio, level: 0, speaking: false, bufferedMs: 0, pending: 0 } });
}

export async function resumeListening() {
  // Reopen the selected device so unplugging or system suspension is recoverable.
  await beginListening(state.audio.source);
}

export async function interruptAnswer() {
  const pending = state.turns.find((t) => t.answerPending);
  pending?.abort?.abort();
  setState({
    messages: state.messages.map((m) => (m.pending ? { ...m, pending: false } : m)),
    status: 'listening',
  });
}

export async function endInterview(complete = true) {
  answerQueue.length = 0;
  sessionGeneration++;
  const sessionId = state.sessionId;
  setState({ status: 'ended' });
  state.turns.forEach(t => t.abort?.abort());
  await stopCapture();
  if (state.sessionId !== sessionId) return;
  setState({ status: 'ended', audio: { ...emptyAudio(), source: state.audio.source } });
  if (complete && sessionId) {
    await completeSession(sessionId);
  }
  if (state.sessionId === sessionId) setState({ sessionId: null });
}

async function persistMessages(messages: ChatMessage[]) {
  const sessionId = state.sessionId;
  if (sessionId) {
    await updateSession(sessionId, { messages });
  }
}

function encodeWavFromPcm(pcm: Int16Array): Blob {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    view.setInt16(off, pcm[i], true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ---------------- 文本清洗（移植原版 Yp/Xp/$p） ----------------

const FILLER_WORDS = '嗯啊呃哦噢唔哎诶呀咦嘿哼呵嘛';
const FILLER_SENTENCES =
  /^(好|好的|行|对|是的|明白|ok|okay|thanks|thank you|嗯嗯|好的好的|对的|没问题|可以)[。..！!？?\s]*$/i;

export function cleanTranscript(text: string): string {
  let t = text.trim();
  // 语气词剔除
  let cleaned = '';
  for (const ch of t) {
    if (FILLER_WORDS.includes(ch)) continue;
    cleaned += ch;
  }
  // 相邻重复标点
  cleaned = cleaned.replace(/([。！？、，,.!?])\1+/g, '$1').trim();
  return cleaned;
}

export function isFillerSentence(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  if (FILLER_SENTENCES.test(t)) return true;
  if (/^\d+[。..？?]?$/.test(t)) return true;
  return false;
}

export function aiConfigured(): boolean {
  return isRoleConfigured(getAiSettings(), 'chat');
}
