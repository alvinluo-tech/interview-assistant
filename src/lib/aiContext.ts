/** Task-scoped context. Archive history is never trimmed or rewritten by these selectors. */
interface HistoryMessage {
    id: string;
    role: string;
    text: string;
    pending?: boolean;
    metadata?: {
        superseded?: boolean;
        completionStatus?: string;
        origin?: string;
    };
}
export function assembleInterviewHistory(messages: HistoryMessage[], question: string, options: {
    throughMessageId?: string;
    maxChars?: number;
} = {}) {
    const cutoff = options.throughMessageId ? messages.findIndex(message => message.id === options.throughMessageId) : -1;
    const past = (cutoff >= 0 ? messages.slice(0, cutoff) : messages).filter(message => !message.pending && !message.metadata?.superseded && message.text.trim());
    const selected: {
        role: 'user' | 'assistant';
        content: string;
    }[] = [];
    const groups: typeof selected[] = [];
    let remaining = options.maxChars ?? 18000;
    for (let i = 0; i < past.length; i++) {
        const message = past[i];
        if (i === past.length - 1 && message.role === 'INTERVIEWER' && message.text.trim() === question.trim())
            continue;
        if (message.metadata?.completionStatus === 'refused')
            continue;
        const content = (message.metadata?.completionStatus === 'truncated' ? '【上一轮未完整生成，仅作背景】\n' : '') +
            (message.metadata?.origin === 'candidate_response' ? '【候选人明确补充的实际回答，更新前提时优先于 AI 建议】\n' : '') + message.text;
        if (message.role === 'INTERVIEWER' || !groups.length)
            groups.push([]);
        groups[groups.length - 1].push({ role: message.role === 'INTERVIEWER' || message.metadata?.origin === 'candidate_response' ? 'user' : 'assistant', content });
    }
    for (let i = groups.length - 1; i >= 0; i--) {
        const size = groups[i].reduce((sum, message) => sum + message.content.length, 0);
        if (size > remaining) {
            if (i === groups.length - 1)
                throw new Error('上一轮完整问答超过当前上下文预算，请减少本轮资料或使用更大窗口的模型；历史记录仍完整保留。');
            break;
        }
        selected.unshift(...groups[i]);
        remaining -= size;
    }
    return [...selected, { role: 'user' as const, content: question }];
}
interface ExamContextTurn {
    id: string;
    parentTurnId?: string;
    questionText?: string;
    body: string;
}
export function assembleExamContext(turns: ExamContextTurn[], targetTurnId: string, maxChars = 28000): string {
    const target = turns.find(turn => turn.id === targetTurnId);
    if (!target)
        throw new Error('没有找到这道题，请重新选择问题。');
    const rootId = target.parentTurnId || target.id;
    const root = turns.find(turn => turn.id === rootId) || target;
    const chain = turns.filter(turn => turn.id === root.id || turn.parentTurnId === root.id);
    const targetIndex = chain.findIndex(turn => turn.id === target.id);
    const relevant = chain.slice(0, targetIndex + 1);
    const source = `【原题与约束】\n${root.questionText || '题干未单独提取，请结合原图。'}`;
    const latest = `【当前解答 / 代码】\n${target.body}`;
    if (source.length + latest.length > maxChars)
        throw new Error('当前题干和完整代码超过上下文预算，请选择需要检查的代码范围；原记录完整保留。');
    const blocks = [source];
    let used = source.length + latest.length;
    for (const turn of relevant.slice(0, -1).reverse()) {
        const block = `【本题此前解答】\n${turn.body}`;
        if (block.length + used + 4 <= maxChars) {
            blocks.splice(1, 0, block);
            used += block.length + 4;
        }
    }
    return [...blocks, latest].join('\n\n');
}
