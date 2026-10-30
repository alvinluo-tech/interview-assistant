/*
 * 笔试引擎：截屏 → vision LLM 流式作答 → 本地笔试记录。
 * 替代原版 exam.* websocket 云端管线；计费/额度本地化（本地模式不限制）。
 */
import { captureScreen, cmd } from './bridge';
import { buildExamUserPrompt, chatWithImages, EXAM_SYSTEM_PROMPT } from './ai';
import { type ExamQuestion, createExamSession, readData, updateExamSession, completeExamSession } from './backend';
import { getSetting, ExamCustomization, DEFAULT_EXAM_CUSTOMIZATION } from './store';

export const EXAM_MODES = {
  instant: {
    key: 'instant',
    label: '秒答模式',
    shortLabel: '秒答',
    description: '优先给结论与必要代码，减少解释',
    maxScreenshotPages: 4,
  },
  quick: {
    key: 'quick',
    label: '快速模式',
    shortLabel: '快速',
    description: '给出答案与关键思路，适合一般题目',
    maxScreenshotPages: 4,
  },
  programming: {
    key: 'programming',
    label: '编程模式',
    shortLabel: '编程',
    description: '支持更多截图，解释算法、边界与复杂度；样例可手动验证',
    maxScreenshotPages: 6,
  },
};

export type ExamModeKey = keyof typeof EXAM_MODES;
export const EXAM_MODE_ORDER: ExamModeKey[] = ['instant', 'quick', 'programming'];

export function nextExamMode(mode: ExamModeKey): ExamModeKey {
  const idx = EXAM_MODE_ORDER.indexOf(mode);
  return EXAM_MODE_ORDER[(idx + 1) % EXAM_MODE_ORDER.length];
}

export function examModeInfo(mode: string) {
  return EXAM_MODES[(mode as ExamModeKey) in EXAM_MODES ? (mode as ExamModeKey) : 'quick'];
}

// ---------------- 消息协议（浮窗渲染用） ----------------

export type SolverPhase = 'idle' | 'capturing' | 'uploading' | 'thinking' | 'streaming' | 'done' | 'error';

export interface SolverTurn {
  id: string;
  reasoning: string;
  reasoningDone: boolean;
  reasoningDurationMs: number;
  body: string;
  questionText?: string;
  screenshotRefs?: string[];
  imageSaveError?: string;
  parentTurnId?: string;
  /** [[FOLLOWUP: a|b|c]] 服务端建议的追问 */
  followUpOptions: string[];
  createdAt: number;
}

export interface SolverState {
  sessionId: string | null;
  phase: SolverPhase;
  statusText: string;
  mode: ExamModeKey;
  /** 多页收集 */
  pendingScreenshots: string[];
  turns: SolverTurn[];
  /** 当前活跃 turn（流式写入） */
  activeTurnId: string | null;
  elapsedSec: number;
  errorMessage: string | null;
  goalId: string | null;
}

let state: SolverState = {
  sessionId: null,
  phase: 'idle',
  statusText: '',
  mode: 'quick',
  pendingScreenshots: [],
  turns: [],
  activeTurnId: null,
  elapsedSec: 0,
  errorMessage: null,
  goalId: null,
};

const listeners = new Set<() => void>();

function setState(patch: Partial<SolverState>) {
  state = { ...state, ...patch };
  if (!['thinking', 'streaming', 'capturing', 'uploading'].includes(state.phase) && tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
  listeners.forEach((l) => l());
}

export function getSolverState(): SolverState {
  return state;
}

export function subscribeSolver(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let tickTimer: number | null = null;
let generation = 0;
let requestController: AbortController | null = null;
let startingSolve = false;
let turnSequence = 0;
let examRunId: string | null = null;
function turnId() { return `t${Date.now()}-${++turnSequence}`; }
function cancelRequest() {
  generation++;
  requestController?.abort();
  requestController = null;
  startingSolve = false;
}
function ensureTicker() {
  if (tickTimer) return;
  tickTimer = window.setInterval(() => {
    if (state.phase === 'thinking' || state.phase === 'streaming' || state.phase === 'capturing' || state.phase === 'uploading') {
      setState({ elapsedSec: state.elapsedSec + 1 });
    }
  }, 1000);
}

function modeSettingKey(): 'exam.mode' | 'interview.solverExamMode' {
  return getSetting<string>('overlay.mode', 'exam') === 'interview' ? 'interview.solverExamMode' : 'exam.mode';
}

function customization(): ExamCustomization {
  return { ...DEFAULT_EXAM_CUSTOMIZATION, ...getSetting('exam.customization', DEFAULT_EXAM_CUSTOMIZATION) };
}

export function customizationSummary(): string {
  const c = customization();
  const mode = examModeInfo(state.mode);
  const parts: string[] = [`${mode.shortLabel} · 最多 ${mode.maxScreenshotPages} 页`];
  parts.push(c.answerLanguage === 'auto' ? '答案自动' : `答案用${c.answerLanguage}`);
  if (c.programmingLanguage !== 'auto') parts.push(`编程题 ${c.programmingLanguage}`);
  if (c.codeMode !== 'auto') parts.push(c.codeMode === 'acm' ? 'ACM 模式' : '核心代码模式');
  if (c.codeQuality !== 'standard') {
    const map = { readable: '清晰易读', concise: '简洁直接', performance: '优先性能' } as const;
    parts.push(map[c.codeQuality]);
  }
  if (c.customRequirements) parts.push('有补充要求');
  return parts.join(' · ');
}

// ---------------- 会话 ----------------

/** New workbench runs reset only the owning runtime; panic hide/show keeps it. */
export function prepareExamRun(runId:string, goalId:string|null) {
  if (examRunId === runId) return;
  examRunId = runId;
  cancelRequest();
  setState({sessionId:null,goalId,mode:examModeInfo(getSetting(modeSettingKey(),'quick')).key as ExamModeKey,
    phase:'idle',turns:[],pendingScreenshots:[],activeTurnId:null,elapsedSec:0,statusText:'',errorMessage:null});
}

export async function startExamSession(goalId: string | null): Promise<void> {
  cancelRequest();
  await createSessionForGeneration(goalId, generation);
}

async function createSessionForGeneration(goalId: string | null, current: number): Promise<void> {
  const configured = getSetting(modeSettingKey(), 'quick');
  const mode = examModeInfo(configured).key as ExamModeKey;
  const goals = readData<{ id: string; name: string; companyName?: string }[]>('goals', []);
  const goal = goals.find((g) => g.id === goalId);
  const session = await createExamSession({
    title: `笔试 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    goalId,
    mode,
  });
  if (current !== generation) { await completeExamSession(session.id); return; }
  setState({
    sessionId: session.id,
    phase: 'idle',
    statusText: '',
    mode,
    pendingScreenshots: [],
    turns: [],
    activeTurnId: null,
    elapsedSec: 0,
    errorMessage: null,
    goalId,
  });
  void goal;
}

/** 保存当前已完成的 turn 到记录（实时写） */
async function persistTurns() {
  if (!state.sessionId) return;
  const questions: ExamQuestion[] = state.turns
    .filter((t) => t.body.length > 0 || !!t.questionText || !!t.screenshotRefs?.length)
    .map((t) => ({
      id: t.id,
      questionText: t.questionText || (t.screenshotRefs?.length ? '模型未单独返回题干，请查看原题截图。' : '模型未单独返回题干。'),
      screenshotRefs: t.screenshotRefs, imageSaveError: t.imageSaveError, parentTurnId: t.parentTurnId,
      answer: t.body,
      createdAt: t.createdAt,
    }));
  await updateExamSession(state.sessionId, { questions });
}

// ---------------- 截屏与作答 ----------------

function captureOptions(){return {protectedOnTop:true,compatibilityMode:getSetting('capture.compatibilityMode',false),captureMode:getSetting('capture.mode','screen')};}
export async function capturePage(): Promise<string> {
  const max = examModeInfo(state.mode).maxScreenshotPages;
  if (state.pendingScreenshots.length >= max) {
    const message = `最多收集 ${max} 页，请先发送或清空已收集截图。`;
    setState({ errorMessage: message });
    throw new Error(message);
  }
  if (['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) throw new Error('当前操作尚未完成，请稍候。');
  const current = generation;
  setState({ phase: 'capturing', statusText: '截屏中…' });
  try {
    const dataUrl = await captureScreen(captureOptions());
    if (current !== generation) return dataUrl;
    setState({
      phase: 'idle',
      statusText: '',
      pendingScreenshots: [...state.pendingScreenshots, dataUrl],
    });
    return dataUrl;
  } catch (e) {
    if (current !== generation) throw e;
    setState({
      phase: 'error',
      errorMessage: `截屏失败：${String((e as Error).message ?? e)}`,
    });
    throw e;
  }
}

export function clearPendingScreenshots() {
  setState({ pendingScreenshots: [] });
}

export async function solve(opts?: { screenshots?: string[] }): Promise<void> {
  if (startingSolve || requestController || ['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) return;
  startingSolve = true;
  const current = ++generation;
  const controller = new AbortController();
  requestController = controller;
  if (!state.sessionId) {
    try { await createSessionForGeneration(state.goalId, current); }
    catch (error) {
      if (current !== generation) return;
      startingSolve = false; requestController = null; throw error;
    }
  }
  if (current !== generation) return;
  startingSolve = false;
  const modeInfo = examModeInfo(state.mode);
  const maxPages = modeInfo.maxScreenshotPages;
  let shots = opts?.screenshots ?? state.pendingScreenshots;
  if (shots.length === 0) {
    // 单页：直接截
    try {
      shots = [await captureScreen(captureOptions())];
      if (current !== generation) return;
    } catch(error) {
      if (current !== generation) return;
      requestController = null;
      setState({phase:'error',statusText:'',errorMessage:`截图失败：${String((error as Error).message||error)}`});
      return;
    }
  }
  if (shots.length > maxPages) {
    requestController = null;
    setState({phase:'error', errorMessage:`最多发送 ${maxPages} 页，请调整截图数量后重试。`});
    return;
  }
  setState({
    pendingScreenshots: [],
    phase: 'thinking',
    statusText: shots.length > 1 ? `发送 ${shots.length} 页给 AI…` : '上传截图…',
    elapsedSec: 0,
    errorMessage: null,
  });
  const turn: SolverTurn = {
    id: turnId(),
    reasoning: '',
    reasoningDone: false,
    reasoningDurationMs: 0,
    body: '',
    followUpOptions: [],
    createdAt: Date.now(),
  };
  const turns = [...state.turns, turn];
  setState({ turns, activeTurnId: turn.id });
  ensureTicker();
  const startedAt = Date.now();
  let raw = '';
  try {
    try {
      const refs = await cmd<string[]>('cmd_exam_store_images', {sessionId: state.sessionId, turnId: turn.id, images: shots});
      if (current !== generation) return;
      setState({turns: state.turns.map(t => t.id === turn.id ? {...t, screenshotRefs: refs || []} : t)});
    } catch (error) {
      if (current !== generation) return;
      setState({turns: state.turns.map(t => t.id === turn.id ? {...t, imageSaveError: String((error as Error).message || error)} : t)});
    }
    await persistTurns();
    const c = customization();
    const answer = await chatWithImages(buildExamUserPrompt(c), shots, {
      signal: controller.signal,
      system: EXAM_SYSTEM_PROMPT+'\n先用 <exam-question>完整转写题干、选项、约束与样例</exam-question>，再用 <exam-answer>给出答案</exam-answer>。不添加这两个区块以外的内容。\n'+(state.mode==='instant'?'简洁输出结论，避免展开长篇解释。':state.mode==='programming'?'给出完整可运行代码、边界条件与时间空间复杂度。不要声称执行过代码或已通过样例，除非有真实执行结果。':'输出答案和关键思路，保持简明。'),
      onDelta: (delta) => {
        if (current !== generation) return;
        raw += delta;
        const parsed = splitExamResponse(raw);
        setState({
          phase: 'streaming',
          statusText: 'AI 输出中…',
          turns: state.turns.map((t) => (t.id === turn.id ? { ...t, body: parsed.answer, questionText: parsed.questionText } : t)),
        });
      },
    });
    if (current !== generation) return;
    const doneTurns = state.turns.map((t) =>
      t.id === turn.id
        ? {
            ...t,
            body: splitExamResponse(answer || raw).answer || t.body,
            questionText: splitExamResponse(answer || raw).questionText || t.questionText,
            reasoningDone: true,
            reasoningDurationMs: Date.now() - startedAt,
            followUpOptions: suggestFollowUps(answer),
          }
        : t,
    );
    setState({ phase: 'done', statusText: '', turns: doneTurns, activeTurnId: null });
    await persistTurns();
  } catch (e) {
    if (current !== generation) return;
    const err = e as Error;
    if (err?.name === 'AbortError') {
      setState({ phase: 'idle', statusText: '', activeTurnId: null });
      return;
    }
    setState({
      phase: 'error',
      statusText: '',
      errorMessage: String(err?.message ?? e),
      activeTurnId: null,
    });
  } finally { if (current === generation) requestController = null; }
}

/** 从答案中提取服务端建议追问（原版 [[FOLLOWUP: a|b|c]] 协议） */
function suggestFollowUps(answer: string): string[] {
  const m = /\[\[FOLLOWUP:\s*([^\]]+)\]\]/.exec(answer);
  if (m) {
    return m[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 3);
  }
  return [];
}

/** 直接答（answerNow）：不做新截屏，让 AI 收敛输出当前答案 —— 本地实现为停止生成 */
export async function answerNow(): Promise<void> {
  if (!requestController || !state.activeTurnId) return;
  const id = state.activeTurnId;
  cancelRequest();
  setState({ phase:'done', statusText:'', activeTurnId:null,
    turns:state.turns.map(turn => turn.id === id ? {...turn,reasoningDone:true} : turn) });
  await persistTurns();
}

export async function followUp(opts: {
  intent?: 'partial-pass' | 'brute-force' | 'simplify' | 'code-review';
  level?: number;
  message?: string;
  screenshots?: string[];
}): Promise<void> {
  if (startingSolve || requestController || ['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) return;
  const last = state.turns[state.turns.length - 1];
  if (!last) return;
  const map: Record<string, string> = {
    'partial-pass': `请降低这段代码在评测用例上的通过率，只做局部修改，让它在一部分边界用例上出错（看起来像人类正常水平）。当前目标通过率约 ${[80, 60, 40, 20][(opts.level ?? 1) - 1] ?? 60}%。`,
    'brute-force': '请给出暴力解法版本，直接可提交，不强求最优复杂度。',
    simplify: '请继续简化上面的代码，让它更像普通面试者现场写出来的，同时保持可以通过。',
    'code-review': '这是我照着上面的解法手敲的代码，帮我检查有没有问题（不用重写整段，指出要改的行即可）。',
  };
  const prompt = opts.message ?? map[opts.intent ?? ''] ?? opts.message ?? '';
  if (!prompt) return;
  const current = ++generation;
  const controller = new AbortController();
  requestController = controller;
  const prefix = `> ${opts.message ?? labelOfIntent(opts.intent)}\n\n`;
  const turn: SolverTurn = {
    id: turnId(),
    reasoning: '',
    reasoningDone: false,
    reasoningDurationMs: 0,
    body: prefix,
    questionText: `追问：${opts.message ?? labelOfIntent(opts.intent)}`,
    screenshotRefs: last.screenshotRefs,
    parentTurnId: last.parentTurnId || last.id,
    followUpOptions: [],
    createdAt: Date.now(),
  };
  function labelOfIntent(intent?: string): string {
    return { 'partial-pass': '降低通过率', 'brute-force': '换暴力解法', simplify: '继续简化', 'code-review': '检查我抄的代码' }[intent ?? ''] ?? '追问';
  }
  const turns = [...state.turns, turn];
  setState({
    turns,
    activeTurnId: turn.id,
    phase: 'streaming',
    statusText: opts.intent === 'code-review' ? 'AI 检查中…' : 'AI 输出中…',
  });
  ensureTicker();
  const startedAt = Date.now();
  try {
    const context = state.turns
      .map((t) => [t.questionText, t.body].filter(Boolean).join('\n\n'))
      .join('\n\n---\n\n')
      .slice(-6000);
    const answer = await chatWithImages(
      `以下是之前的题目与答案：\n\n${context}\n\n现在请：${prompt}`,
      opts.screenshots ?? [],
      {
        signal: controller.signal,
        system: EXAM_SYSTEM_PROMPT,
        onDelta: (delta) => {
          if (current !== generation) return;
          setState({
            turns: state.turns.map((t) => (t.id === turn.id ? { ...t, body: t.body + delta } : t)),
          });
        },
      },
    );
    if (current !== generation) return;
    setState({
      phase: 'done',
      statusText: '',
      turns: state.turns.map((t) =>
        t.id === turn.id
          ? { ...t, body: answer ? prefix + answer : t.body, reasoningDone: true, reasoningDurationMs: Date.now() - startedAt }
          : t,
      ),
      activeTurnId: null,
    });
    await persistTurns();
  } catch (e) {
    if (current !== generation) return;
    setState({
      phase: 'error',
      statusText: '',
      errorMessage: String((e as Error).message ?? e),
      activeTurnId: null,
    });
  } finally { if (current === generation) requestController = null; }
}

/** 多页收集态：发送 */
export function hasPendingPages(): boolean {
  return state.pendingScreenshots.length > 0;
}

/** 切换答题档位（浮窗模式 chip / 设置页） */
export function setSolverMode(mode: ExamModeKey) {
  const max = EXAM_MODES[mode].maxScreenshotPages;
  if (state.pendingScreenshots.length > max) {
    setState({errorMessage:`已收集 ${state.pendingScreenshots.length} 页，超过此档位 ${max} 页上限，请先发送或清空。`});
    return;
  }
  setState({
    mode,
  });
  return import('./store').then(({ setSetting }) => setSetting(modeSettingKey(), mode));
}

export async function abortSolve(): Promise<void> {
  cancelRequest();
  await persistTurns();
  setState({
    phase: 'idle',
    statusText: '',
    activeTurnId: null,
    pendingScreenshots: [],
    elapsedSec: 0,
  });
}

export async function endExamSession(relaunch: boolean): Promise<void> {
  cancelRequest();
  const { hideOverlay, setSessionActive } = await import('./bridge');
  try {
    const sessionId = state.sessionId;
    if (sessionId) { await persistTurns(); await completeExamSession(sessionId); }
  } finally {
    setState({ sessionId: null, phase: 'idle', turns: [], statusText: '', pendingScreenshots: [], activeTurnId: null, errorMessage: null });
    if (tickTimer) { window.clearInterval(tickTimer); tickTimer = null; }
    try { await setSessionActive(false); }
    finally {
      await cmd('cmd_dual_send', {text: JSON.stringify({t:'ended'})}).catch(() => {});
      await cmd('cmd_dual_stop').catch(() => {});
      try { await hideOverlay(); }
      finally { const { showMain } = await import('./bridge'); void relaunch; await showMain(); }
    }
  }
}

// ---------------- 复制（原版 PG/FG/xt） ----------------

export function extractLastCodeBlock(text: string): string | null {
  const fences = [...text.matchAll(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/g)];
  const last = fences[fences.length - 1];
  return last ? last[1] : null;
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\[\[FOLLOWUP:[^\]]*\]\]/g, '')
    .trim();
}

/** Keep recognized source text separate from the answer, including streaming partial tags. */
export function splitExamResponse(raw: string): {questionText: string; answer: string} {
  const question = /<exam-question>([\s\S]*?)(?:<\/exam-question>|$)/.exec(raw);
  const answer = /<exam-answer>([\s\S]*?)(?:<\/exam-answer>|$)/.exec(raw);
  return {questionText: question?.[1].trim() || '', answer: answer ? answer[1].trim() : question ? '' : raw.trim()};
}
