/**
 * 从笔试题目文本里提取评测约束（时间/空间限制、数据规模）。
 *
 * 只做保守的显式匹配：题面没写就返回空，绝不猜测。
 */
export interface ExamConstraints {
  /** 时间限制，毫秒。 */
  timeMs?: number;
  /** 空间/内存限制，MB。 */
  memoryMb?: number;
  /** 数据规模片段，例如「n ≤ 1e5」。 */
  scale?: string;
}

const TIME = /(?:时间限制|运行时?间限制|time\s*limit)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒|sec|seconds?)/i;
const MEMORY = /(?:空间限制|内存限制|memory\s*limit)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(mb|m|兆|gb|g|kb)/i;
const SCALE = /(?:数据范围|数据规模|输入规模|约束|constraints?)\s*[:：]\s*([^\n]{1,80})/i;
const BOUND = /((?:\d+(?:\.\d+)?\s*(?:≤|<=|=<|＜|<)\s*)?[a-z][\w.]{0,14}\s*(?:≤|<=|=<|＜|<)\s*\d[\w.]*(?:\s*(?:≤|<=|=<|＜|<)\s*[\w.]+)?)/i;

function toMs(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === 's' || normalized === '秒' || normalized.startsWith('sec')) return Math.round(value * 1000);
  return Math.round(value);
}

function toMb(value: number, unit: string): number {
  const normalized = unit.toLowerCase();
  if (normalized === 'gb' || normalized === 'g') return Math.round(value * 1024);
  if (normalized === 'kb') return Math.round(value / 1024);
  return Math.round(value);
}

export function parseExamConstraints(text: string | undefined | null): ExamConstraints {
  if (!text) return {};
  const result: ExamConstraints = {};
  const time = TIME.exec(text);
  if (time) {
    const value = Number(time[1]);
    if (Number.isFinite(value) && value > 0) result.timeMs = toMs(value, time[2]);
  }
  const memory = MEMORY.exec(text);
  if (memory) {
    const value = Number(memory[1]);
    if (Number.isFinite(value) && value > 0) result.memoryMb = toMb(value, memory[2]);
  }
  const scale = SCALE.exec(text)?.[1] ?? BOUND.exec(text)?.[1];
  if (scale) result.scale = scale.replace(/\s+/g, ' ').trim().slice(0, 80);
  return result;
}

function formatTime(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
}

/** 拼成一句可注入提示词的约束说明；没有约束时返回空串。 */
export function describeConstraints(constraints: ExamConstraints): string {
  const parts: string[] = [];
  if (constraints.timeMs) parts.push(`时间限制 ${formatTime(constraints.timeMs)}`);
  if (constraints.memoryMb) parts.push(`空间限制 ${constraints.memoryMb}MB`);
  if (constraints.scale) parts.push(`规模 ${constraints.scale}`);
  return parts.length ? parts.join('，') : '';
}

/** 交给模型的自检要求：先看约束够不够，再决定给哪一版代码。 */
export function constraintBrief(constraints: ExamConstraints): string {
  const described = describeConstraints(constraints);
  const head = described
    ? `题面约束（来自题目原文，必须满足）：${described}。`
    : '题面没有写明时间/空间限制：以截图里印出的限制为准；确实没有就按常见在线评测的量级（1–2 秒、256MB，n ≤ 1e5）做保守估计，并在回答里说明你的假设。';
  return `${head}\n交付前先做复杂度自检：按最坏情况估算时间与空间复杂度，判断在当前限制和数据规模下是否安全。`
    + '\n回答里必须有一行「复杂度：时间 O(…)、空间 O(…)，对照上述限制是安全/偏紧/不达标」；'
    + '如果偏紧或不达标，先给满足限制的解法，再说明取舍，不要交一个自己都知道会超时的版本。';
}
