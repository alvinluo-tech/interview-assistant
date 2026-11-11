/**
 * 用服务端回传的 prompt_tokens 校准本地估算器。
 *
 * 估算器（aiTaskPolicy.estimateInputTokens）把全角字符按 1 token/字、半角按 3 字/token 计，
 * 对中文普遍偏保守：真实分词常把 1.5 个汉字并成一个 token。估算偏大只会少装几轮历史，
 * 但偏小会撞窗口被拒，所以按模型记录「实际 / 估算」比值，拿它反过来调整预算。
 *
 * 只在样本足够时才生效，并按指数滑动平均吸收波动，避免一次脏数据毁掉预算。
 */
import { getSetting, setSetting } from './store';

interface TokenSample {
  /** 实际 token / 估算 token */
  ratio: number;
  samples: number;
}

type TokenBook = Record<string, TokenSample>;

const STORE_KEY = 'ai.tokenCalibration';
const MIN_SAMPLES = 3;
const MAX_SAMPLES = 20;
const MIN_RATIO = 0.5;
const MAX_RATIO = 3;

let book: TokenBook | null = null;

function load(): TokenBook {
  return (book ??= getSetting<TokenBook>(STORE_KEY, {}));
}

/** 同一模型在不同供应商下的分词一致，按模型 ID 归并；带命名空间的取最后一段。 */
function modelKey(modelId: string): string {
  return modelId.trim().toLowerCase().split('/').pop() || modelId.trim().toLowerCase();
}

function clamp(value: number): number {
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value));
}

/**
 * 预算换算系数：把「估算 token 预算」换算成「需要留出的真实 token」。
 * 返回 1 表示没有可用样本，调用方按原预算走。
 */
export function tokenScale(modelId?: string | null): number {
  if (!modelId) return 1;
  const sample = load()[modelKey(modelId)];
  if (!sample || sample.samples < MIN_SAMPLES) return 1;
  return clamp(sample.ratio);
}

/** 记一次真实用量。估算值与实际值都缺失时静默跳过。 */
export async function recordTokenSample(modelId: string | null | undefined, estimated: number, actual: number | undefined): Promise<void> {
  if (!modelId || !Number.isFinite(estimated) || estimated <= 0 || actual === undefined || !Number.isFinite(actual) || actual <= 0) return;
  const next = { ...load() };
  const key = modelKey(modelId);
  const previous = next[key];
  const ratio = clamp(actual / estimated);
  next[key] = {
    ratio: previous ? Number((previous.ratio * 0.7 + ratio * 0.3).toFixed(3)) : Number(ratio.toFixed(3)),
    samples: Math.min(MAX_SAMPLES, (previous?.samples ?? 0) + 1),
  };
  book = next;
  try {
    await setSetting(STORE_KEY, next);
  } catch {
    // 校准值只是优化项：写不进去就用内存里的值，不影响请求。
  }
}

/** 测试用：清掉内存缓存，模拟重启。 */
export function resetTokenCalibration(): void {
  book = null;
}
