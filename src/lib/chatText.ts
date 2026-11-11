/**
 * Text helpers for chat transcripts: attachment blocks and conversation titles.
 *
 * Kept free of runtime dependencies so the unit tests can load exactly this file.
 */

/** `<file name="report.pdf">…</file>` blocks that carry attachment bodies. */
export const FILE_BLOCK = /<file name="([^"]*)">\n?([\s\S]*?)\n?<\/file>/g;

const FENCED_CODE = /```[\s\S]*?```/g;

/**
 * Content the user actually typed, with the attachment blocks removed.
 *
 * Titles are derived from this so a conversation never shows `<file name="…">`
 * markup in the sidebar. Titles saved before this helper existed can be cut off
 * inside a block, so an unterminated opening tag drops the rest of the text.
 */
export function stripAttachmentBlocks(text: string): string {
  return text
    .replace(FILE_BLOCK, ' ')
    .replace(/<file\b[\s\S]*$/, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First meaningful line of a message, used as the conversation title. */
export function chatTitle(text: string, limit = 32): string {
  const cleaned = stripAttachmentBlocks(text.replace(FENCED_CODE, ' ')).replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, limit);
}

/** Clock label (local time, 24h) for a message, or an empty string when unknown. */
export function formatClock(at: number | undefined): string {
  if (!at || !Number.isFinite(at)) return '';
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
