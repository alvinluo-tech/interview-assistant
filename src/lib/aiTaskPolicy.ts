export type AiTask = 'free-chat' | 'interview-answer' | 'exam-solve' | 'exam-followup' | 'mock-question' | 'mock-hint' | 'mock-report' | 'question-bank' | 'document-extract' | 'translation';
export const PROMPT_VERSION = '2026-10-30.1';
export const TASK_OUTPUT_LIMIT: Record<AiTask, number> = {
    'free-chat': 4096,
    translation: 4096,
    'interview-answer': 1800, 'exam-solve': 8192, 'exam-followup': 8192, 'mock-question': 768,
    'mock-hint': 1024, 'mock-report': 6144, 'question-bank': 8192, 'document-extract': 12000,
};
export interface ModelCapabilities {
    contextWindow?: number;
    maxOutputTokens?: number;
    outputParameter?: 'max_tokens' | 'max_completion_tokens' | 'none';
    structuredOutput?: 'text' | 'json_object' | 'json_schema';
    temperature?: boolean;
}
export interface AiRequestTrace {
    id: string;
    task: AiTask;
    promptVersion: string;
    providerId: string;
    modelId: string;
    startedAt: number;
    elapsedMs: number;
    firstOutputMs?: number;
    completionStatus: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
}
export function outputLimit(task: AiTask, capabilities?: ModelCapabilities): number {
    return Math.min(TASK_OUTPUT_LIMIT[task], capabilities?.maxOutputTokens || Infinity, capabilities?.contextWindow ? Math.max(256, Math.floor(capabilities.contextWindow / 3)) : Infinity);
}
/** Conservative planning estimate, not provider billing usage or a universal tokenizer. */
export function estimateInputTokens(messages: {
    content: string | Array<{
        type: string;
        text?: string;
    }>;
}[]): number {
    return 16 + messages.reduce((sum, message) => sum + 8 + (typeof message.content === 'string' ? estimateText(message.content) :
        message.content.reduce((total, part) => total + (part.type === 'text' ? estimateText(part.text || '') : 1536), 0)), 0);
}
function estimateText(text: string): number {
    const wide = (text.match(/[^\x00-\xff]/g) || []).length;
    return wide + Math.ceil((text.length - wide) / 3);
}
export function checkInputBudget(messages: {
    content: string | Array<{
        type: string;
        text?: string;
    }>;
}[], outputTokens: number, capabilities?: ModelCapabilities): void {
    if (!capabilities?.contextWindow)
        return;
    if (estimateInputTokens(messages) + outputTokens + 256 > capabilities.contextWindow)
        throw new Error('本次资料、问答与输出预算可能超过所选模型的上下文窗口。请使用更大窗口的模型，或减少本轮参考资料；完整历史仍保留。');
}
/** Only retry pre-output, transient failures. Invalid configuration and malformed content require intervention. */
export function retryDelay(error: unknown, attempts: number): number | null {
    if (attempts >= 2 || (error as Error)?.name === 'AbortError')
        return null;
    const message = String((error as Error)?.message || error);
    if (!/HTTP (?:408|429|500|502|503|504)\b/.test(message))
        return null;
    return Math.min(8000, 1500 * 2 ** attempts);
}
