import { useId } from 'react';
import type { AiRequestTrace } from '@/lib/aiTaskPolicy';
import { t } from '@/lib/i18n';
import { DwellDisclosure } from './widgets';
/** Optional diagnostics: no prompts, personal documents or credentials are exposed. */
export function GenerationDetails({ status, request }: {
    status?: string;
    request?: AiRequestTrace;
}) {
    // 每条消息一个稳定 zone id：穿透模式下也能悬停展开「生成信息」。
    const disclosureId = useId().replace(/[^a-zA-Z0-9_-]/g, '');
    const label = ({ truncated: '回答未完整生成', refused: '模型未完成请求', failed: '生成失败', cancelled: '已停止，内容可能不完整', unknown: '接口未提供完成标记' } as Record<string, string>)[status || ''];
    if (!label && !request)
        return null;
    return <div className="ov-text-3 mt-1 text-[10px]">
    {label && <span role="status">{t(label)}</span>}
    {request && <DwellDisclosure id={`generation-${disclosureId}`} label={t('生成信息')} className="mt-1">
      <div className="break-all leading-relaxed">{t('{model} · {s} 秒', { model: request.modelId, s: (request.elapsedMs / 1000).toFixed(1) })}
        {request.firstOutputMs !== undefined && t(' · 首字 {s} 秒', { s: (request.firstOutputMs / 1000).toFixed(1) })}
        {request.inputTokens !== undefined && t(' · 输入 {n} tokens', { n: request.inputTokens })}
        {request.outputTokens !== undefined && t(' · 输出 {n} tokens', { n: request.outputTokens })}
        {request.cachedTokens !== undefined && t(' · 命中缓存 {n} tokens', { n: request.cachedTokens })}
        {request.reasoningTokens !== undefined && t(' · 思考 {n} tokens', { n: request.reasoningTokens })}
        <br />{t('提示版本 {v} · 请求 {id}', { v: request.promptVersion, id: request.id })}
      </div>
    </DwellDisclosure>}
  </div>;
}
