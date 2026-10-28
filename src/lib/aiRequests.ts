import { getAiSettings, getAiLoadError } from './aiSettings';
import { resolveAiRoute, usesLiveSpeech, type AiRole } from './aiConfig';
import { aiFetch } from './aiTransport';
import { aiHeaders, consumeChat, withAiRequest } from './aiProtocol';
import { recognizeSpeech, type TranscriptionOptions } from './speechProtocol';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}
export interface ChatOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  temperature?: number;
  maxTokens?: number;
}
function route(role: AiRole) {
  if (getAiLoadError()) throw new Error('AI 配置读取失败，请到「设置 → AI 服务」查看并重试');
  const settings = getAiSettings();
  return { settings, ...resolveAiRoute(settings, role) };
}
function stream(role: 'chat' | 'vision', opts: ChatOptions): Promise<string> {
  const { settings, provider, modelId } = route(role);
  return withAiRequest(provider, 'chat/completions', {
    method: 'POST', headers: aiHeaders(provider, true),
    body: JSON.stringify({ model: modelId, messages: opts.messages, stream: true,
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts.maxTokens === undefined ? {} : { max_tokens: opts.maxTokens }),
    }),
  }, settings.timeoutMs, r => consumeChat(r, opts.onDelta), aiFetch, opts.signal);
}
export async function chatStream(opts: ChatOptions) { return stream('chat', opts); }
export async function chatWithImages(prompt: string, imageDataUrls: string[], opts?: { signal?: AbortSignal; onDelta?: (t: string) => void; system?: string }) {
  const messages: ChatMessage[] = [];
  if (opts?.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: [
    { type: 'text', text: prompt },
    ...imageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
  ] });
  return stream('vision', { messages, signal: opts?.signal, onDelta: opts?.onDelta });
}
export function liveSpeechEnabled() { return usesLiveSpeech(getAiSettings()); }
export async function transcribeAudio(wav: Blob, opts: TranscriptionOptions = {}): Promise<string> {
  if (getAiSettings().speechInputMode === 'realtime') {
    const { recognizeRealtimeWav } = await import('./realtimeAsr');
    return recognizeRealtimeWav(wav, opts);
  }
  const { settings, provider, modelId } = route('stt');
  return recognizeSpeech(provider, modelId, wav, opts, aiFetch, settings.timeoutMs);
}
export async function synthesizeSpeech(text: string): Promise<ArrayBuffer | null> {
  // TTS is explicitly optional; configured-but-failed requests still surface errors.
  if (!getAiSettings().routes.tts) return null;
  const { settings, provider, modelId } = route('tts');
  return withAiRequest(provider, 'audio/speech', { method: 'POST', headers: aiHeaders(provider, true),
    body: JSON.stringify({ model: modelId, input: text, voice: settings.ttsVoice }),
  }, settings.timeoutMs, r => r.arrayBuffer(), aiFetch);
}
