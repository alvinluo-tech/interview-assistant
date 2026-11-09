import { getSetting, setSetting } from './store';

/**
 * 首字耗时统计：按模型记最近若干次「请求发出 → 第一个 token」的毫秒数，
 * 界面用它告诉用户「通常 N 秒出字」，减少「是不是卡死了」的焦虑。
 * 只存中位数需要的样本，不记录任何提示词或答案内容。
 */
const SAMPLES_KEY = 'ai.firstTokenMs';
const LAST_MODEL_KEY = 'ai.firstTokenLastModel';
const MAX_SAMPLES = 20;
/** 少于这个样本数就不显示预估：一两次偶然的慢请求给出的数字比没有更误导。 */
const MIN_SAMPLES = 3;

type SampleMap = Record<string, number[]>;

function load(): SampleMap {
  const stored = getSetting<SampleMap>(SAMPLES_KEY, {});
  return stored && typeof stored === 'object' ? stored : {};
}

export function recordFirstToken(modelId: string | undefined, ms: number | undefined): void {
  if (!modelId || ms === undefined || !Number.isFinite(ms)) return;
  const rounded = Math.round(ms);
  if (rounded <= 0 || rounded > 600_000) return;
  const all = { ...load() };
  all[modelId] = [...(all[modelId] ?? []), rounded].slice(-MAX_SAMPLES);
  void setSetting(SAMPLES_KEY, all).catch(() => {});
  void setSetting(LAST_MODEL_KEY, modelId).catch(() => {});
}

/**
 * 中位数：平均会被偶尔的超长思考拉偏，而用户感知的是「一般多久」。
 * 不传 modelId 时用最近一次真实请求的模型——界面在请求发出前就要给出预期，
 * 那一刻还拿不到本次请求的 modelId。
 */
export function estimateFirstToken(modelId?: string): number | null {
  const key = modelId || getSetting<string>(LAST_MODEL_KEY, '');
  if (!key) return null;
  const samples = load()[key] ?? [];
  if (samples.length < MIN_SAMPLES) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
