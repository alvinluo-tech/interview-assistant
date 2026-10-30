import { getAiSettings, getAiLoadError } from './aiSettings';
import { resolveAiRoute, usesLiveSpeech, type AiRole } from './aiConfig';
import { aiFetch } from './aiTransport';
import { aiHeaders, consumeChat, withAiRequest } from './aiProtocol';
import { recognizeSpeech, type TranscriptionOptions } from './speechProtocol';
import { requestSpeech, type SpeechConsumer } from './ttsProtocol';

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
export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
  // TTS is explicitly optional; configured-but-failed requests still surface errors.
  if (!getAiSettings().routes.tts) return null;
  const chunks: Uint8Array[] = []; let pcm = true, size = 0;
  await streamSpeech(text,signal,chunk => {pcm = pcm && chunk.format === 'pcm16';chunks.push(chunk.bytes);size += chunk.bytes.length;});
  if (!size) return null;
  if (pcm && size % 2) throw new Error('语音音频数据不完整，请重新朗读。');
  if (!pcm && chunks.length > 1) throw new Error('长问题包含多个音频文件，请使用面试官的流式播放入口。');
  // Keep the legacy whole-file API usable by callers outside the streaming interviewer.
  const output = new Uint8Array(size + (pcm ? 44 : 0));let offset = pcm ? 44 : 0;
  for (const chunk of chunks) {output.set(chunk,offset);offset += chunk.length;}
  if (pcm) {
    const view = new DataView(output.buffer);
    for (const [at,value] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const) for(let i=0;i<value.length;i++) output[at+i]=value.charCodeAt(i);
    view.setUint32(4,size+36,true);view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);
    view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);view.setUint32(40,size,true);
  }
  return output.buffer;
}

export async function streamSpeech(text: string, signal: AbortSignal | undefined, consume: SpeechConsumer): Promise<void> {
  const {settings,provider,modelId} = route('tts');
  await requestSpeech(provider,modelId,text,settings.ttsVoice,aiFetch,settings.timeoutMs,signal,consume);
}

export { createQuestionSpeaker } from './questionSpeaker';
