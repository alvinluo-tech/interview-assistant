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
export interface RealtimeResult { text: string; isFinal: boolean; id: string }
export interface RealtimeCallbacks { onResult(result: RealtimeResult): void; onError(error: Error): void; onState?(state: 'connecting' | 'ready' | 'reconnecting' | 'closed'): void }
export type RealtimeConnect = (url: string, options: { headers: Record<string, string>; maxMessageSize: number; maxFrameSize: number }) => Promise<RealtimeSocket>;

export function validateRealtimeEndpoint(value: string): string {
  const url = new URL(value || DEFAULT_REALTIME_ENDPOINT);
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash || url.port
      || url.pathname !== '/api-ws/v1/inference'
      || !bailianRegion(url.hostname)) {
    throw new Error('实时 ASR 仅支持百炼北京或新加坡地域的官方 WSS 地址，不接受查询参数或 URL 中的密钥。');
  }
  return url.href;
}

/** Duplex PCM transport. Audio queued for >2 seconds is rejected instead of silently growing stale. */
export async function openRealtimeAsr(config: RealtimeConfig, connect: RealtimeConnect, callbacks: RealtimeCallbacks) {
  const endpoint = validateRealtimeEndpoint(config.endpoint || DEFAULT_REALTIME_ENDPOINT);
  if (!isRealtimeAsrModel(config.modelId)) throw new Error('持续实时模式请选择 Fun-ASR-Realtime 或 paraformer-realtime-v2；MiMo 请使用自动或分段模式。');
  if (bailianRegion(new URL(endpoint).hostname) === 'singapore' && config.modelId !== 'fun-asr-realtime') throw new Error('新加坡持续实时识别请选择 fun-asr-realtime 稳定版；其他已适配模型请使用北京地域。');
  if (!config.apiKey || /[\r\n\u0000]/.test(config.apiKey)) throw new Error('请填写有效的百炼 API Key。');
  if (config.vocabularyId && !/^[\w-]{1,200}$/.test(config.vocabularyId)) throw new Error('百炼热词表 ID 格式无效。');
  let socket: RealtimeSocket | null = null, removeListener: (() => void) | undefined;
  let closed = false, ready = false, epoch = 0, retries = 0, sending = false, queuedBytes = 0;
  let taskId = '', retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stableSince = 0;
  let queue: number[][] = [];
  const seen = new Set<string>(), finalTexts: string[] = [];
  let resolveStarted: (() => void) | undefined, rejectStarted: ((error: Error) => void) | undefined;
  let resolveFinished: (() => void) | undefined;
  const safeError = (error: unknown) => new Error(String((error as Error)?.message || error).split(config.apiKey).join('<redacted>').slice(0, 500));

  async function send(data: string | number[], target = socket) {
    if (!target) throw new Error('语音连接已断开');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([target.send(data), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('语音发送超时')), 3000); })]);
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
    closed = true; epoch++; ready = false; queue = []; queuedBytes = 0;
    clearTimeout(retryTimer); config.signal?.removeEventListener('abort', abort);
    rejectStarted?.(new DOMException('实时识别已取消', 'AbortError'));
    resolveFinished?.();
    const previous = socket;
    if (previous) void previous.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } })).catch(() => {});
    await detach(); callbacks.onState?.('closed');
  }
  function abort() { void close(); }
  async function fail(error: unknown) { if (closed) return; const failure = safeError(error); await close(); callbacks.onError(failure); }
  function reconnect(error: unknown) {
    if (closed || retryTimer) return;
    if (ready && Date.now() - stableSince >= 60000) retries = 0;
    if (retries >= 3) { void fail(new Error(`实时语音连接多次中断：${safeError(error).message}`)); return; }
    ready = false; queue = []; queuedBytes = 0;
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
      const error = new Error('语音连接已断开');
      if (!ready) rejectStarted?.(error); else reconnect(error);
      return;
    }
    if (message.type !== 'Text' || typeof message.data !== 'string') return;
    try {
      const event = JSON.parse(message.data);
      if (event.header?.task_id !== taskId) return;
      const type = event.header?.event;
      if (type === 'task-started') { ready = true; stableSince = Date.now(); resolveStarted?.(); callbacks.onState?.('ready'); void drain(); }
      else if (type === 'task-finished') { if (resolveFinished) resolveFinished(); else reconnect(new Error('语音任务已结束')); }
      else if (type === 'task-failed') {
        const failure = safeError(event.header.error_message || event.header.error_code || '实时识别任务失败');
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
        callbacks.onResult({ id, text: sentence.text.trim(), isFinal });
      }
    } catch (error) { void fail(new Error(`实时识别响应异常：${safeError(error).message}`)); }
  }
  async function establish(isRetry = false) {
    const currentEpoch = ++epoch;
    await detach();
    if (closed) throw new DOMException('实时识别已取消', 'AbortError');
    callbacks.onState?.(isRetry ? 'reconnecting' : 'connecting');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const connected = connect(endpoint, { headers: { Authorization: `Bearer ${config.apiKey}` }, maxMessageSize: 1024 * 1024, maxFrameSize: 1024 * 1024 });
    connected.then(late => { if (closed || currentEpoch !== epoch) void late.disconnect().catch(() => {}); }, () => {});
    try {
      socket = await Promise.race([connected, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('实时语音连接超时')), 10000); })]);
      clearTimeout(timeout);
      if (closed || currentEpoch !== epoch) { await socket.disconnect(); throw new DOMException('实时识别已取消', 'AbortError'); }
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
      timeout = setTimeout(() => rejectStarted?.(new Error('实时语音任务未在 10 秒内就绪')), 10000);
      await send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: { task_group: 'audio', task: 'asr', function: 'recognition', model: config.modelId, parameters, input: {} } }));
      await started;
    } catch (error) { await detach(); throw safeError(error); }
    finally { clearTimeout(timeout); resolveStarted = undefined; rejectStarted = undefined; }
  }
  async function drain() {
    if (sending || !ready || closed) return;
    sending = true;
    const sendingEpoch = epoch;
    try {
      while (queue.length && ready && socket && !closed) {
        const frame = queue.shift()!; queuedBytes -= frame.length;
        await send(frame);
      }
    } catch (error) { if (sendingEpoch === epoch) reconnect(error); }
    finally { sending = false; if (ready && queue.length) void drain(); }
  }
  config.signal?.addEventListener('abort', abort, { once: true });
  if (config.signal?.aborted) { await close(); throw new DOMException('实时识别已取消', 'AbortError'); }
  try { await establish(); } catch (error) { await close(); throw error; }
  return {
    push(pcm: Int16Array) {
      if (closed || !ready) return; // Reconnection gaps are explicitly reported; never replay stale speech.
      if (pcm.byteLength > 64000 || queuedBytes + pcm.byteLength > 64000) { void fail(new Error('语音发送积压超过两秒，请检查网络后重试。')); return; }
      const bytes = new Uint8Array(pcm.length * 2); const view = new DataView(bytes.buffer);
      pcm.forEach((sample, index) => view.setInt16(index * 2, sample, true));
      queue.push(Array.from(bytes)); queuedBytes += bytes.length; void drain();
    },
    async finish() {
      if (closed || !socket) return finalTexts.join(' ');
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = Date.now() + 8000;
        while (sending || queue.length) {
          if (closed || !ready) throw new Error('语音发送已中断');
          if (Date.now() >= deadline) throw new Error('语音发送超时');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const finished = new Promise<void>((resolve, reject) => { resolveFinished = resolve; timeout = setTimeout(() => reject(new Error('语音定稿超时，请重试')), 8000); });
        void finished.catch(() => {});
        await send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
        await finished; return finalTexts.join(' ');
      } finally { clearTimeout(timeout); await close(); }
    },
    close,
  };
}
