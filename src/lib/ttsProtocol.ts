import { normalizeProvider, type AiProvider } from './aiConfig.js';
import { aiHeaders, withAiRequest, type AiFetch } from './aiProtocol.js';
import { bailianRegion } from './realtimeAsrProtocol.js';
import { defaultTtsVoice, ttsService } from './ttsConfig.js';
import {resolveSpeechVoice} from './speechCatalog.js';
import type {SpeechRenderSpec} from './speechProfile';
import {requestBailianSpeechSocket} from './ttsSocket.js';
import type {RealtimeConnect} from './realtimeAsrProtocol';

export interface SpeechAudioChunk { format: 'pcm16' | 'encoded'; bytes: Uint8Array; sampleRate?: number }
export type SpeechConsumer = (chunk: SpeechAudioChunk) => void | Promise<void>;
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

/** Preserve every code point, preferring sentence boundaries within the service's 600-character limit. */
export function splitSpeechText(text: string): string[] {
  const points = Array.from(text.trim());
  if (points.length > 20000) throw new Error('朗读内容过长，请缩短到两万字以内。');
  const chunks: string[] = [];
  while (points.length) {
    let length = Math.min(500, points.length);
    if (length < points.length) {
      for (let i = length - 1; i >= 200; i--) {
        if (/[。！？!?；;\n]/u.test(points[i])) {length = i + 1; break;}
      }
    }
    chunks.push(points.splice(0, length).join(''));
  }
  return chunks;
}
function decodeAudio(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length > MAX_AUDIO_BYTES * 1.4) throw new Error('语音接口返回的音频数据无效或过大。');
  try {return Uint8Array.from(atob(value), char => char.charCodeAt(0));}
  catch {throw new Error('语音接口返回了无效的 Base64 音频。');}
}
async function boundedBytes(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error('语音接口没有返回音频。');
  const reader = response.body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  const abort = () => {void reader.cancel().catch(() => {});};
  signal.addEventListener('abort', abort, {once:true});
  try {
    while (true) {
      signal.throwIfAborted(); const result = await reader.read(); signal.throwIfAborted();
      if (result.done) break;
      length += result.value.length;
      if (length > MAX_AUDIO_BYTES) throw new Error('语音音频超过 32 MB，请缩短问题。');
      parts.push(result.value);
    }
  } finally {signal.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock();}
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) {bytes.set(part, offset); offset += part.length;}
  return bytes;
}
/** No credentials or cookies may accompany a service-generated download URL. */
async function downloadAudio(value: string, fetcher: AiFetch, signal: AbortSignal): Promise<Uint8Array> {
  const url = new URL(value);
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port
    || !/^dashscope-result[\w-]*\.oss-(?:cn-beijing|ap-southeast-1)\.aliyuncs\.com$/.test(url.hostname)) {
    throw new Error('语音服务返回了非官方音频下载地址，已停止播放。');
  }
  url.protocol = 'https:';
  const response = await fetcher(url.href, {method:'GET',headers:{},credentials:'omit',redirect:'error',signal});
  if (!response.ok) throw new Error(`语音文件下载失败（HTTP ${response.status}）。`);
  return boundedBytes(response, signal);
}

export async function requestSpeech(provider: AiProvider, model: string, text: string, voice: string,
  fetcher: AiFetch, timeoutMs: number, signal: AbortSignal | undefined, onAudio: SpeechConsumer,render?:SpeechRenderSpec,connect?:RealtimeConnect): Promise<void> {
  const normalized = normalizeProvider(provider), service = ttsService(normalized, model);
  if (/^mimo-.*tts-(?:voiceclone|voicedesign)/i.test(model)) throw new Error('此 MiMo 模型需要音色复刻或设计参数；请选择 mimo-v2.5-tts 使用预置音色。');
  if (service !== 'compatible' && /(?:^|-)realtime(?:-|$)/i.test(model)) throw new Error('此 realtime 模型需要独立的实时接口；请选择同系列不带 realtime 的语音合成模型。');
  const resolved=render?resolveSpeechVoice(normalized,model,voice,render):undefined;
  const selectedVoice = resolved?.voice || (voice === 'alloy' && service !== 'compatible' ? defaultTtsVoice(normalized,model) : voice.trim());
  if (!selectedVoice) throw new Error('请为语音模型填写可用的音色 ID。');
  let total = 0;
  const push: SpeechConsumer = async chunk => {
    signal?.throwIfAborted(); total += chunk.bytes.byteLength;
    if (total > MAX_AUDIO_BYTES) throw new Error('语音音频超过 32 MB，请缩短问题。');
    if (chunk.bytes.length) await onAudio(chunk);
  };
  if(service==='bailian'&&/^cosyvoice/i.test(model)&&bailianRegion(new URL(normalized.baseUrl).hostname)==='singapore'){
    if(!connect)throw new Error('新加坡 CosyVoice 需要桌面 WebSocket 语音连接。');
    for(const segment of splitSpeechText(text))await requestBailianSpeechSocket(normalized,model,segment,selectedVoice,render,resolved?.useInstruction?resolved.instruction:undefined,signal,push,timeoutMs,connect);
    return;
  }
  const segments = splitSpeechText(text);
  for (const segment of service === 'compatible' && segments.length ? [text.trim()] : segments) {
    signal?.throwIfAborted();
    const native = service === 'qwen' || service === 'bailian';
    // Retain the configured region AND workspace host; never send its key to another origin.
    const target = native ? {...normalized,baseUrl:`${new URL(normalized.baseUrl).origin}/api/v1`} : normalized;
    const endpoint = service === 'mimo' ? 'chat/completions' : service === 'qwen' ? 'services/aigc/multimodal-generation/generation'
      : service === 'bailian' ? 'services/audio/tts/SpeechSynthesizer' : 'audio/speech';
    const headers = aiHeaders(normalized,true);
    if (native) headers['X-DashScope-SSE'] = 'enable';
    const body = service === 'mimo' ? {model,stream:true,messages:[
      {role:'user',content:(resolved?.instruction || '请用自然、专业、友好的面试官语气朗读，只朗读给定文本，不添加内容。')+(render?` 语速约为正常速度的 ${render.rate} 倍。`:'')},
      {role:'assistant',content:segment}],audio:{format:'pcm16',voice:selectedVoice}}
      : native ? {model,input:{text:segment,voice:selectedVoice,...(service === 'bailian' ? {format:'pcm',sample_rate:24000,
          ...(render?{rate:render.rate,language_hints:[render.language==='en-US'?'en':'zh']}:{}),...(resolved?.useInstruction?{instruction:resolved.instruction}:{})}
          : {language_type:resolved?.languageHint || 'Auto'})}}
        : {model,input:segment,voice:selectedVoice};
    await withAiRequest(target,endpoint,{method:'POST',headers,body:JSON.stringify(body)},timeoutMs,async (response, pending) => {
      if (service === 'compatible') {
        const bytes = await boundedBytes(response,pending);
        if (response.headers.get('content-type')?.includes('json')) throw new Error('语音接口返回了 JSON，预期为音频文件。');
        if (!bytes.length) throw new Error('语音服务未返回音频。');
        await push({format:'encoded',bytes}); return;
      }
      let received = 0, finalUrl = '', finished = false;
      const parse = async (data: string) => {
        pending.throwIfAborted();
        if (data === '[DONE]') {finished = true; return;}
        let json;
        try {json = JSON.parse(data);} catch {throw new Error('语音服务返回了无效的流式数据。');}
        if (json.error || (json.code && json.code !== 'Success') || (json.status_code && json.status_code !== 200)) {
          throw new Error(json.error?.message || json.message || '语音合成失败，请检查模型与音色。');
        }
        const audio = service === 'mimo' ? (json.choices?.[0]?.delta?.audio || json.choices?.[0]?.message?.audio) : json.output?.audio;
        if (audio?.data) {
          const bytes = decodeAudio(audio.data); received += bytes.length;
          await push({format:'pcm16',sampleRate:24000,bytes});
        }
        if (typeof audio?.url === 'string') finalUrl = audio.url;
        if (json.output?.finish_reason === 'stop' || json.choices?.[0]?.finish_reason === 'stop') finished = true;
      };
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('语音接口未返回音频流。');
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', data: string[] = [];
        const abort = () => {void reader.cancel().catch(() => {});};
        pending.addEventListener('abort',abort,{once:true});
        const line = async (value: string) => {
          if (!value) {if (data.length) {const event = data.join('\n'); data = []; await parse(event);} return;}
          if (value.startsWith('data:')) data.push(value.slice(5).trimStart());
          if (data.reduce((length,part)=>length+part.length,0) > 4*1024*1024) throw new Error('语音服务返回的单条消息过大。');
        };
        try {
          while (!finished) {
            pending.throwIfAborted(); const result = await reader.read(); pending.throwIfAborted();
            buffer += result.done ? decoder.decode() : decoder.decode(result.value,{stream:true});
            let index;
            while (!finished && (index=buffer.indexOf('\n')) >= 0) {await line(buffer.slice(0,index).replace(/\r$/,'')); buffer=buffer.slice(index+1);}
            if (buffer.length > 4*1024*1024) throw new Error('语音服务返回的单条消息过大。');
            if (result.done) {if(buffer.trim()) await line(buffer.replace(/\r$/,''));await line('');break;}
          }
        } finally {pending.removeEventListener('abort',abort); await reader.cancel().catch(()=>{}); reader.releaseLock();}
        if (!finished) throw new Error('语音连接提前结束，请重试朗读。');
      } else await parse(JSON.stringify(await response.json()));
      if (!received && finalUrl && native) {
        const bytes = await downloadAudio(finalUrl,fetcher,pending); received = bytes.length;
        await push({format:service === 'bailian' ? 'pcm16' : 'encoded',sampleRate:24000,bytes});
      }
      if (!received) throw new Error('语音服务未返回音频，请检查所选模型和音色。');
    },fetcher,signal);
  }
}
