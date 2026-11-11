/**
 * 对话历史的预算装配：整轮进出，绝不只剩半句问答。
 * 预算按 token 估（与 aiTaskPolicy 同一套口径），因此对中英文混排的对话都成立。
 */
import { estimateInputTokens } from './aiTaskPolicy';

export interface ChatTurnLike { role: string; content: string }

export interface SelectedTurns<T> {
  /** 最近若干轮，原样保留（含最新一条用户消息）。 */
  recent: T[];
  /** 因预算未纳入的较早消息条数。 */
  omitted: number;
  /** 因预算未纳入的较早字符数，用于给用户一个量级。 */
  omittedChars: number;
  /** 因预算未纳入的较早消息本身，供摘要使用。 */
  older: T[];
}

/** 一条用户消息开启一轮；其后的助手消息并入本轮。 */
function groupTurns<T extends ChatTurnLike>(messages: T[]): T[][] {
  const turns: T[][] = [];
  for (const message of messages) {
    if (message.role === 'user' || !turns.length) turns.push([message]);
    else turns[turns.length - 1].push(message);
  }
  return turns;
}

/**
 * 从最新一轮往前装，装不下就停；最新一轮无论多大都保留，
 * 否则模型会看不到用户刚说的话。
 */
export function selectChatTurns<T extends ChatTurnLike>(messages: T[], maxTokens: number): SelectedTurns<T> {
  const turns = groupTurns(messages);
  let index = turns.length - 1;
  let used = 0;
  for (; index >= 0; index--) {
    const cost = estimateInputTokens(turns[index].map(message => ({ content: message.content })));
    if (index < turns.length - 1 && used + cost > maxTokens) break;
    used += cost;
  }
  const kept = turns.slice(index + 1);
  const dropped = turns.slice(0, index + 1);
  return {
    recent: kept.flat(),
    omitted: dropped.reduce((sum, turn) => sum + turn.length, 0),
    omittedChars: dropped.reduce((sum, turn) => sum + turn.reduce((size, message) => size + message.content.length, 0), 0),
    older: dropped.flat(),
  };
}

/** 单条消息不小于这个长度就截断：粘贴的整份文档不该把一次请求撑成几百万字符。 */
export const MAX_MESSAGE_CHARS = 60000;

export function clampMessage(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n…(已截断，原文 ${text.length} 字符)` : text;
}
