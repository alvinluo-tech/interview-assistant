/**
 * Splits streamed answers into speakable sentences so playback can start on the first one.
 * Fenced code is dropped: reading code aloud is very slow and rarely useful.
 */
const TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '\n']);
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':']);
const MAX_SPOKEN_CHARS = 160;

function clean(piece: string): string {
  return piece
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLong(piece: string): string[] {
  if (piece.length <= MAX_SPOKEN_CHARS) return [piece];
  const parts: string[] = [];
  let rest = piece;
  while (rest.length > MAX_SPOKEN_CHARS) {
    let cut = -1;
    for (let index = 0; index < MAX_SPOKEN_CHARS; index += 1) if (SOFT_BREAKS.has(rest[index])) cut = index + 1;
    if (cut <= 0) cut = MAX_SPOKEN_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

export function takeSentences(source: string): { ready: string[]; rest: string } {
  const ready: string[] = [];
  let start = 0;
  let fence = false;
  let index = 0;
  const push = (piece: string) => {
    const spoken = clean(piece);
    if (!spoken || !/[\p{L}\p{N}]/u.test(spoken)) return;
    ready.push(...splitLong(spoken));
  };
  while (index < source.length) {
    if (source.startsWith('```', index)) { fence = !fence; index += 3; continue; }
    const char = source[index];
    if (!fence && TERMINATORS.has(char)) {
      push(source.slice(start, index + 1));
      start = index + 1;
    }
    index += 1;
  }
  return { ready, rest: source.slice(start) };
}
