import { bailianConnection, isSpeechRecognitionModel, normalizeProvider, validateModelId, type AiProvider } from './aiConfig.js';

export type AiFetch = (url: string, init: RequestInit) => Promise<Response>;
/** Transcription accepts ISO-639-1 (zh/en), while UI preferences use locales. */
export function transcriptionLanguage(locale?: string): string | undefined {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0];
  return language && /^[a-z]{2}$/.test(language) ? language : undefined;
}
export interface RequestScope { signal: AbortSignal; cleanup: () => void }
export function requestScope(timeoutMs: number, signal?: AbortSignal): RequestScope {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时，请检查接口或增加超时时间', 'TimeoutError')), timeoutMs);
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
export function aiHeaders(provider: AiProvider, json = false): Record<string, string> {
  const headers: Record<string, string> = json ? { 'Content-Type': 'application/json' } : {};
  if (provider.authMode === 'bearer') {
    if (!provider.apiKey.trim()) throw new Error('请填写 API Key，或将本地服务设为「无需密钥」');
    headers.Authorization = `Bearer ${provider.apiKey.trim()}`;
  }
  return headers;
}
export function redactError(message: string, key: string): string {
  return (key ? message.split(key).join('[密钥已隐藏]') : message).slice(0, 500);
}
export async function responseError(response: Response, key: string): Promise<Error> {
  const hints: Record<number, string> = {
    401: '认证失败，请检查 API Key', 403: '当前密钥没有访问权限',
    404: '接口路径或模型不存在；可手动添加模型', 408: '服务端请求超时',
    429: '请求过于频繁或额度不足，请检查服务商账户',
  };
  let detail = '';
  try {
    const text = await response.text();
    const json = JSON.parse(text);
    const value = json.error?.message ?? (typeof json.error === 'string' ? json.error : json.message);
    if (typeof value === 'string') detail = redactError(value, key);
  } catch { /* Do not display arbitrary HTML, request headers or opaque proxy dumps. */ }
  return new Error(`HTTP ${response.status} · ${hints[response.status] ?? (response.status >= 500 ? '服务商暂时不可用' : '接口请求失败')}${detail ? `：${detail}` : ''}`);
}
/** Apply timeout through body consumption too, not just response headers. */
export async function withAiRequest<T>(
  provider: AiProvider, endpoint: string, init: RequestInit, timeoutMs: number,
  consume: (response: Response) => Promise<T>, fetcher: AiFetch, signal?: AbortSignal,
): Promise<T> {
  const normalized = normalizeProvider(provider);
  const scope = requestScope(timeoutMs, signal);
  try {
    scope.signal.throwIfAborted();
    const response = await fetcher(`${normalized.baseUrl}/${endpoint}`, { ...init, signal: scope.signal, redirect: 'error' });
    if (response.headers.get('x-mianshi-test-service')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('当前连接是本地测试服务，只会返回固定内容，无法用于真实问答或语音识别。请到「设置 → AI 服务」配置真实接口。');
    }
    if (!response.ok) throw await responseError(response, normalized.apiKey);
    return await consume(response);
  } catch (error) {
    if (scope.signal.aborted) throw scope.signal.reason ?? new DOMException('已取消请求', 'AbortError');
    if (error instanceof Error) throw new Error(redactError(error.message, normalized.apiKey));
    if (typeof error === 'string' && error.includes('url not allowed')) throw new Error('接口地址被桌面 HTTP 权限拦截，请使用已更新的客户端');
    throw new Error('无法连接接口，请检查地址、网络、证书和服务状态');
  } finally { scope.cleanup(); }
}

export async function discoverModels(provider: AiProvider, fetcher: AiFetch, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const connection = bailianConnection(provider.baseUrl);
  if (connection) {
    try { return await discoverBailianModels(provider, connection, fetcher, signal); }
    catch (error) {
      // Only an unavailable catalog may fall back. Authentication, cancellation and bad data stay visible.
      if (signal?.aborted || !(error instanceof Error) || !/^HTTP (404|405) ·/.test(error.message)) throw error;
    }
  }
  const found = new Map<string, { id: string; name: string }>();
  const cursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const payload: unknown = await withAiRequest(provider, `models${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, { headers: aiHeaders(provider) }, 15000, r => r.json(), fetcher, signal);
    if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { data?: unknown }).data)) {
      throw new Error('模型列表格式不兼容：需要 data 数组；你仍可手动添加模型 ID');
    }
    const json = payload as { data: unknown[]; has_more?: boolean; last_id?: string };
    for (const item of json.data) {
      if (!item || typeof item !== 'object' || typeof (item as { id?: unknown }).id !== 'string') throw new Error('模型列表包含无效 ID');
      const model = item as { id: string; name?: unknown };
      const id = validateModelId(model.id);
      found.set(id, { id, name: typeof model.name === 'string' ? model.name.slice(0, 160) : id });
      if (found.size > 2000) throw new Error('接口返回的模型超过 2000 个，请使用自定义模型');
    }
    if (!json.has_more) return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (typeof json.last_id !== 'string' || !json.last_id || cursors.has(json.last_id)) throw new Error('模型列表分页游标无效，请使用自定义模型');
    cursor = json.last_id;
    cursors.add(cursor);
  }
  throw new Error('模型列表分页超过 10 页，请使用自定义模型');
}

async function discoverBailianModels(provider: AiProvider, connection: NonNullable<ReturnType<typeof bailianConnection>>,
  fetcher: AiFetch, signal?: AbortSignal): Promise<{ id: string; name: string }[]> {
  const found = new Map<string, { id: string; name: string }>();
  const catalog = { ...provider, baseUrl: connection.catalogBaseUrl };
  const headers = aiHeaders(provider);
  if (connection.workspaceId) headers['X-DashScope-WorkSpace'] = connection.workspaceId;
  let received = 0;
  let expectedTotal: number | undefined;
  for (let page = 1; page <= 20; page++) {
    const query = new URLSearchParams({ page_no: String(page), page_size: '100',
      service_site: connection.region === 'singapore' ? 'international' : 'asia-pacific-china' });
    const models = await withAiRequest(catalog, `models?${query}`, { headers }, 15000, async response => {
      const json = await response.json();
      if (json?.success === false || json?.code) throw new Error('百炼模型目录查询失败，请检查业务空间和权限。');
      const output = json?.output;
      if (!output || !Array.isArray(output.models) || !Number.isInteger(output.total) || output.total < 0 || output.total > 2000
        || (output.page_no !== undefined && output.page_no !== page) || output.models.length > 100
        || (expectedTotal !== undefined && expectedTotal !== output.total)) throw new Error('百炼模型目录格式或分页无效，请重试或手动添加模型 ID。');
      expectedTotal = output.total;
      return output.models.map((item: { model?: unknown; name?: unknown }) => {
        if (!item || typeof item.model !== 'string') throw new Error('百炼模型目录包含无效模型 ID。');
        const id = validateModelId(item.model);
        return { id, name: typeof item.name === 'string' ? item.name.slice(0, 160) : id };
      }) as { id: string; name: string }[];
    }, fetcher, signal);
    signal?.throwIfAborted();
    const previousSize = found.size;
    for (const model of models) found.set(model.id, model);
    received += models.length;
    if (received > expectedTotal! || found.size !== received || (received < expectedTotal! && found.size === previousSize)) throw new Error('百炼模型目录分页不完整或重复，请重试。');
    if (received === expectedTotal) return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
  }
  throw new Error('百炼模型目录分页超过 20 页，请手动添加模型 ID。');
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => part?.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
  return '';
}
/** One parser for both text and vision, including split UTF-8 and final unterminated lines. */
export async function consumeChat(response: Response, onDelta?: (text: string) => void): Promise<string> {
  if (!response.body) throw new Error('接口未返回响应内容');
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    const json = await response.json();
    if (json.error) throw new Error(typeof json.error.message === 'string' ? json.error.message : '模型请求失败');
    const text = extractText(json.choices?.[0]?.message?.content);
    if (!text) throw new Error('接口未返回可用的回答，请确认模型支持 Chat Completions');
    onDelta?.(text);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finished = false;
  const parseLine = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') { finished = true; return; }
    let json;
    try { json = JSON.parse(data); } catch { throw new Error('接口返回了无效的流式数据'); }
    if (json.error) throw new Error(typeof json.error.message === 'string' ? json.error.message : '模型请求失败');
    const text = extractText(json.choices?.[0]?.delta?.content);
    if (text) { full += text; onDelta?.(text); }
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 1_048_576) throw new Error('接口返回的单条流式消息过大');
      let newline;
      while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
        parseLine(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
      }
      if (done) { if (!finished && buffer.trim()) parseLine(buffer.replace(/\r$/, '')); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  if (!full) throw new Error('模型没有返回文本回答，请确认该模型支持此用途');
  return full;
}
export async function testChatModel(provider: AiProvider, modelId: string, fetcher: AiFetch, signal?: AbortSignal): Promise<{ latencyMs: number; sample: string }> {
  const selectedModel = validateModelId(modelId);
  if (isSpeechRecognitionModel(selectedModel)) throw new Error('该模型用于语音识别，不能执行文字对话测试。请在「语音转写」中配置，并使用实际音频验证。');
  const start = performance.now();
  const sample = await withAiRequest(provider, 'chat/completions', {
    method: 'POST', headers: aiHeaders(provider, true),
    body: JSON.stringify({ model: selectedModel, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: true }),
  }, 30000, r => consumeChat(r), fetcher, signal);
  return { latencyMs: Math.round(performance.now() - start), sample: sample.slice(0, 160) };
}
