/**
 * 用户长期记忆：跨会话保留的稳定事实（目标岗位、技术栈、项目数字、明确偏好与禁忌）。
 *
 * 只注入「用户自己确认过」的条目，模型不再根据旧对话自行发挥；条目可编辑、可删除，
 * 全部存在本机，不随请求发给第三方以外的任何服务。
 */
import type { AiRoute } from './aiConfig';
import { getSetting, setSetting } from './store';

export interface MemoryFact {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

const STORE_KEY = 'memory.facts';
const MAX_FACTS = 60;
const MAX_TEXT = 200;
/** 注入提示词的字符上限：记忆是背景，不能挤掉当前问题和参考数据。 */
const INJECT_BUDGET = 1200;

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

function normalize(facts: unknown): MemoryFact[] {
  if (!Array.isArray(facts)) return [];
  return facts
    .filter((fact): fact is MemoryFact => !!fact && typeof fact === 'object' && typeof (fact as MemoryFact).text === 'string' && !!(fact as MemoryFact).text.trim())
    .map(fact => ({
      id: String(fact.id || ''),
      text: clean(fact.text),
      createdAt: Number(fact.createdAt) || Date.now(),
      updatedAt: Number(fact.updatedAt) || Number(fact.createdAt) || Date.now(),
    }))
    .filter(fact => fact.text)
    .slice(0, MAX_FACTS);
}

let cache: MemoryFact[] | null = null;

export function listMemory(): MemoryFact[] {
  return (cache ??= normalize(getSetting<unknown>(STORE_KEY, [])));
}

async function persist(facts: MemoryFact[]): Promise<MemoryFact[]> {
  cache = facts;
  await setSetting(STORE_KEY, facts);
  return facts;
}

/** 去重后再追加：同一句话反复提炼不会越积越多。 */
export async function addMemory(texts: string[]): Promise<MemoryFact[]> {
  const facts = [...listMemory()];
  const seen = new Set(facts.map(fact => fact.text.replace(/\s+/g, '')));
  for (const raw of texts) {
    const text = clean(raw);
    const key = text.replace(/\s+/g, '');
    if (!text || seen.has(key)) continue;
    seen.add(key);
    facts.push({ id: `f${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, text, createdAt: Date.now(), updatedAt: Date.now() });
  }
  // 超出上限时丢最早加的，用户仍可在设置里手动补回来。
  return persist(facts.slice(-MAX_FACTS));
}

export async function updateMemory(id: string, text: string): Promise<MemoryFact[]> {
  const next = clean(text);
  if (!next) return deleteMemory(id);
  return persist(listMemory().map(fact => (fact.id === id ? { ...fact, text: next, updatedAt: Date.now() } : fact)));
}

export async function deleteMemory(id: string): Promise<MemoryFact[]> {
  return persist(listMemory().filter(fact => fact.id !== id));
}

/** 测试用：丢掉内存缓存，模拟重启后从设置读回。 */
export function resetMemory(): void {
  cache = null;
}

/**
 * 注入提示词的记忆块。按占用字符从新到旧装，超出预算的旧条目省略并说明，避免模型以为记忆只有这些。
 */
export function memoryBlock(): string {
  const facts = listMemory();
  if (!facts.length) return '';
  const lines: string[] = [];
  let used = 0;
  let skipped = 0;
  for (const fact of [...facts].reverse()) {
    const line = `- ${fact.text}`;
    if (used + line.length > INJECT_BUDGET) {
      skipped += 1;
      continue;
    }
    used += line.length + 1;
    lines.push(line);
  }
  return [
    '【用户长期记忆（用户自己维护的稳定事实，可能过时；与当前对话冲突时以当前对话为准，不要据此编造细节）】',
    ...lines,
    ...(skipped ? [`（另有 ${skipped} 条较早记忆因长度限制未列出）`] : []),
  ].join('\n');
}

const EXTRACT_SYSTEM = '从给定的对话里提炼值得长期记住的稳定事实：目标岗位与时间线、技术栈与年限、重要项目的规模与数字、明确的偏好与禁忌、已经确认的结论。不要记录一次性题目内容、临时情绪或寒暄，不要推测对话里没说的事。每条不超过 60 字，用「主语 + 事实」的中文短句。最多 6 条。只输出 JSON 字符串数组，例如 ["…","…"]，不要输出解释或代码围栏。';

/** 从最近的对话里提炼候选记忆；返回空数组表示没有值得记的。 */
export async function extractMemory(messages: { role: string; content: string }[], options: { model?: AiRoute; signal?: AbortSignal } = {}): Promise<string[]> {
  const { chatStream } = await import('./aiRequests');
  const transcript = messages
    .slice(-20)
    .map(message => `${message.role === 'user' ? '用户' : '助手'}：${message.content.slice(0, 1500)}`)
    .join('\n');
  if (transcript.trim().length < 20) return [];
  const text = await chatStream({
    task: 'free-chat',
    messages: [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: transcript },
    ],
    signal: options.signal ?? new AbortController().signal,
    ...(options.model ? { model: options.model } : {}),
    maxTokens: 400,
  });
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').map(clean).filter(text => text.length >= 4).slice(0, 6);
  } catch {
    return [];
  }
}

export const MEMORY_LIMITS = { MAX_FACTS, MAX_TEXT, INJECT_BUDGET };
