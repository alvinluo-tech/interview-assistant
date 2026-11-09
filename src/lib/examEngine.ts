/*
 * 笔试引擎：截屏 → vision LLM 流式作答 → 本地笔试记录。
 * 替代原版 exam.* websocket 云端管线；计费/额度本地化（本地模式不限制）。
 */
import { captureScreen, cmd } from './bridge';
import { buildExamUserPrompt, chatWithImages, EXAM_SYSTEM_PROMPT } from './ai';
import { type ExamQuestion, createExamSession, readData, updateExamSession, completeExamSession } from './backend';
import { getSetting, ExamCustomization, DEFAULT_EXAM_CUSTOMIZATION } from './store';
import { t } from './i18n';
import {assembleExamContext} from './aiContext';
import type {AiRequestTrace} from './aiTaskPolicy';
import { extractCodeBlock, detectLanguage, detectRunMode, parseSamples, type RunMode } from './codeQuestion';
import { buildScaffold } from './codeScaffold';
import { verifyCode, judgedSamples, type CodeVerdict } from './codeRunner';

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
  completionStatus?:string;request?:AiRequestTrace;
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
  /** 代码题的本地验证结果（异步写入，不阻塞答案） */
  verification?: CodeVerdict;
  codeLanguage?: string;
  codeMode?: RunMode;
  sampleCount?: number;
  /** 「按样例修正」已用轮数（硬上限 FIX_MAX_ROUNDS，防止为过样例反复重写） */
  fixRound?: number;
  /** 修正前的原答案，供「恢复上一版」 */
  previousBody?: string;
}

export interface SolverState {
  interviewSessionId?:string;selectedTurnId?:string;
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
let checkpointTimer: number | null = null;
let turnWrites: Promise<void> = Promise.resolve();
const unsavedTurns = new Map<string,SolverTurn[]>();
function turnId() { return `t${Date.now()}-${++turnSequence}`; }
function cancelRequest() {
  generation++;
  if (checkpointTimer !== null) { window.clearTimeout(checkpointTimer); checkpointTimer = null; }
  if(requestController && state.activeTurnId)setState({turns:state.turns.map(turn=>turn.id===state.activeTurnId?{...turn,completionStatus:'cancelled'}:turn)});
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
  const parts: string[] = [t('{label} · 最多 {n} 页', { label: t(mode.shortLabel), n: mode.maxScreenshotPages })];
  parts.push(c.answerLanguage === 'auto' ? t('答案自动') : t('答案用{lang}', { lang: c.answerLanguage }));
  if (c.programmingLanguage !== 'auto') parts.push(t('编程题 {lang}', { lang: c.programmingLanguage }));
  if (c.codeMode !== 'auto') parts.push(c.codeMode === 'acm' ? t('ACM 模式') : t('核心代码模式'));
  if (c.codeQuality !== 'standard') {
    const map = { readable: '清晰易读', concise: '简洁直接', performance: '优先性能' } as const;
    parts.push(t(map[c.codeQuality]));
  }
  if (c.customRequirements) parts.push(t('有补充要求'));
  return parts.join(' · ');
}

// ---------------- 会话 ----------------

/** New workbench runs reset only the owning runtime; panic hide/show keeps it. */
export function prepareExamRun(runId:string, goalId:string|null,interviewSessionId?:string, resumeSessionId?:string) {
  if (examRunId === runId) return;
  examRunId = runId;
  cancelRequest();
  setState({sessionId:null,goalId,interviewSessionId,selectedTurnId:undefined,mode:examModeInfo(getSetting(modeSettingKey(),'quick')).key as ExamModeKey,
    phase:'idle',turns:[],pendingScreenshots:[],activeTurnId:null,elapsedSec:0,statusText:'',errorMessage:null});
  const saved=readData<import('./backend').ExamSessionRecord[]>('examSessions',[]).find(session=>session.status==='ACTIVE' && (interviewSessionId ? session.interviewSessionId===interviewSessionId : !!resumeSessionId && session.id===resumeSessionId && !session.interviewSessionId));
  if(saved){const pending=unsavedTurns.get(saved.id);const turns=pending||saved.questions.map(question=>({...question,body:question.answer,verification:sanitizeVerdict(question.verification),reasoning:'',reasoningDone:true,reasoningDurationMs:0,followUpOptions:[]}));
    setState({sessionId:saved.id,turns,selectedTurnId:turns[turns.length-1]?.id,...(pending?{phase:'error' as const,errorMessage:t('上次未保存内容已恢复，请重试保存后再关闭。')}:{})});}
  else if(resumeSessionId) setState({phase:'error',errorMessage:t('未找到可恢复的笔试记录，请返回工作台重新尝试。')});
}

export async function finishInterviewExam(interviewSessionId:string,complete=true):Promise<void> {
  if(state.interviewSessionId!==interviewSessionId)return;
  const sessionId=state.sessionId;
  cancelRequest();
  const current=generation;
  try{await persistTurns();if(sessionId&&complete)await completeExamSession(sessionId);}
  finally{if(current===generation)setState({phase:'idle',activeTurnId:null,statusText:''});}
}

export async function startExamSession(goalId: string | null): Promise<void> {
  cancelRequest();
  setState({interviewSessionId:undefined,selectedTurnId:undefined});
  await createSessionForGeneration(goalId, generation);
}

async function createSessionForGeneration(goalId: string | null, current: number): Promise<void> {
  const configured = getSetting(modeSettingKey(), 'quick');
  const mode = examModeInfo(configured).key as ExamModeKey;
  const goals = readData<{ id: string; name: string; companyName?: string }[]>('goals', []);
  const goal = goals.find((g) => g.id === goalId);
  const session = await createExamSession({
    title: t('笔试 {time}', { time: new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }),
    goalId,
    mode,
    interviewSessionId:state.interviewSessionId,
  });
  if (current !== generation) { await completeExamSession(session.id); return; }
  setState({
    sessionId: session.id,
    phase: 'idle',
    statusText: '',
    mode,
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
      completionStatus:t.completionStatus,request:t.request,
      verification: t.verification, codeLanguage: t.codeLanguage, codeMode: t.codeMode,
      sampleCount: t.sampleCount, fixRound: t.fixRound, previousBody: t.previousBody,
      answer: t.body,
      createdAt: t.createdAt,
    }));
  const sessionId = state.sessionId;
  const snapshot=state.turns.map(turn=>({...turn}));
  const write = turnWrites.catch(() => {}).then(() => updateExamSession(sessionId, { questions })).then(()=>{unsavedTurns.delete(sessionId);},error=>{unsavedTurns.set(sessionId,snapshot);throw error;});
  turnWrites = write;
  await write;
}

function scheduleTurnCheckpoint(current: number) {
  if (checkpointTimer !== null) return;
  checkpointTimer = window.setTimeout(() => {
    checkpointTimer = null;
    if (current !== generation) return;
    void persistTurns().catch(error => {
      if (current === generation) setState({errorMessage:t('答案暂未保存：{msg}', { msg: String((error as Error).message || error) })});
    });
  }, 2000);
}

/** Recovery writes may fail too; UI fire-and-forget actions must still settle. */
async function persistRecovery(current:number) {
  try {await persistTurns();}
  catch(error){
    if(current!==generation)return;
    const message=t('答案暂未保存：{msg}',{msg:String((error as Error).message || error)});
    setState({phase:'error',statusText:'',errorMessage:[state.errorMessage,message].filter(Boolean).join('\n')});
  }
}

// ---------------- 截屏与作答 ----------------

function captureOptions(){return {protectedOnTop:true,compatibilityMode:getSetting('capture.compatibilityMode',false),captureMode:getSetting('capture.mode','screen')};}
export async function capturePage(): Promise<string> {
  const max = examModeInfo(state.mode).maxScreenshotPages;
  if (state.pendingScreenshots.length >= max) {
    const message = t('最多收集 {max} 页，请先发送或清空已收集截图。', { max });
    setState({ errorMessage: message });
    throw new Error(message);
  }
  if (['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) throw new Error(t('当前操作尚未完成，请稍候。'));
  const current = generation;
  setState({ phase: 'capturing', statusText: t('截屏中…') });
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
      errorMessage: t('截屏失败：{msg}', { msg: String((e as Error).message ?? e) }),
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
      startingSolve = false; requestController = null;
      setState({phase:'error',statusText:'',errorMessage:t('创建笔试记录失败：{msg}', { msg: String((error as Error).message || error) })});
      return;
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
      setState({phase:'error',statusText:'',errorMessage:t('截图失败：{msg}', { msg: String((error as Error).message||error) })});
      return;
    }
  }
  if (shots.length > maxPages) {
    requestController = null;
    setState({phase:'error', errorMessage:t('最多发送 {max} 页，请调整截图数量后重试。', { max: maxPages })});
    return;
  }
  setState({
    pendingScreenshots: [],
    phase: 'thinking',
    statusText: shots.length > 1 ? t('发送 {n} 页给 AI…', { n: shots.length }) : t('上传截图…'),
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
  setState({ turns, activeTurnId: turn.id,selectedTurnId:turn.id });
  ensureTicker();
  const startedAt = Date.now();
  let raw = '', answerCompleted=false;
  try {
    // 截图落盘与请求并行：请求只用内存里的 dataURL，等落盘只会白等几百毫秒。
    void cmd<string[]>('cmd_exam_store_images', {sessionId: state.sessionId, turnId: turn.id, images: shots})
      .then((refs) => {
        if (current !== generation) return;
        setState({turns: state.turns.map(t => t.id === turn.id ? {...t, screenshotRefs: refs || []} : t)});
        void persistTurns().catch(() => {});
      })
      .catch((error) => {
        if (current !== generation) return;
        setState({turns: state.turns.map(t => t.id === turn.id ? {...t, imageSaveError: String((error as Error).message || error)} : t)});
        setState({errorMessage:t('原题截图未能保存，仍将尝试解答；请保留题目以备重新截图。')});
      });
    // 回合记录必须先落盘再发请求：写不进去就不该花掉这次请求，也才能保住已收集的页面重试。
    await persistTurns();
    if (current !== generation) return;
    const c = customization();
    const answer = await chatWithImages(buildExamUserPrompt(c), shots, {
      task:'exam-solve',
      onTrace:request=>{if(current===generation)setState({turns:state.turns.map(t=>t.id===turn.id?{...t,request,completionStatus:request.completionStatus}:t)});},
      signal: controller.signal,
      system: EXAM_SYSTEM_PROMPT+'\n先用 <exam-question>完整转写题干、选项、约束与样例</exam-question>，再用 <exam-answer>给出答案</exam-answer>。不添加这两个区块以外的内容。\n'+(state.mode==='instant'?'简洁输出结论，避免展开长篇解释。':state.mode==='programming'?'给出完整可运行代码、边界条件与时间空间复杂度。不要声称执行过代码或已通过样例，除非有真实执行结果。':'输出答案和关键思路，保持简明。'),
      onDelta: (delta) => {
        if (current !== generation) return;
        raw += delta;
        const parsed = splitExamResponse(raw);
        setState({
          phase: 'streaming',
          statusText: t('AI 输出中…'),
          turns: state.turns.map((t) => (t.id === turn.id ? { ...t, body: parsed.answer, questionText: parsed.questionText } : t)),
        });
        scheduleTurnCheckpoint(current);
      },
    });
    if (current !== generation) return;
    if(raw.includes('<exam-question>')&&!/<exam-answer>[\s\S]+<\/exam-answer>/.test(answer || raw))throw new Error(t('模型未完整返回答案区块，已保存原题和已有内容，可继续追问。'));
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
    answerCompleted=true;
    await persistTurns();
    void verifyTurnCode(turn.id, doneTurns.find((x) => x.id === turn.id)?.body ?? '', doneTurns.find((x) => x.id === turn.id)?.questionText, current);
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
      ...(!raw&&!answerCompleted?{pendingScreenshots:[...shots]}:{}),
      turns:state.turns.map(t=>t.id===turn.id?{...t,completionStatus:answerCompleted?(t.completionStatus || 'complete'):(err as {completionStatus?:string}).completionStatus || 'failed'}:t),
    });
    await persistRecovery(current);
  } finally { if (current === generation) { if(checkpointTimer!==null){window.clearTimeout(checkpointTimer);checkpointTimer=null;} requestController = null; } }
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
    turns:state.turns.map(turn => turn.id === id ? {...turn,reasoningDone:true,completionStatus:'cancelled'} : turn) });
  await persistTurns();
}

export async function followUp(opts: {
  turnId?:string;
  intent?: 'partial-pass' | 'brute-force' | 'simplify' | 'code-review';
  level?: number;
  message?: string;
  screenshots?: string[];
}): Promise<void> {
  if (startingSolve || requestController || ['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) return;
  const last = state.turns.find(turn=>turn.id===(opts.turnId || state.selectedTurnId)) || state.turns[state.turns.length - 1];
  if (!last) return;
  const map: Record<string, string> = {
    'partial-pass': '请给出更容易理解的基础解法，保持正确性，并诚实说明复杂度与适用数据范围，不编造通过率。',
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
    questionText: t('追问：{topic}', { topic: opts.message ?? labelOfIntent(opts.intent) }),
    screenshotRefs: last.screenshotRefs,
    parentTurnId: last.parentTurnId || last.id,
    followUpOptions: [],
    createdAt: Date.now(),
  };
  function labelOfIntent(intent?: string): string {
    return { 'partial-pass': t('基础解法'), 'brute-force': t('换暴力解法'), simplify: t('继续简化'), 'code-review': t('检查代码') }[intent ?? ''] ?? t('追问');
  }
  const turns = [...state.turns, turn];
  setState({
    turns,
    activeTurnId: turn.id,
    phase: 'streaming',
    statusText: opts.intent === 'code-review' ? t('AI 检查中…') : t('AI 输出中…'),
  });
  ensureTicker();
  const startedAt = Date.now();
  let answerCompleted=false;
  try {
    const context=assembleExamContext(state.turns,last.id);
    let images=opts.screenshots || [];
    if (opts.intent === 'code-review' && images.length === 0) {
      setState({statusText:t('正在截取当前代码…')});
      images = [await captureScreen(captureOptions())];
      if (current !== generation) return;
      setState({statusText:t('AI 检查中…')});
    }
    const root=state.turns.find(t=>t.id===(last.parentTurnId || last.id)) || last;
    if(!images.length&&(!root.questionText||/模型未单独|请查看原题/.test(root.questionText))){
      images=(await Promise.all((root.screenshotRefs || []).slice(0,6).map(reference=>cmd<string>('cmd_exam_read_image',{reference}).catch(()=>'')))).filter(Boolean);
    }
    if(current!==generation)return;
    const answer = await chatWithImages(
      `以下是之前的题目与答案：\n\n${context}\n\n现在请：${prompt}`,
      images,
      {
        task:'exam-followup',
        onTrace:request=>{if(current===generation)setState({turns:state.turns.map(t=>t.id===turn.id?{...t,request,completionStatus:request.completionStatus}:t)});},
        signal: controller.signal,
        system: EXAM_SYSTEM_PROMPT,
        onDelta: (delta) => {
          if (current !== generation) return;
          setState({
            turns: state.turns.map((t) => (t.id === turn.id ? { ...t, body: t.body + delta } : t)),
          });
          scheduleTurnCheckpoint(current);
        },
      },
    );
    if (current !== generation) return;
    setState({
      phase: 'done',
      statusText: '',
      selectedTurnId:turn.id,
      turns: state.turns.map((t) =>
        t.id === turn.id
          ? { ...t, body: answer ? prefix + answer : t.body, reasoningDone: true, reasoningDurationMs: Date.now() - startedAt }
          : t,
      ),
      activeTurnId: null,
    });
    answerCompleted=true;
    await persistTurns();
  } catch (e) {
    if (current !== generation) return;
    setState({
      phase: 'error',
      statusText: '',
      errorMessage: String((e as Error).message ?? e),
      activeTurnId: null,
      turns:state.turns.map(t=>t.id===turn.id?{...t,completionStatus:answerCompleted?(t.completionStatus || 'complete'):(e as {completionStatus?:string}).completionStatus || 'failed'}:t),
    });
    await persistRecovery(current);
  } finally { if (current === generation) { if(checkpointTimer!==null){window.clearTimeout(checkpointTimer);checkpointTimer=null;} requestController = null; } }
}

/** 续写只回传正文尾部，够模型接上语义即可，避免把整篇回答重新计费。 */
const CONTINUE_CONTEXT_CHARS = 1600;

/**
 * 续写时模型常把断点前的一小段重新打一遍：取「已生成内容的结尾」与
 * 「续写开头」的最长重叠，重叠部分直接丢弃，避免同一句话出现两次。
 */
function mergeContinuation(existing: string, addition: string): string {
  const max = Math.min(400, existing.length, addition.length);
  for (let size = max; size >= 24; size -= 1) {
    if (existing.endsWith(addition.slice(0, size))) return existing + addition.slice(size);
  }
  return existing + addition;
}

/**
 * 续写：答案因输出长度限制被截断（且已有正文）时，从断点接着写，
 * 结果追加到同一条回答，不新建追问轮次。失败时保留已经流出的内容。
 */
export async function continueTurn(targetId?: string): Promise<void> {
  if (startingSolve || requestController || ['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) return;
  const target = state.turns.find(turn => turn.id === (targetId || state.selectedTurnId)) || state.turns[state.turns.length - 1];
  if (!target || !target.body.trim()) return;
  const current = ++generation;
  const controller = new AbortController();
  requestController = controller;
  const base = target.body;
  const question = (target.questionText || '').trim();
  const prompt = `${question ? `原题：\n${question}\n\n` : ''}下面这条回答在末尾被输出长度限制截断了：\n\n${base.slice(-CONTINUE_CONTEXT_CHARS)}\n\n请从中断处接着写完剩余内容，只输出接下来的部分。`;
  setState({ activeTurnId: target.id, phase: 'streaming', statusText: t('继续生成中…'), errorMessage: null });
  ensureTicker();
  let addition = '';
  try {
    const answer = await chatWithImages(prompt, [], {
      task: 'exam-followup',
      signal: controller.signal,
      system: `${EXAM_SYSTEM_PROMPT}\n这是续写任务：直接从断点继续写，不重复已有内容，不重新开头，不解释这是续写。`,
      onTrace: request => {
        if (current === generation) setState({ turns: state.turns.map(t => t.id === target.id ? { ...t, request, completionStatus: request.completionStatus } : t) });
      },
      onDelta: (delta) => {
        if (current !== generation) return;
        addition += delta;
        setState({ turns: state.turns.map(t => t.id === target.id ? { ...t, body: mergeContinuation(base, addition) } : t) });
        scheduleTurnCheckpoint(current);
      },
    });
    if (current !== generation) return;
    const merged = mergeContinuation(base, (answer || addition).replace(/^\s*\n+/, ''));
    setState({
      phase: 'done',
      statusText: '',
      activeTurnId: null,
      turns: state.turns.map(t => t.id === target.id ? { ...t, body: merged, completionStatus: 'complete', reasoningDone: true } : t),
    });
    await persistTurns();
  } catch (e) {
    if (current !== generation) return;
    const err = e as Error & { completionStatus?: string };
    if (err?.name === 'AbortError') {
      setState({ phase: 'idle', statusText: '', activeTurnId: null });
      return;
    }
    setState({
      phase: 'error',
      statusText: '',
      errorMessage: String(err?.message ?? e),
      activeTurnId: null,
      turns: state.turns.map(t => t.id === target.id
        ? { ...t, body: mergeContinuation(base, addition), completionStatus: addition.trim() ? (err?.completionStatus || 'truncated') : (t.completionStatus || 'failed') }
        : t),
    });
    await persistRecovery(current);
  } finally {
    if (current === generation) {
      if (checkpointTimer !== null) { window.clearTimeout(checkpointTimer); checkpointTimer = null; }
      requestController = null;
    }
  }
}

// ---------------- 按样例修正 ----------------

/** 修正轮数硬上限：再多，模型为了过样例硬编码打表的概率会明显上升。 */
const FIX_MAX_ROUNDS = 2;
const FIX_DETAIL_CHARS = 400;

/** data.json 可能来自旧版本或写到一半：形状不对就当没有验证结果，别让它把渲染带崩。 */
function sanitizeVerdict(value: CodeVerdict | undefined): CodeVerdict | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (value.verdict !== 'passed' && value.verdict !== 'failed' && value.verdict !== 'unverified') return undefined;
  const outcomes = Array.isArray(value.outcomes) ? value.outcomes.filter((outcome) => !!outcome && typeof outcome === 'object') : [];
  return { ...value, outcomes };
}

function clipText(text: string, limit = FIX_DETAIL_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/** 把「哪几组样例没过」整理成喂回模型的证据：输入取自题面，期望/实际取自本地执行结果。 */
function failingSampleDetails(turn: SolverTurn): string {
  const verdict = turn.verification;
  if (!verdict || verdict.verdict !== 'failed') return '';
  // outcome.index 是「有期望输出的样例」里的序号，和 verifyCode 用的列表保持一致。
  const samples = judgedSamples(parseSamples(turn.questionText ?? ''));
  const blocks: string[] = [];
  for (const outcome of verdict.outcomes) {
    if (outcome.ok) continue;
    const input = (samples[outcome.index]?.input ?? '').trim();
    const parts = [`样例 ${outcome.index + 1}`];
    if (input) parts.push(`输入：\n${clipText(input)}`);
    parts.push(`期望输出：\n${clipText(outcome.expected)}`);
    parts.push(`实际输出：\n${clipText(outcome.actual)}`);
    if ((outcome.error ?? '').trim()) parts.push(`运行报错：\n${clipText(outcome.error ?? '')}`);
    blocks.push(parts.join('\n'));
    if (blocks.length >= 3) break;
  }
  return blocks.join('\n\n');
}

/**
 * 按样例修正：把失败样例喂回去重写代码，最多 FIX_MAX_ROUNDS 轮。
 * 触发点只有两个：用户点「按样例修正」，或执行器真的报错时的静默重试（1 轮）。
 */
export async function fixTurnWithSamples(targetId?: string, options: { silent?: boolean } = {}): Promise<void> {
  if (startingSolve || requestController || ['capturing', 'thinking', 'streaming', 'uploading'].includes(state.phase)) return;
  const target = state.turns.find((turn) => turn.id === (targetId || state.selectedTurnId)) || state.turns[state.turns.length - 1];
  if (!target || !target.body.trim()) return;
  if (target.verification?.verdict !== 'failed') return;
  const round = (target.fixRound ?? 0) + 1;
  if (round > FIX_MAX_ROUNDS) return;
  const block = extractCodeBlock(target.body);
  const details = failingSampleDetails(target);
  if (!block || !details) return;
  const current = ++generation;
  const controller = new AbortController();
  requestController = controller;
  const base = target.body;
  const question = (target.questionText || '').trim();
  const prompt = [
    question ? `原题：\n${clipText(question, 2000)}` : '',
    `你上一次给出的代码：\n\`\`\`${block.language}\n${clipText(block.code, 3000)}\n\`\`\``,
    `在本地执行后，下面这些题面样例没有通过：\n\n${details}`,
    '请修正代码让这些样例真正通过。不要改题面，不要为了过样例硬编码特判（不要按样例 if、不要打表），保持原来的算法思路。只输出一个 <exam-answer>…</exam-answer> 区块：修正后的完整答案，代码为主，必要的说明保持简短。',
  ].filter(Boolean).join('\n\n');
  setState({
    activeTurnId: target.id,
    // 静默重试不抢界面：phase 保持原状，只有正文自己变，用户不会看到「AI 输出中」跳一下。
    phase: options.silent ? state.phase : 'streaming',
    statusText: options.silent ? '' : t('按样例修正中…'),
    errorMessage: null,
  });
  ensureTicker();
  let raw = '';
  try {
    const answer = await chatWithImages(prompt, [], {
      task: 'exam-followup',
      signal: controller.signal,
      system: EXAM_SYSTEM_PROMPT,
      onTrace: (request) => {
        if (current === generation) setState({ turns: state.turns.map((turn) => (turn.id === target.id ? { ...turn, request, completionStatus: request.completionStatus } : turn)) });
      },
      onDelta: (delta) => {
        if (current !== generation) return;
        raw += delta;
        const streamed = splitExamResponse(raw).answer;
        setState({ turns: state.turns.map((turn) => (turn.id === target.id && streamed ? { ...turn, body: streamed } : turn)) });
        scheduleTurnCheckpoint(current);
      },
    });
    if (current !== generation) return;
    const final = (answer || raw).trim();
    const parsed = splitExamResponse(final);
    // 模型有时会照抄 <exam-question>：只有它确实给了答案区块时才用它，否则把整段当答案。
    const body = (parsed.answer || (parsed.questionText ? '' : final)).trim() || base;
    setState({
      phase: 'done',
      statusText: '',
      activeTurnId: null,
      turns: state.turns.map((turn) => turn.id === target.id
        ? { ...turn, body, previousBody: turn.previousBody ?? base, fixRound: round, completionStatus: 'complete', reasoningDone: true }
        : turn),
    });
    await persistTurns();
    void verifyTurnCode(target.id, body, target.questionText, current, { autoFix: true });
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
      turns: state.turns.map((turn) => (turn.id === target.id ? { ...turn, completionStatus: 'failed' } : turn)),
    });
    await persistRecovery(current);
  } finally {
    if (current === generation) {
      if (checkpointTimer !== null) { window.clearTimeout(checkpointTimer); checkpointTimer = null; }
      requestController = null;
    }
  }
}

/** 恢复上一版：把修正前的答案放回去，并重新验证一次。 */
export async function restorePreviousAnswer(targetId?: string): Promise<void> {
  if (startingSolve || requestController) return;
  const target = state.turns.find((turn) => turn.id === (targetId || state.selectedTurnId)) || state.turns[state.turns.length - 1];
  if (!target || !target.previousBody) return;
  const previous = target.previousBody;
  setState({
    turns: state.turns.map((turn) => turn.id === target.id
      ? { ...turn, body: previous, previousBody: undefined, fixRound: 0, verification: undefined, completionStatus: 'complete' }
      : turn),
  });
  await persistTurns();
  void verifyTurnCode(target.id, previous, target.questionText, generation);
}

/** 多页收集态：发送 */
export function hasPendingPages(): boolean {
  return state.pendingScreenshots.length > 0;
}
export function selectSolverTurn(id:string){if(state.turns.some(turn=>turn.id===id))setState({selectedTurnId:id});}

/** 切换答题档位（浮窗模式 chip / 设置页） */
export function setSolverMode(mode: ExamModeKey) {
  const max = EXAM_MODES[mode].maxScreenshotPages;
  if (state.pendingScreenshots.length > max) {
    setState({errorMessage:t('已收集 {n} 页，超过此档位 {max} 页上限，请先发送或清空。', { n: state.pendingScreenshots.length, max })});
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
  const current=generation,sessionId=state.sessionId;
  const { hideOverlay, setSessionActive } = await import('./bridge');
  let saved = false;
  try {
    if (sessionId) { await persistTurns(); await completeExamSession(sessionId); }
    saved = true;
  } catch (error) {
    if(current===generation)setState({phase:'error',statusText:'',activeTurnId:null,errorMessage:t('结束前保存失败，未保存内容已保留。请勿退出应用；恢复上次笔试后重试保存或复制答案：{msg}', { msg: String((error as Error).message || error) })});
    throw error;
  } finally {
    if(current===generation){
    if(saved)setState({ sessionId: null, phase: 'idle', turns: [], statusText: '', pendingScreenshots: [], activeTurnId: null, errorMessage: null });
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
}

// ---------------- 复制（原版 PG/FG/xt） ----------------

export function extractLastCodeBlock(text: string): string | null {
  const fences = [...text.matchAll(/```[a-zA-Z0-9+#-]*\n([\s\S]*?)```/g)];
  const last = fences[fences.length - 1];
  return last ? last[1] : null;
}

/**
 * 代码题本地验证：解析题面样例 → 生成可运行文件 → 在本地 WASM 执行器里跑 → 把结论写回 turn。
 * 全程异步：失败只影响这一行标注，不影响答案本身，也不会把整场笔试置为出错。
 */
async function verifyTurnCode(turnId: string, answer: string, questionText: string | undefined, generationAtStart: number, options: { autoFix?: boolean } = {}) {
  const block = extractCodeBlock(answer);
  if (!block) return;
  const language = detectLanguage(block, questionText ?? '');
  const samples = parseSamples(questionText ?? '');
  if (!samples.length) return;
  const mode = detectRunMode(block.code, questionText ?? '');
  // ACM 模式答案本身就是完整程序；核心代码模式要先补读入/调用/打印的驱动。
  const runnable = mode === 'acm' ? block.code : buildScaffold({ language, code: block.code, mode, samples }).content;
  let verdict: CodeVerdict;
  try {
    verdict = await verifyCode({ language, code: runnable, samples });
  } catch (error) {
    verdict = { verdict: 'unverified', runner: '', passed: 0, total: samples.length, outcomes: [], note: 'error' };
  }
  if (generationAtStart !== generation) return;
  setState({ turns: state.turns.map((turn) => (turn.id === turnId ? { ...turn, verification: verdict, codeLanguage: language, codeMode: mode, sampleCount: samples.length } : turn)) });
  void persistTurns();
  // 只有「执行器真的报错」（语法错/抛异常）才值得静默重试一轮：这类失败一定是代码问题，
  // 而不是判定口径问题；输出格式差异留给用户点「按样例修正」决定。
  const crashed = verdict.verdict === 'failed' && verdict.outcomes.some((outcome) => !outcome.ok && (outcome.error ?? '').trim());
  const local = language === 'python' || language === 'javascript';
  const fresh = (state.turns.find((turn) => turn.id === turnId)?.fixRound ?? 0) === 0;
  if (options.autoFix !== false && crashed && local && fresh) {
    window.setTimeout(() => { void fixTurnWithSamples(turnId, { silent: true }); }, 0);
  }
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
export interface TurnScaffold {
  language: string;
  mode: RunMode;
  samples: number;
  filename: string;
  content: string;
  runnable: boolean;
  note?: string;
}

/** 给当前这道题生成「可运行文件」，供浮窗的「复制可运行代码」按钮使用。 */
export function scaffoldForTurn(turn: SolverTurn): TurnScaffold | null {
  const block = extractCodeBlock(turn.body);
  if (!block) return null;
  const language = detectLanguage(block, turn.questionText ?? '');
  const samples = parseSamples(turn.questionText ?? '');
  const mode = detectRunMode(block.code, turn.questionText ?? '');
  const scaffold = buildScaffold({ language, code: block.code, mode, samples });
  return { language, mode, samples: samples.length, ...scaffold };
}

export function splitExamResponse(raw: string): {questionText: string; answer: string} {
  const question = /<exam-question>([\s\S]*?)(?:<\/exam-question>|$)/.exec(raw);
  const answer = /<exam-answer>([\s\S]*?)(?:<\/exam-answer>|$)/.exec(raw);
  return {questionText: question?.[1].trim() || '', answer: answer ? answer[1].trim() : question ? '' : raw.trim()};
}
