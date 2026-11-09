import { t } from './i18n';
export const DEFAULT_REALTIME_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
export const REALTIME_ASR_MODELS = ['fun-asr-realtime', 'fun-asr-realtime-2026-02-28', 'paraformer-realtime-v2'] as const;
export function isRealtimeAsrModel(modelId: string): boolean {
  return REALTIME_ASR_MODELS.some(model => model === modelId);
}
export function bailianRegion(host: string): 'beijing' | 'singapore' | undefined {
  if (host === 'dashscope.aliyuncs.com' || /^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$/.test(host)) return 'beijing';
  if (host === 'dashscope-intl.aliyuncs.com' || /^[a-z0-9-]+\.ap-southeast-1\.maas\.aliyuncs\.com$/.test(host)) return 'singapore';
  return undefined;
}
export interface RealtimeSocket {
  addListener(callback: (message: { type: string; data: unknown }) => void): () => void;
  send(data: string | number[]): Promise<void>;
  disconnect(): Promise<void>;
}
export interface RealtimeConfig { endpoint?: string; apiKey: string; modelId: string; vocabularyId?: string; silenceMs?: number; language?: string; signal?: AbortSignal }
export interface RealtimeResult { text: string; isFinal: boolean; id: string;beginMs?:number;endMs?:number }
export interface RealtimeCallbacks { onResult(result: RealtimeResult): void; onError(error: Error): void; onState?(state: 'connecting' | 'ready' | 'reconnecting' | 'closed'): void }
export type RealtimeConnect = (url: string, options: { headers: Record<string, string>; maxMessageSize: number; maxFrameSize: number }) => Promise<RealtimeSocket>;

export function validateRealtimeEndpoint(value: string): string {
  const url = new URL(value || DEFAULT_REALTIME_ENDPOINT);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.port
      || url.pathname !== '/api-ws/v1/inference'
      || !bailianRegion(url.hostname)) {
    throw new Error(t('实时 ASR 仅支持百炼北京或新加坡地域的官方 WSS 地址，不接受查询参数或 URL 中的密钥。'));
  }
  return url.href;
}

/** Duplex PCM transport with a bounded two-second PCM backlog (not server recognition latency). */
export async function openRealtimeAsr(config: RealtimeConfig, connect: RealtimeConnect, callbacks: RealtimeCallbacks) {
  const endpoint = validateRealtimeEndpoint(config.endpoint || DEFAULT_REALTIME_ENDPOINT);
  if (!isRealtimeAsrModel(config.modelId)) throw new Error(t('持续实时模式请选择 Fun-ASR-Realtime 或 paraformer-realtime-v2；MiMo 请使用自动或分段模式。'));
  if (bailianRegion(new URL(endpoint).hostname) === 'singapore' && config.modelId !== 'fun-asr-realtime') throw new Error(t('新加坡持续实时识别请选择 fun-asr-realtime 稳定版；其他已适配模型请使用北京地域。'));
  if (!config.apiKey || /[\r\n\u0000]/.test(config.apiKey)) throw new Error(t('请填写有效的百炼 API Key。'));
  if (config.vocabularyId && !/^[\w-]{1,200}$/.test(config.vocabularyId)) throw new Error(t('百炼热词表 ID 格式无效。'));
  let socket: RealtimeSocket | null = null, removeListener: (() => void) | undefined;
  let closed = false, ready = false, epoch = 0, retries = 0, sendingEpoch:number|null = null, queuedBytes = 0, inFlightBytes = 0;
  let taskId = '', retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stableSince = 0;
  let queue: number[][] = [];
  const seen = new Set<string>(), finalTexts: string[] = [];
  let resolveStarted: (() => void) | undefined, rejectStarted: ((error: Error) => void) | undefined;
  let resolveFinished: (() => void) | undefined, rejectFinished: ((error: Error) => void) | undefined;
  let finishSent = false;
  const safeError = (error: unknown) => new Error(String((error as Error)?.message || error).split(config.apiKey).join('<redacted>').slice(0, 500));

  async function send(data: string | number[], target = socket) {
    if (!target) throw new Error(t('语音连接已断开'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([target.send(data), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t('语音发送超时'))), 3000); })]);
    } finally { clearTimeout(timer); }
  }

  async function detach() {
    ready = false; removeListener?.(); removeListener = undefined;
    const previous = socket; socket = null;
    if (previous) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([previous.disconnect().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, 1000); })]); }
      finally { clearTimeout(timer); }
    }
  }
  async function close() {
    if (closed) return;
    closed = true; epoch++; ready = false; queue = []; queuedBytes = 0; inFlightBytes = 0;
    clearTimeout(retryTimer); config.signal?.removeEventListener('abort', abort);
    rejectStarted?.(new DOMException(t('实时识别已取消'), 'AbortError'));
    // 取消时让等待定稿的 finish() 以 AbortError 结束，而不是把半截文本当成功。
    if (rejectFinished) rejectFinished(new DOMException(t('实时识别已取消'), 'AbortError'));
    else resolveFinished?.();
    resolveFinished = undefined; rejectFinished = undefined;
    const previous = socket;
    // finish-task 已由 finish() 发出时不要重复发送。
    if (previous && !finishSent) void previous.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } })).catch(() => {});
    await detach(); callbacks.onState?.('closed');
  }
  function abort() { void close(); }
  async function fail(error: unknown) { if (closed) return; const failure = safeError(error); await close(); callbacks.onError(failure); }
  function reconnect(error: unknown) {
    if (closed || retryTimer) return;
    // 连接稳定 10 秒就重新计数；60 秒对面试来说太长，网络抖动几次就会误判「多次中断」。
    if (ready && Date.now() - stableSince >= 10000) retries = 0;
    if (retries >= 3) { void fail(new Error(t('实时语音连接多次中断：{message}', { message: safeError(error).message }))); return; }
    ready = false; queue = []; queuedBytes = 0; inFlightBytes = 0;
    epoch++; void detach();
    callbacks.onState?.('reconnecting');
    const wait = Math.min(4000, 500 * 2 ** retries++);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void establish(true).catch(reconnect);
    }, wait);
  }
  function onMessage(message: { type: string; data: unknown }, connectionEpoch: number) {
    if (closed || connectionEpoch !== epoch) return;
    if (message.type === 'Close') {
      const error = new Error(t('语音连接已断开'));
      if (!ready) rejectStarted?.(error); else reconnect(error);
      return;
    }
    if (message.type !== 'Text' || typeof message.data !== 'string') return;
    try {
      const event = JSON.parse(message.data);
      if (event.header?.task_id !== taskId) return;
      const type = event.header?.event;
      if (type === 'task-started') { ready = true; stableSince = Date.now(); resolveStarted?.(); callbacks.onState?.('ready'); void drain(); }
      else if (type === 'task-finished') { if (resolveFinished) resolveFinished(); else reconnect(new Error(t('语音任务已结束'))); }
      else if (type === 'task-failed') {
        const failure = safeError(event.header.error_message || event.header.error_code || t('实时识别任务失败'));
        rejectStarted?.(failure); void fail(failure);
      } else if (type === 'result-generated') {
        const sentence = event.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat || typeof sentence.text !== 'string' || !sentence.text.trim()) return;
        const id = `${taskId}:${sentence.sentence_id ?? sentence.begin_time ?? sentence.text}`;
        const isFinal = sentence.sentence_end === true;
        if (seen.has(id)) return;
        if (isFinal) {
          seen.add(id); finalTexts.push(sentence.text.trim());
          if (seen.size > 2048) seen.delete(seen.values().next().value!);
          if (finalTexts.length > 2048) finalTexts.shift();
        }
        callbacks.onResult({ id, text: sentence.text.trim(), isFinal,...(Number.isFinite(sentence.begin_time)&&Number.isFinite(sentence.end_time)?{beginMs:sentence.begin_time,endMs:sentence.end_time}:{}) });
      }
    } catch (error) { void fail(new Error(t('实时识别响应异常：{message}', { message: safeError(error).message }))); }
  }
  async function establish(isRetry = false) {
    const currentEpoch = ++epoch;
    await detach();
    if (closed) throw new DOMException(t('实时识别已取消'), 'AbortError');
    callbacks.onState?.(isRetry ? 'reconnecting' : 'connecting');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const connected = connect(endpoint, { headers: { Authorization: `Bearer ${config.apiKey}` }, maxMessageSize: 1024 * 1024, maxFrameSize: 1024 * 1024 });
    connected.then(late => { if (closed || currentEpoch !== epoch) void late.disconnect().catch(() => {}); }, () => {});
    try {
      socket = await Promise.race([connected, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(t('实时语音连接超时'))), 10000); })]);
      clearTimeout(timeout);
      if (closed || currentEpoch !== epoch) { await socket.disconnect(); throw new DOMException(t('实时识别已取消'), 'AbortError'); }
      taskId = crypto.randomUUID();
      removeListener = socket.addListener(message => onMessage(message, currentEpoch));
      const started = new Promise<void>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
      void started.catch(() => {});
      const parameters: Record<string, unknown> = { format: 'pcm', sample_rate: 16000, heartbeat: true,
        max_sentence_silence: Math.max(200, Math.min(6000, config.silenceMs || 1300)) };
      if (config.modelId === 'paraformer-realtime-v2') {
        parameters.semantic_punctuation_enabled = false;
        parameters.disfluency_removal_enabled = true;
      }
      if (config.vocabularyId) parameters.vocabulary_id = config.vocabularyId;
      if (config.language && config.language !== 'auto') parameters.language_hints = [config.language];
      timeout = setTimeout(() => rejectStarted?.(new Error(t('实时语音任务未在 10 秒内就绪'))), 10000);
      await send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: config.modelId, parameters, input: {} } }));
      await started;
    } catch (error) { await detach(); throw safeError(error); }
    finally { clearTimeout(timeout); resolveStarted = undefined; rejectStarted = undefined; }
  }
  async function drain() {
    if (sendingEpoch === epoch || !ready || closed) return;
    const currentEpoch = epoch, target = socket;
    sendingEpoch = currentEpoch;
    try {
      while (queue.length && ready && target && !closed && currentEpoch === epoch) {
        // Coalesce the queued microphone callbacks into <=100ms PCM frames.
        // One native IPC round-trip per tiny callback can be slower than live audio.
        const frame:number[] = [];
        while(queue.length && frame.length<3200){
          const part=queue[0],take=Math.min(part.length,3200-frame.length);
          frame.push(...part.slice(0,take));
          if(take===part.length)queue.shift();else queue[0]=part.slice(take);
        }
        queuedBytes -= frame.length;inFlightBytes=frame.length;
        await send(frame,target);
        if(currentEpoch===epoch)inFlightBytes=0;
      }
    } catch (error) { if (currentEpoch === epoch) reconnect(error); }
    finally {
      if(sendingEpoch===currentEpoch){sendingEpoch=null;if(currentEpoch===epoch)inFlightBytes=0;}
      if (ready && queue.length && sendingEpoch!==epoch) void drain();
    }
  }
  config.signal?.addEventListener('abort', abort, { once: true });
  if (config.signal?.aborted) { await close(); throw new DOMException(t('实时识别已取消'), 'AbortError'); }
  try { await establish(); } catch (error) { await close(); throw error; }
  return {
    push(pcm: Int16Array): boolean {
      if (closed || !ready) return false; // Reconnection gaps are explicitly reported; never replay stale speech.
      if (pcm.byteLength > 64000) { void fail(new Error(t('语音发送积压超过两秒，请检查网络后重试。'))); return false; }
      if (queuedBytes + inFlightBytes + pcm.byteLength > 64000) {
        // 发送端落后超过两秒：这批音频已经过期，换一条连接继续，而不是让整场面试停止收音。
        reconnect(new Error(t('语音发送积压超过两秒，请检查网络后重试。')));
        return false;
      }
      const bytes = new Uint8Array(pcm.length * 2); const view = new DataView(bytes.buffer);
      pcm.forEach((sample, index) => view.setInt16(index * 2, sample, true));
      queue.push(Array.from(bytes)); queuedBytes += bytes.length; void drain();
      return true;
    },
    async finish() {
      // 断线时把半截转写当完整结果返回，上层会静默丢掉后半句话；宁可报错并带上已识别部分。
      if (closed || !socket) {
        if (config.signal?.aborted) throw new DOMException(t('实时识别已取消'), 'AbortError');
        const error = new Error(t('语音连接已断开，本次识别可能不完整，请重说。')) as Error & { partialText?: string };
        error.partialText = finalTexts.join(' ');
        throw error;
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = Date.now() + 8000;
        while (sendingEpoch === epoch || queue.length) {
          if (closed || !ready) throw new Error(t('语音发送已中断'));
          if (Date.now() >= deadline) throw new Error(t('语音发送超时'));
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        // 重连窗口里队列可能为空且没有在途发送，但连接并没有就绪，不能发 finish-task。
        if (closed || !ready || !socket) throw new Error(t('语音发送已中断'));
        const remaining = Math.max(500, deadline - Date.now());
        const finished = new Promise<void>((resolve, reject) => {
          resolveFinished = resolve;
          rejectFinished = reject;
          timeout = setTimeout(() => reject(new Error(t('语音定稿超时，请重试'))), remaining);
        });
        void finished.catch(() => {});
        finishSent = true;
        await send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
        await finished; return finalTexts.join(' ');
      } finally {
        clearTimeout(timeout);
        resolveFinished = undefined;
        rejectFinished = undefined;
        await close();
      }
    },
    close,
  };
}
