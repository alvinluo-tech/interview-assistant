import { getAiSettings, getAiLoadError } from './aiSettings';
import { resolveAiRoute, usesLiveSpeech, type AiRole, type AiRoute } from './aiConfig';
import { aiFetch } from './aiTransport';
import { AiCompletionError, aiHeaders, consumeChatResult, withAiRequest } from './aiProtocol';
import {PROMPT_VERSION,outputLimit,checkInputBudget,estimateInputTokens,retryDelay,type AiTask,type AiRequestTrace} from './aiTaskPolicy';
import { recordTokenSample } from './tokenCalibration';
import {applyTaskInstructions,type TaskPreferences} from './taskPrompts';
import {getSetting} from './store';
import { recognizeSpeech, type TranscriptionOptions } from './speechProtocol';
import { requestSpeech, type SpeechConsumer } from './ttsProtocol';
import type {SpeechRenderSpec} from './speechProfile';
import { t } from './i18n';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
}
export interface ChatOptions {
  messages: ChatMessage[];
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** 思维链增量：只用来显示「还在思考」的进度，不进回答正文。 */
  onReasoning?: (text: string) => void;
  temperature?: number;
  maxTokens?: number;
  task?:AiTask;
  schema?:{name:string;schema:Record<string,unknown>};
  onTrace?:(trace:AiRequestTrace)=>void;
  /** One-off route for this request (free chat lets each conversation pick a model). */
  model?:AiRoute;
}
function route(role: AiRole, override?:AiRoute) {
  if (getAiLoadError()) throw new Error(t('AI 配置读取失败，请到「设置 → AI 服务」查看并重试'));
  const settings = getAiSettings();
  return { settings, ...resolveAiRoute(settings, role, override) };
}
function waitForRetry(ms:number,signal?:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason || new DOMException('Aborted','AbortError'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
}
async function stream(role: 'chat' | 'vision', opts: ChatOptions): Promise<string> {
  const { settings, provider, modelId } = route(role, opts.model);
  const capabilities=provider.models.find(model=>model.id===modelId)?.capabilities;
  const task=opts.task || (role==='vision'?'exam-solve':'interview-answer');
  const messages=applyTaskInstructions(opts.messages,task,getSetting<TaskPreferences>('ai.taskPreferences',{}));
  const trace:AiRequestTrace={id:globalThis.crypto?.randomUUID?.() || `req-${Date.now()}-${Math.random()}`,task,promptVersion:PROMPT_VERSION,providerId:provider.id,modelId,startedAt:Date.now(),elapsedMs:0,completionStatus:'unknown'};
  // 任务上限同时约束调用方传入的 maxTokens（例如语音对话），避免绕过上下文窗口预算。
  const taskLimit=outputLimit(task,capabilities);
  let limit=Math.min(opts.maxTokens || taskLimit, taskLimit);
  const outputParameter=capabilities?.outputParameter || 'max_tokens';
  const format=opts.schema&&capabilities?.structuredOutput==='json_schema'?{type:'json_schema',json_schema:{...opts.schema,strict:true}}:
    opts.schema&&capabilities?.structuredOutput==='json_object'?{type:'json_object'}:undefined;
  try {
  checkInputBudget(messages,limit,capabilities);
  let emitted=false;
  const recoverableTask=['interview-answer','exam-solve','exam-followup'].includes(task);
  // 流式响应默认不带 usage，要显式要求；个别网关不认识这个字段，撞错就退回不请求用量。
  let streamUsage=true;
  for(let attempt=0;;attempt++){
  opts.signal?.throwIfAborted();
  try {
  return await withAiRequest(provider, 'chat/completions', {
    method: 'POST', headers: aiHeaders(provider, true),
    body: JSON.stringify({ model: modelId, messages, stream: true,
      ...(opts.temperature === undefined || capabilities?.temperature===false ? {} : { temperature: opts.temperature }),
      ...(outputParameter==='none'?{}:{[outputParameter]:limit}),...(format?{response_format:format}:{}),
      ...(streamUsage?{stream_options:{include_usage:true}}:{}),
    }),
  }, settings.timeoutMs, async (response,pending,touch) => {
    // 流式请求的超时按「多久没数据」算：思考模型先安静几十秒是常态，按总时长掐断会白扔一次完整回答。
    const result=await consumeChatResult(response,delta=>{emitted=true;trace.firstOutputMs ??= Date.now()-trace.startedAt;opts.onDelta?.(delta);},pending,(thought)=>{emitted=true;opts.onReasoning?.(thought);},touch);
    trace.completionStatus=result.completionStatus;trace.finishReason=result.finishReason;Object.assign(trace,result.usage);
    // 用真实 prompt_tokens 反推估算误差，供下一次预算换算。
    void recordTokenSample(modelId,estimateInputTokens(messages),result.usage?.inputTokens);
    return result.text;
  }, aiFetch, opts.signal, true);
  } catch(error){
    const message=String((error as Error)?.message || error);
    // 思考模型把整份预算花在思维链上：finish_reason=length 但正文一个字都没有。
    // 原样重发只会再撞一次上限，必须抬高预算；上限受模型能力与上下文窗口双重约束。
    if(error instanceof AiCompletionError && error.completionStatus==='truncated' && !error.partialText && attempt<2){
      const ceiling=Math.min(capabilities?.maxOutputTokens || 32768, capabilities?.contextWindow ? Math.max(1024,Math.floor(capabilities.contextWindow/3)) : 32768);
      const raised=Math.min(ceiling, Math.max(limit+2048, limit*2));
      if(raised>limit){ limit=raised; continue; }
    }
    if(!emitted && streamUsage && /stream_options|include_usage/i.test(message)){
      streamUsage=false;
      continue;
    }
    if(!emitted && attempt===0 && limit>1024 && /max_(?:completion_)?tokens/i.test(message)){
      limit=Math.max(1024,Math.floor(limit/2));
      continue;
    }
    const delay=recoverableTask&&!emitted&&attempt===0&&!opts.signal?.aborted?retryDelay(error,attempt):null;
    if(delay===null || Date.now()-trace.startedAt+delay>=settings.timeoutMs)throw error;
    await waitForRetry(delay,opts.signal);
  }
  }
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
/** Same streaming path as chatWithImages, but keeps the whole conversation and only attaches images to the last user turn. */
export async function chatWithImageHistory(messages: ChatMessage[], imageDataUrls: string[], opts: Omit<ChatOptions,'messages'>) {
  const list = messages.slice();
  const last = list[list.length-1];
  if (!last || last.role !== 'user') throw new Error(t('图片只能附带在用户消息上。'));
  const text = typeof last.content === 'string' ? last.content : last.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  list[list.length-1] = { role: 'user', content: [
    { type: 'text', text },
    ...imageDataUrls.map(url => ({ type: 'image_url' as const, image_url: { url } })),
  ] };
  return stream('vision', { ...opts, messages: list });
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
export async function synthesizeSpeech(text: string, signal?: AbortSignal,render?:SpeechRenderSpec): Promise<ArrayBuffer | null> {
  // TTS is explicitly optional; configured-but-failed requests still surface errors.
  if (!getAiSettings().routes.tts) return null;
  const chunks: Uint8Array[] = []; let pcm = true, size = 0;
  await streamSpeech(text,signal,chunk => {pcm = pcm && chunk.format === 'pcm16';chunks.push(chunk.bytes);size += chunk.bytes.length;},render);
  if (!size) return null;
  if (pcm && size % 2) throw new Error(t('语音音频数据不完整，请重新朗读。'));
  if (!pcm && chunks.length > 1) throw new Error(t('长问题包含多个音频文件，请使用面试官的流式播放入口。'));
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

export async function streamSpeech(text: string, signal: AbortSignal | undefined, consume: SpeechConsumer,render?:SpeechRenderSpec): Promise<void> {
  const {settings,provider,modelId} = route('tts');
  const connect=/^cosyvoice/.test(modelId)&&/^(?:dashscope-intl\.aliyuncs\.com|[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com)$/.test(new URL(provider.baseUrl).hostname)?(await import('./realtimeTransport')).connectRealtimeSocket:undefined;
  await requestSpeech(provider,modelId,text,settings.ttsVoice,aiFetch,settings.timeoutMs,signal,consume,render,connect);
}

export { createQuestionSpeaker } from './questionSpeaker';
