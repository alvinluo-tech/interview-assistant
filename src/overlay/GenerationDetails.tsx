import type { AiRequestTrace } from '@/lib/aiTaskPolicy';
/** Optional diagnostics: no prompts, personal documents or credentials are exposed. */
export function GenerationDetails({ status, request }: {
    status?: string;
    request?: AiRequestTrace;
}) {
    const label = ({ truncated: '回答未完整生成', refused: '模型未完成请求', failed: '生成失败', cancelled: '已停止，内容可能不完整', unknown: '接口未提供完成标记' } as Record<string, string>)[status || ''];
    if (!label && !request)
        return null;
    return <div className="ov-text-3 mt-1 text-[10px]">
    {label && <span role="status">{label}</span>}
    {request && <details className="mt-1"><summary className="cursor-pointer">生成信息</summary>
      <div className="mt-1 break-all leading-relaxed">{request.modelId} · {(request.elapsedMs / 1000).toFixed(1)} 秒
        {request.firstOutputMs !== undefined && ` · 首字 ${(request.firstOutputMs / 1000).toFixed(1)} 秒`}
        {request.inputTokens !== undefined && ` · 输入 ${request.inputTokens} tokens`}
        {request.outputTokens !== undefined && ` · 输出 ${request.outputTokens} tokens`}
        {request.cachedTokens !== undefined && ` · 命中缓存 ${request.cachedTokens} tokens`}
        <br />提示版本 {request.promptVersion} · 请求 {request.id}
      </div>
    </details>}
  </div>;
}
