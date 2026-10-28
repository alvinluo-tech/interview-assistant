/*
 * 本地数据层：替代原版云端（api.mianlingai.com tRPC）的本地实现。
 * 数据结构尽量沿用原版字段（session/examSession/material/resume/goal…），
 * 持久化在 tauri-plugin-store 的 data.json。
 */
import { load } from '@tauri-apps/plugin-store';
import { useSyncExternalStore } from 'react';
import type { ImportedDocument } from './documentIngest';

const listeners = new Set<() => void>();
let storePromise: Promise<import('@tauri-apps/plugin-store').Store> | null = null;
const cache = new Map<string, unknown>();
let hydrated = false;
let revision = -1;
let dataError: string | null = null;
const nativeData = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
function applySnapshot(snapshot: { revision: number; data: Record<string, unknown> }) {
  if (snapshot.revision < revision) return;
  revision = snapshot.revision;
  cache.clear();
  for (const key of DATA_KEYS) if (snapshot.data[key] != null) cache.set(key, snapshot.data[key]);
  dataError = null; hydrated = true;
  listeners.forEach(listener => listener());
}
export const getDataError = () => dataError;
export function useDataError() {
  return useSyncExternalStore(callback=>{listeners.add(callback);return()=>listeners.delete(callback);},()=>dataError,()=>null);
}
export async function refreshData() {
  const { invoke } = await import('@tauri-apps/api/core');
  applySnapshot(await invoke('cmd_data_read'));
}
export async function backupData(restore = false) {
  const { invoke } = await import('@tauri-apps/api/core');
  applySnapshot(await invoke('cmd_data_backup', { restore }));
}

function getStore() {
  if (!storePromise) {
    storePromise = load('data.json', { autoSave: true });
  }
  return storePromise;
}

export async function hydrateData() {
  if (hydrated) return;
  hydrated = true;
  try {
    if (nativeData()) { await refreshData(); return; }
    const store = await getStore();
    for (const key of DATA_KEYS) {
      const v = await store.get<unknown>(key);
      if (v != null) cache.set(key, v);
    }
  } catch (e) {
    hydrated = false;
    dataError = String((e as Error).message || e);
    console.warn('[data] hydrate failed', e);
  }
  listeners.forEach((l) => l());
}

export const DATA_KEYS = [
  'interviewSessions',
  'examSessions',
  'resumes',
  'goals',
  'materials',
  'localUser',
  'interviewPreference',
  'questionBanks',
  'feedback',
] as const;

async function persist(key: string, value: unknown) {
  if (dataError) throw new Error(`数据读取失败，已阻止覆盖：${dataError}`);
  if (nativeData()) {
    const expected = cache.get(key) ?? null;
    const { invoke } = await import('@tauri-apps/api/core');
    try { applySnapshot(await invoke('cmd_data_commit', { key, expected, value })); }
    catch (error) { await refreshData().catch(() => {}); throw error; }
    return;
  }
  const store = await getStore();
  const previous = await store.get<unknown>(key);
  try {
    await store.set(key, value);
    await store.save();
  } catch (e) {
    if (previous === undefined) await store.delete(key);
    else await store.set(key, previous);
    throw new Error(`数据保存失败，请检查磁盘和文件权限：${String((e as Error).message || e)}`);
  }
  cache.set(key, value);
  listeners.forEach((l) => l());
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('ml-data-changed', { key, value });
  } catch {
    // 非 Tauri 环境忽略
  }
}

/** 订阅其它窗口的数据变更（跨窗口同步会话/记录） */
export async function initDataSync() {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    if (nativeData()) {
      await listen('ml-data-revision', () => { void refreshData().catch(error => { dataError = String(error); listeners.forEach(listener => listener()); }); });
      return;
    }
    await listen<{ key: string; value: unknown }>('ml-data-changed', (e) => {
      cache.set(e.payload.key, e.payload.value);
      listeners.forEach((l) => l());
    });
  } catch {
    // 忽略
  }
}

export function readData<T>(key: string, fallback: T): T {
  const v = cache.get(key);
  return v === undefined ? fallback : (v as T);
}

export { persist as writeData };
export function useData<T>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => readData(key, fallback),
    () => fallback,
  );
  return [value, (v: T) => { void persist(key, v).catch(error => {
    void import('./events').then(({ bus }) => bus.emit('toast', { type: 'error', title: '数据保存失败', description: String(error.message || error) }));
  }); }];
}

export async function saveFeedback(text: string) {
  const trimmed = text.trim();
  if (trimmed.length < 4 || trimmed.length > 2000) throw new Error('反馈请输入 4～2000 个字符');
  await persist('feedback', [...readData<{id:string; text:string; createdAt:number}[]>('feedback', []), {id:uid('feedback'), text:trimmed, createdAt:Date.now()}]);
}

function uid(prefix = 'id'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------- 实体类型（沿用原版字段名） ----------------

export type ChatRole = 'INTERVIEWER' | 'ASSISTANT';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: number;
  metadata?: { turnKind?: 'NEW' | 'CONT' | 'SKIP'; webSearch?: { queries: string[]; sources: string[] } };
  pending?: boolean;
}

export interface InterviewSession {
  id: string;
  type: 'INTERVIEW' | 'MOCK_INTERVIEW';
  title: string;
  goalId?: string | null;
  resumeId?: string | null;
  createdAt: number;
  endedAt?: number | null;
  status: 'ACTIVE' | 'COMPLETED';
  messages: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface ExamQuestion {
  id: string;
  questionText: string;
  answer: string;
  createdAt: number;
}

export interface ExamSessionRecord {
  id: string;
  title: string;
  goalId?: string | null;
  createdAt: number;
  endedAt?: number | null;
  status: 'ACTIVE' | 'COMPLETED';
  questions: ExamQuestion[];
  outcome?: 'PASSED' | 'FAILED' | 'WAITING' | null;
  mode?: string;
}

export interface Resume {
  id: string;
  title: string;
  createdAt: number;
  isSample?: boolean;
  /** 提取的文本摘要（供 AI prompt 用） */
  summary?: string;
  content?: string;
  document?: Omit<ImportedDocument, 'text'>;
}

export interface Goal {
  id: string;
  name: string;
  companyName?: string;
  description?: string;
  createdAt: number;
}

export interface MaterialEntry {
  id: string;
  question: string;
  answer: string;
}

export interface Material {
  id: string;
  name: string;
  content: string;
  source: 'official' | 'ai' | 'file' | 'manual';
  createdAt: number;
  updatedAt: number;
  entries: MaterialEntry[];
}

// ---------------- CRUD ----------------

export async function createSession(
  s: Omit<InterviewSession, 'id' | 'createdAt' | 'status' | 'messages'> & { messages?: ChatMessage[] },
): Promise<InterviewSession> {
  const sessions = readData<InterviewSession[]>('interviewSessions', []);
  const full: InterviewSession = {
    messages: [],
    ...s,
    id: uid('sess'),
    createdAt: Date.now(),
    status: 'ACTIVE',
  };
  await persist('interviewSessions', [full, ...sessions]);
  return full;
}

export async function updateSession(id: string, patch: Partial<InterviewSession>) {
  const sessions = readData<InterviewSession[]>('interviewSessions', []);
  await persist(
    'interviewSessions',
    sessions.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  );
}

export async function completeSession(id: string) {
  await updateSession(id, { status: 'COMPLETED', endedAt: Date.now() });
}

export function getActiveSessionLocal(type: 'INTERVIEW' | 'MOCK_INTERVIEW'): InterviewSession | null {
  const sessions = readData<InterviewSession[]>('interviewSessions', []);
  return sessions.find((s) => s.type === type && s.status === 'ACTIVE') ?? null;
}

/**
 * 清理陈旧的「进行中」记录：浮窗没在运行时，上一场不可能还活着。
 * 与原版「结束旧会话」等价，避免工作台被假的活动会话拦住。
 * 模拟面试不依赖浮窗（独立窗口、可跨重启续场），因此不在此清理。
 */
export async function closeStaleActiveSessions() {
  const sessions = readData<InterviewSession[]>('interviewSessions', []);
  const staleInterviews = sessions.filter((s) => s.status === 'ACTIVE' && s.type !== 'MOCK_INTERVIEW');
  if (staleInterviews.length > 0) {
    await persist(
      'interviewSessions',
      sessions.map((s) =>
        s.status === 'ACTIVE' && s.type !== 'MOCK_INTERVIEW' ? { ...s, status: 'COMPLETED', endedAt: Date.now() } : s,
      ),
    );
  }
  const exams = readData<ExamSessionRecord[]>('examSessions', []);
  const staleExams = exams.filter((s) => s.status === 'ACTIVE');
  if (staleExams.length > 0) {
    await persist(
      'examSessions',
      exams.map((s) => (s.status === 'ACTIVE' ? { ...s, status: 'COMPLETED', endedAt: Date.now() } : s)),
    );
  }
}

export async function createExamSession(
  s: Omit<ExamSessionRecord, 'id' | 'createdAt' | 'status' | 'questions'> & { questions?: ExamQuestion[] },
): Promise<ExamSessionRecord> {
  const list = readData<ExamSessionRecord[]>('examSessions', []);
  const full: ExamSessionRecord = {
    questions: [],
    ...s,
    id: uid('exam'),
    createdAt: Date.now(),
    status: 'ACTIVE',
  };
  await persist('examSessions', [full, ...list]);
  return full;
}

export async function updateExamSession(id: string, patch: Partial<ExamSessionRecord>) {
  const list = readData<ExamSessionRecord[]>('examSessions', []);
  await persist(
    'examSessions',
    list.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  );
}

export async function completeExamSession(id: string) {
  await updateExamSession(id, { status: 'COMPLETED', endedAt: Date.now() });
}

export async function saveGoal(g: Omit<Goal, 'id' | 'createdAt'> & { id?: string }): Promise<Goal> {
  const goals = readData<Goal[]>('goals', []);
  if (g.id) {
    const next = goals.map((x) => (x.id === g.id ? { ...x, ...g, id: x.id } : x));
    await persist('goals', next);
    return next.find((x) => x.id === g.id)!;
  }
  const full: Goal = { ...g, id: uid('goal'), createdAt: Date.now() };
  await persist('goals', [full, ...goals]);
  return full;
}

export async function deleteGoal(id: string) {
  const goals = readData<Goal[]>('goals', []);
  await persist('goals', goals.filter((g) => g.id !== id));
}

export async function ensureGoal(name: string, companyName?: string): Promise<Goal> {
  const goals = readData<Goal[]>('goals', []);
  const found = goals.find(
    (g) => g.name === name && (!companyName || g.companyName === companyName),
  );
  if (found) return found;
  return saveGoal({ name, companyName: companyName || '' });
}

export async function saveResume(r: { id?: string; title: string; summary?: string; content?: string; document?: Resume['document']; isSample?: boolean }): Promise<Resume> {
  const resumes = readData<Resume[]>('resumes', []);
  if (r.id) {
    const next = resumes.map((x) => (x.id === r.id ? { ...x, ...r, id: x.id, summary: r.summary ?? x.summary } : x));
    await persist('resumes', next);
    return next.find((x) => x.id === r.id)!;
  }
  const full: Resume = {
    id: uid('res'),
    title: r.title,
    summary: r.summary,
    content: r.content,
    document: r.document,
    isSample: r.isSample,
    createdAt: Date.now(),
  };
  await persist('resumes', [...resumes, full]);
  return full;
}

export async function deleteResume(id: string) {
  const resumes = readData<Resume[]>('resumes', []);
  await persist('resumes', resumes.filter((r) => r.id !== id));
}

export async function saveMaterial(m: { id?: string; name?: string; content?: string; source?: Material['source'] }): Promise<Material> {
  const materials = readData<Material[]>('materials', []);
  if (m.id) {
    const next = materials.map((x) =>
      x.id === m.id
        ? { ...x, name: m.name ?? x.name, content: m.content ?? x.content, updatedAt: Date.now() }
        : x,
    );
    await persist('materials', next);
    return next.find((x) => x.id === m.id)!;
  }
  const full: Material = {
    id: uid('mat'),
    name: m.name ?? '未命名资料',
    content: m.content ?? '',
    source: m.source ?? 'manual',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    entries: [],
  };
  await persist('materials', [full, ...materials]);
  return full;
}

export async function deleteMaterial(id: string) {
  const materials = readData<Material[]>('materials', []);
  await persist('materials', materials.filter((m) => m.id !== id));
}

export async function saveEntry(materialId: string, entry: { id?: string; question: string; answer: string }) {
  const materials = readData<Material[]>('materials', []);
  const next = materials.map((m) => {
    if (m.id !== materialId) return m;
    if (entry.id) {
      return {
        ...m,
        updatedAt: Date.now(),
        entries: m.entries.map((e) => (e.id === entry.id ? { ...e, ...entry, id: e.id } : e)),
      };
    }
    return {
      ...m,
      updatedAt: Date.now(),
      entries: [...m.entries, { ...entry, id: uid('entry') }],
    };
  });
  await persist('materials', next);
}

export async function deleteEntry(materialId: string, entryId: string) {
  const materials = readData<Material[]>('materials', []);
  await persist(
    'materials',
    materials.map((m) =>
      m.id === materialId ? { ...m, entries: m.entries.filter((e) => e.id !== entryId) } : m,
    ),
  );
}

/** 预置示例数据（首次启动，原版 onboarding default data 同概念） */
export async function ensureDefaultData() {
  const resumes = readData<Resume[]>('resumes', []);
  const goals = readData<Goal[]>('goals', []);
  const materials = readData<Material[]>('materials', []);
  if (resumes.length === 0) {
    await saveResume({
      title: '示例简历',
      isSample: true,
      summary: [
        '计算机科学与技术 本科',
        '后端开发方向，熟悉 Java / Spring Boot、MySQL、Redis、消息队列',
        '项目：电商订单系统（订单服务核心开发，QPS 峰值 3k，主从延迟优化）',
        '实习：某互联网公司后端组，参与库存超卖治理',
      ].join('\n'),
    });
  }
  if (goals.length === 0) {
    await saveGoal({ name: '后端工程师', companyName: '', description: '' });
  }
  if (materials.length === 0) {
    const m = await saveMaterial({ name: '自我介绍模板', source: 'manual' });
    await saveEntry(m.id, {
      question: '请做一个简短的自我介绍',
      answer:
        '面试官您好，我是计算机专业的应届生，主攻后端方向。在校期间做过一个电商订单系统，负责订单服务的核心链路，压测到过 3k QPS；实习时参与库存超卖治理，用 Redis 分布式锁加消息队列削峰把超卖率降到零。我的特点是基础扎实、喜欢刨根问底，希望能加入贵司继续深入后端方向。',
    });
  }
}

export async function cleanupDefaultData() {
  const resumes = readData<Resume[]>('resumes', []);
  const materials = readData<Material[]>('materials', []);
  await persist('resumes', resumes.filter((r) => !r.isSample));
  await persist(
    'materials',
    materials.filter((m) => m.name !== '自我介绍模板'),
  );
}
