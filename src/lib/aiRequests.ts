import { getAiSettings, getAiLoadError } from './aiSettings';
import { resolveAiRoute, usesLiveSpeech, type AiRole } from './aiConfig';
import { aiFetch } from './aiTransport';
import { aiHeaders, consumeChatResult, withAiRequest } from './aiProtocol';
import {PROMPT_VERSION,outputLimit,checkInputBudget,type AiTask,type AiRequestTrace} from './aiTaskPolicy';
import {applyTaskInstructions,type TaskPreferences} from './taskPrompts';
import {getSetting} from './store';
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
  task?:AiTask;
  schema?:{name:string;schema:Record<string,unknown>};
  onTrace?:(trace:AiRequestTrace)=>void;
}
function route(role: AiRole) {
  if (getAiLoadError()) throw new Error('AI 配置读取失败，请到「设置 → AI 服务」查看并重试');
  const settings = getAiSettings();
  return { settings, ...resolveAiRoute(settings, role) };
}
async function stream(role: 'chat' | 'vision', opts: ChatOptions): Promise<string> {
  const { settings, provider, modelId } = route(role);
  const capabilities=provider.models.find(model=>model.id===modelId)?.capabilities;
  const task=opts.task || (role==='vision'?'exam-solve':'interview-answer');
  const messages=applyTaskInstructions(opts.messages,task,getSetting<TaskPreferences>('ai.taskPreferences',{}));
  const trace:AiRequestTrace={id:globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random()}`,task,promptVersion:PROMPT_VERSION,providerId:provider.id,modelId,startedAt:Date.now(),elapsedMs:0,completionStatus:'unknown'};
  const limit=Math.min(opts.maxTokens || outputLimit(task,capabilities),capabilities?.maxOutputTokens || Infinity);
  const outputParameter=capabilities?.outputParameter || 'max_tokens';
  const format=opts.schema&&capabilities?.structuredOutput==='json_schema'?{type:'json_schema',json_schema:{...opts.schema,strict:true}}:
    opts.schema&&capabilities?.structuredOutput==='json_object'?{type:'json_object'}:undefined;
  try {
  checkInputBudget(messages,limit,capabilities);
  return await withAiRequest(provider, 'chat/completions', {
    method: 'POST', headers: aiHeaders(provider, true),
    body: JSON.stringify({ model: modelId, messages, stream: true,
      ...(opts.temperature === undefined || capabilities?.temperature===false ? {} : { temperature: opts.temperature }),
      ...(outputParameter==='none'?{}:{[outputParameter]:limit}),...(format?{response_format:format}:{}),
    }),
  }, settings.timeoutMs, async (response,pending) => {
    const result=await consumeChatResult(response,delta=>{trace.firstOutputMs ??= Date.now()-trace.startedAt;opts.onDelta?.(delta);},pending);
    trace.completionStatus=result.completionStatus;trace.finishReason=result.finishReason;Object.assign(trace,result.usage);
    return result.text;
  }, aiFetch, opts.signal);
  }catch(error){trace.completionStatus=opts.signal?.aborted?'cancelled':(error as {completionStatus?:string}).completionStatus || 'failed';throw error;}
  finally {trace.elapsedMs=Date.now()-trace.startedAt;opts.onTrace?.({...trace});}
}
export async function chatStream(opts: ChatOptions) { return stream('chat', opts); }
export async function chatWithImages(prompt: string, imageDataUrls: string[], opts?: Omit<ChatOptions,'messages'> & {system?:string}) {
  const messages: ChatMessage[] = [];
  if (opts?.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: [
    { type: 'text', text: prompt },
    ...imageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
  ] });
  return stream('vision', { ...opts,messages });
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
