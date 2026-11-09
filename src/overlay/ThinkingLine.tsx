import { DwellDisclosure } from './widgets';
import { estimateFirstToken } from '@/lib/latencyStats';
import { t } from '@/lib/i18n';

/** 超过这么久没收到任何数据就变色：区分「模型在想」和「连接静默」。 */
const QUIET_WARN_SEC = 8;

export interface ThinkingLineProps {
  /** 本次请求已经过去的秒数 */
  elapsedSec: number;
  /** 已收到的思维链字数，0 表示连思维链都还没开始 */
  chars: number;
  /** 思维链尾部预览 */
  preview: string;
  /** 距离上一次收到数据过了多少秒 */
  quietSec: number;
  /** 该模型的首字耗时中位数（毫秒），用于给出预期 */
  firstTokenMs?: number | null;
  modelId?: string | null;
  /** 驻留热区 id：同一窗口可能有多条消息同时在等，必须唯一 */
  zoneId?: string;
}
/**
 * 「模型正在干活」的进度行：笔试与面试共用。
 * 只读展示，不参与任何状态推进；穿透模式下靠驻留展开完整思维链。
 */
export function ThinkingLine({ elapsedSec, chars, preview, quietSec, firstTokenMs, modelId, zoneId = 'live-reasoning' }: ThinkingLineProps) {
  const estimate = Math.round((firstTokenMs ?? estimateFirstToken(modelId ?? undefined) ?? 0) / 1000) || 0;
  const quiet = quietSec >= QUIET_WARN_SEC;
  const slow = chars === 0 && estimate > 0 && elapsedSec > estimate * 1.5;
  const tone = quiet || slow ? 'var(--ov-warn, #d97706)' : undefined;
  return (
    <div className="mb-2" role="status" data-testid="thinking-line">
      <div className="ov-text-2 flex items-center gap-1.5 text-[11px]">
        <span className="ov-dot size-1.5 animate-pulse rounded-full" style={tone ? { background: tone } : undefined} />
        <span style={tone ? { color: tone } : undefined}>
          {chars > 0
            ? t('思考中 · 已 {s} 秒 · 思考 {n} 字', { s: elapsedSec, n: chars })
            : t('已发送，等待模型响应 · 已 {s} 秒', { s: elapsedSec })}
          {quiet && t(' · 已安静 {q} 秒', { q: quietSec })}
        </span>
      </div>
      {chars === 0 && estimate > 0 && (
        <div className="ov-text-3 mt-0.5 text-[10px] opacity-70">
          {slow ? t('比平时慢一些，可以继续等或取消回答') : t('通常 {e} 秒内出字', { e: estimate })}
        </div>
      )}
      {preview && (
        <>
          <div className="ov-text-3 mt-1 line-clamp-3 text-[10.5px] leading-relaxed opacity-75">
            {preview.replace(/\s+/g, ' ').trim()}
          </div>
          <DwellDisclosure id={zoneId} label={t('查看思考过程')} className="mt-1">
            <div className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words leading-relaxed">
              {preview}
            </div>
          </DwellDisclosure>
        </>
      )}
    </div>
  );
}
