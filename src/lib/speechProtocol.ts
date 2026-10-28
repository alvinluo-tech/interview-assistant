import { assertFileTranscriptionModel, speechProtocol, type AiProvider } from './aiConfig.js';
import { aiHeaders, consumeChat, transcriptionLanguage, withAiRequest, type AiFetch } from './aiProtocol.js';

export interface TranscriptionOptions {
  lang?: string;
  signal?: AbortSignal;
  /** Only transcript text deltas; reasoning and metadata must never appear as subtitles. */
  onDelta?: (text: string) => void;
}

export async function recognizeSpeech(provider: AiProvider, modelId: string, wav: Blob, options: TranscriptionOptions,
  fetcher: AiFetch, timeoutMs: number): Promise<string> {
  assertFileTranscriptionModel(provider, modelId);
  const language = transcriptionLanguage(options.lang);
  if (speechProtocol(modelId) === 'mimo') {
    const bytes = new Uint8Array(await wav.arrayBuffer());
    options.signal?.throwIfAborted();
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return withAiRequest(provider, 'chat/completions', {
      method: 'POST', headers: aiHeaders(provider, true),
      body: JSON.stringify({ model: modelId, stream: true,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${btoa(binary)}` } }] }],
        asr_options: { language: language === 'zh' || language === 'en' ? language : 'auto' },
      }),
    }, timeoutMs, response => consumeChat(response, options.onDelta), fetcher, options.signal);
  }
  const form = new FormData();
  form.append('file', wav, 'audio.wav');
  form.append('model', modelId);
  if (language) form.append('language', language);
  return withAiRequest(provider, 'audio/transcriptions', { method: 'POST', headers: aiHeaders(provider), body: form }, timeoutMs, async response => {
    const json = await response.json();
    if (typeof json.text !== 'string') throw new Error('转写接口未返回 text 字段');
    const text = json.text.trim();
    if (text) options.onDelta?.(text);
    return text;
  }, fetcher, options.signal);
}

/** Join adjacent short-window hypotheses, removing only exact overlapping suffixes. */
export function joinTranscript(prefix: string, next: string): string {
  if (!prefix) return next;
  if (!next) return prefix;
  for (let length = Math.min(80, prefix.length, next.length); length >= 2; length--) {
    if (prefix.endsWith(next.slice(0, length))) return prefix + next.slice(length);
  }
  const space = /[a-z0-9]$/i.test(prefix) && /^[a-z0-9]/i.test(next) ? ' ' : '';
  return prefix + space + next;
}
