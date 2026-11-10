/**
 * 对话附件：把用户拖进来的 PDF、图片、文本解析成可发送的文字片段。
 *
 * Self-contained implementation that reuses the document import pipeline (local PDF
 * text extraction, vision OCR for images) so chat and the library agree on limits.
 *
 * Nothing is persisted here: the conversation stores the <file> blocks themselves.
 */
import { importDocument } from './documentImport';
import { t } from './i18n';

export type ChatFileKind = 'pdf' | 'image' | 'text';

export interface ChatAttachment {
  id: string;
  name: string;
  size: number;
  kind: ChatFileKind;
  text: string;
}

export const CHAT_ATTACH_ACCEPT = '.pdf,.txt,.md,.png,.jpg,.jpeg,.webp';
/** 一条消息最多附带的文件数量：再多也会被正文上限挡住，提前说清楚。 */
export const CHAT_ATTACH_MAX = 6;

/** Per-file limit. A whole long document would crowd out the conversation. */
export const CHAT_FILE_CHARS = 20000;
/** Total limit for all attachments in one message. */
export const CHAT_FILES_CHARS = 40000;

const FILE_BLOCK = /<file name="([^"]*)">\n?([\s\S]*?)\n?<\/file>/g;

export function chatFileKind(name: string): ChatFileKind | null {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(extension)) return 'image';
  if (extension === 'txt' || extension === 'md') return 'text';
  return null;
}

export async function readChatAttachment(file: File, signal?: AbortSignal): Promise<ChatAttachment> {
  const kind = chatFileKind(file.name);
  if (!kind) throw new Error(t('对话附件支持 PDF、图片（PNG/JPEG/WebP）、TXT 和 Markdown。'));
  // allowVision only affects images: picking a file here means the user agreed to OCR it.
  const document = await importDocument(file, { allowVision: true, signal });
  return {
    id: `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: file.name,
    size: file.size,
    kind,
    text: document.text.slice(0, CHAT_FILE_CHARS),
  };
}

/** Joins attachments in order, truncating the tail and noting how much was dropped. */
export function composeAttachmentContent(text: string, attachments: readonly ChatAttachment[]): string {
  if (!attachments.length) return text;
  let budget = CHAT_FILES_CHARS;
  const blocks: string[] = [];
  for (const attachment of attachments) {
    if (budget <= 0) break;
    const body = attachment.text.slice(0, budget);
    budget -= body.length;
    const truncated = body.length < attachment.text.length ? `\n…(truncated, ${attachment.text.length} chars in the original)` : '';
    blocks.push(`<file name="${attachment.name}">\n${body}${truncated}\n</file>`);
  }
  return [text.trim(), ...blocks].filter(Boolean).join('\n\n');
}

export interface ParsedFile {
  name: string;
  body: string;
  chars: number;
}

/** Splits a stored message into prose and attachment blocks. */
export function splitAttachments(content: string): { text: string; files: ParsedFile[] } {
  const files: ParsedFile[] = [];
  const text = content.replace(FILE_BLOCK, (_match, name: string, body: string) => {
    files.push({ name, body, chars: body.length });
    return '';
  });
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), files };
}

/** Files referenced anywhere in the conversation, newest wins per name. */
export function conversationFiles(messages: readonly { content: string }[]): ParsedFile[] {
  const byName = new Map<string, ParsedFile>();
  for (const message of messages) for (const file of splitAttachments(message.content).files) byName.set(file.name, file);
  return [...byName.values()];
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
