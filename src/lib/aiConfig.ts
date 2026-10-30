/** Pure BYOK schema and validation, shared by settings, requests and regression tests. */
import { bailianRegion, DEFAULT_REALTIME_ENDPOINT, isRealtimeAsrModel, validateRealtimeEndpoint } from './realtimeAsrProtocol.js';
import type {ModelCapabilities} from './aiTaskPolicy.js';
export const AI_ROLES = ['chat', 'vision', 'stt', 'tts'] as const;
export type AiRole = typeof AI_ROLES[number];
export const ROLE_LABELS: Record<AiRole, string> = {
  chat: '对话与作答', vision: '截图识别', stt: '语音转写', tts: '语音合成',
};
/** Known recognition-only families must not receive text-only Chat Completions probes. */
export function isSpeechRecognitionModel(modelId: string): boolean {
  const id = modelId.trim().toLowerCase().split('/').pop() || '';
  return /^(?:fun-asr|paraformer|sensevoice|whisper)(?:-|$)/.test(id)
    || /^qwen[\w.-]*-asr(?:-|$)/.test(id)
    || /^mimo[\w.-]*-asr(?:-|$)/.test(id);
}
export interface AiModel {
  id: string;
  name: string;
  source: 'discovered' | 'custom';
  capabilities?:ModelCapabilities;
}
export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  authMode: 'bearer' | 'none';
  models: AiModel[];
  lastFetchedAt: string | null;
}
export interface AiRoute { providerId: string; modelId: string }
export interface AiSettings {
  version: 2;
  providers: AiProvider[];
  routes: Record<AiRole, AiRoute | null>;
  timeoutMs: number;
  ttsVoice: string;
  speechInputMode?: 'auto' | 'segmented' | 'file' | 'realtime';
  realtimeEndpoint?: string;
  realtimeVocabularyId?: string;
}
export const PROVIDER_PRESETS = [
  { id: 'compatible', name: 'OpenAI 兼容接口', baseUrl: '', authMode: 'bearer' as const },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', authMode: 'bearer' as const },
  { id: 'mimo', name: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', authMode: 'bearer' as const },
  { id: 'dashscope', name: '阿里云百炼（北京）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', authMode: 'bearer' as const },
  { id: 'dashscope-sg', name: '阿里云百炼（新加坡）', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', authMode: 'bearer' as const },
  { id: 'ollama', name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', authMode: 'none' as const },
  { id: 'local', name: '本地 / 自托管', baseUrl: 'http://localhost:1234/v1', authMode: 'none' as const },
];
export function defaultAiSettings(): AiSettings {
  return { version: 2, providers: [], routes: { chat: null, vision: null, stt: null, tts: null }, timeoutMs: 90000, ttsVoice: 'alloy', speechInputMode: 'auto' };
}
export function createProvider(presetId = 'compatible'): AiProvider {
  const preset = PROVIDER_PRESETS.find(p => p.id === presetId) ?? PROVIDER_PRESETS[0];
  return { id: crypto.randomUUID(), name: preset.name, baseUrl: preset.baseUrl, apiKey: '', authMode: preset.authMode,
    models: presetId === 'mimo' ? [{id:'mimo-v2.5-tts',name:'MiMo 面试官语音',source:'custom'}] : presetId === 'dashscope' ? [
      { id: 'fun-asr-realtime', name: 'Fun-ASR 实时识别', source: 'custom' },
      { id: 'fun-asr-realtime-2026-02-28', name: 'Fun-ASR 实时识别（2026-02-28）', source: 'custom' },
      { id: 'paraformer-realtime-v2', name: 'Paraformer 实时识别 v2', source: 'custom' },
      { id: 'qwen3-tts-flash', name: 'Qwen 面试官语音', source: 'custom' },
      { id: 'qwen-audio-3.1-tts-flash', name: 'Qwen Audio 语音', source: 'custom' },
      { id: 'cosyvoice-v3-flash', name: 'CosyVoice 语音', source: 'custom' },
    ] : presetId === 'dashscope-sg' ? [
      { id: 'fun-asr-realtime', name: 'Fun-ASR 实时识别', source: 'custom' },
      { id: 'qwen3-tts-flash', name: 'Qwen 面试官语音', source: 'custom' },
      { id: 'qwen-audio-3.1-tts-flash', name: 'Qwen Audio 语音', source: 'custom' },
    ] : [], lastFetchedAt: null };
}
/** Recognize only official HTTPS compatibility endpoints; never redirect a proxy's credentials. */
export function bailianConnection(baseUrl: string) {
  try {
    const url = new URL(normalizeBaseUrl(baseUrl));
    const region = bailianRegion(url.hostname);
    if (!region || url.protocol !== 'https:' || url.port || url.pathname !== '/compatible-mode/v1') return undefined;
    const workspaceId = url.hostname.endsWith('.maas.aliyuncs.com') ? url.hostname.split('.')[0] : undefined;
    return { region, workspaceId, realtimeEndpoint: `wss://${url.host}/api-ws/v1/inference`,
      catalogBaseUrl: `${region === 'singapore' ? 'https://dashscope-intl.aliyuncs.com' : url.origin}/api/v1` };
  } catch { return undefined; }
}
export function isUnsupportedBailianSpeechModel(provider: AiProvider, modelId: string): boolean {
  return !!bailianConnection(provider.baseUrl) && isSpeechRecognitionModel(modelId) && !isRealtimeAsrModel(modelId);
}
function assertSpeechModelSupported(provider: AiProvider, modelId: string) {
  if (isUnsupportedBailianSpeechModel(provider, modelId)) throw new Error(`当前选择 ${modelId} 属于百炼文件识别或专用语音模型，本应用尚未接入其文件任务接口。请改选 fun-asr-realtime 使用持续实时识别。`);
}
export function assertFileTranscriptionModel(provider: AiProvider, modelId: string) {
  if (isRealtimeAsrModel(modelId)) throw new Error(`${modelId} 需要持续实时音频连接，不能使用文件转写接口。请选择持续实时模式并重新开始收音。`);
  assertSpeechModelSupported(provider, modelId);
}
export function resolveRealtimeEndpoint(settings: AiSettings): string {
  const route = settings.routes.stt;
  const provider = settings.providers.find(provider => provider.id === route?.providerId);
  const connection = provider ? bailianConnection(provider.baseUrl) : undefined;
  const endpoint = validateRealtimeEndpoint(settings.realtimeEndpoint || connection?.realtimeEndpoint || DEFAULT_REALTIME_ENDPOINT);
  const region = bailianRegion(new URL(endpoint).hostname);
  if (connection && region !== connection.region) throw new Error('实时语音地址与语音转写连接的地域不一致，请清空实时地址以自动匹配，或填写相同地域的地址。');
  if (region === 'singapore' && route && route.modelId !== 'fun-asr-realtime') throw new Error('新加坡持续实时识别请选择 fun-asr-realtime 稳定版。');
  return endpoint;
}
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入完整接口地址，例如 https://api.example.com/v1'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('接口地址仅支持 HTTP 或 HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('接口地址不能包含账号、密码、查询参数或 # 片段');
  // Accept commonly pasted complete endpoint URLs; preserve gateway/version prefixes.
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|audio\/(?:transcriptions|speech)|models|responses)$/i, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}
export function validateModelId(input: string): string {
  const value = input.trim();
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('模型 ID 需为 1–256 个字符，不能含控制字符');
  return value;
}
export function normalizeProvider(provider: AiProvider): AiProvider {
  if (!provider.id || provider.id.length > 128) throw new Error('服务商 ID 无效');
  const name = provider.name.trim();
  if (!name || name.length > 80) throw new Error('请为连接填写 1–80 个字符的名称');
  if (!['bearer', 'none'].includes(provider.authMode)) throw new Error('认证方式无效');
  const apiKey = provider.apiKey.trim();
  if (apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey)) throw new Error('API Key 格式无效');
  const seen = new Set<string>();
  const models = provider.models.map(model => {
    const id = validateModelId(model.id);
    if (seen.has(id)) throw new Error(`模型 ID 重复：${id}`);
    seen.add(id);
    if (!['custom', 'discovered'].includes(model.source)) throw new Error('模型来源无效');
    const capabilities=model.capabilities;
    if(capabilities){
      if(capabilities.contextWindow!==undefined&&(!Number.isInteger(capabilities.contextWindow)||capabilities.contextWindow<1024||capabilities.contextWindow>2000000))throw new Error('模型上下文窗口需为 1024–2000000 token');
      if(capabilities.maxOutputTokens!==undefined&&(!Number.isInteger(capabilities.maxOutputTokens)||capabilities.maxOutputTokens<256||capabilities.maxOutputTokens>200000))throw new Error('模型输出上限需为 256–200000 token');
      if(capabilities.outputParameter&&!['max_tokens','max_completion_tokens','none'].includes(capabilities.outputParameter))throw new Error('输出参数无效');
      if(capabilities.structuredOutput&&!['text','json_object','json_schema'].includes(capabilities.structuredOutput))throw new Error('结构化输出模式无效');
      if(capabilities.temperature!==undefined&&typeof capabilities.temperature!=='boolean')throw new Error('温度能力配置无效');
    }
    return { id, name: (model.name || id).trim().slice(0, 160), source: model.source,...(capabilities?{capabilities:{
      ...(capabilities.contextWindow!==undefined?{contextWindow:capabilities.contextWindow}:{}),
      ...(capabilities.maxOutputTokens!==undefined?{maxOutputTokens:capabilities.maxOutputTokens}:{}),
      ...(capabilities.outputParameter?{outputParameter:capabilities.outputParameter}:{}),
      ...(capabilities.structuredOutput?{structuredOutput:capabilities.structuredOutput}:{}),
      ...(capabilities.temperature!==undefined?{temperature:capabilities.temperature}:{}),
    }}:{}) };
  });
  if (models.length > 2000) throw new Error('单个连接最多保存 2000 个模型');
  return { id: provider.id, name, baseUrl: normalizeBaseUrl(provider.baseUrl), apiKey, authMode: provider.authMode, models, lastFetchedAt: provider.lastFetchedAt ?? null };
}
export function validateAiSettings(settings: AiSettings, allowMissingKeys = false): AiSettings {
  if (settings.version !== 2 || !Array.isArray(settings.providers) || settings.providers.length > 20) throw new Error('AI 配置格式无效，最多支持 20 个连接');
  const providers = settings.providers.map(normalizeProvider);
  if (new Set(providers.map(p => p.id)).size !== providers.length) throw new Error('服务商 ID 重复');
  const routes: AiSettings['routes'] = { chat: null, vision: null, stt: null, tts: null };
  for (const role of AI_ROLES) {
    const route = settings.routes[role];
    if (!route) { routes[role] = null; continue; }
    const provider = providers.find(p => p.id === route.providerId);
    if (!provider || !provider.models.some(m => m.id === route.modelId)) throw new Error(`${ROLE_LABELS[role]}选择的模型不存在，请重新选择`);
    if (!allowMissingKeys && provider.authMode === 'bearer' && !provider.apiKey) throw new Error(`${provider.name}尚未填写 API Key；免密接口请选择「无需密钥」`);
    routes[role] = { providerId: route.providerId, modelId: route.modelId };
  }
  if (!Number.isInteger(settings.timeoutMs) || settings.timeoutMs < 5000 || settings.timeoutMs > 300000) throw new Error('请求超时需在 5–300 秒之间');
  const ttsVoice = settings.ttsVoice.trim();
  if (!ttsVoice || ttsVoice.length > 100 || /[\u0000-\u001f]/.test(ttsVoice)) throw new Error('语音音色需为 1–100 个字符');
  const requestedSpeechMode = settings.speechInputMode ?? 'auto';
  if (!['auto', 'segmented', 'file', 'realtime'].includes(requestedSpeechMode)) throw new Error('语音识别模式无效');
  const speechInputMode = routes.stt && isRealtimeAsrModel(routes.stt.modelId) ? 'realtime' : requestedSpeechMode;
  if (!allowMissingKeys && routes.stt) assertSpeechModelSupported(providers.find(provider=>provider.id===routes.stt!.providerId)!,routes.stt.modelId);
  const realtimeEndpoint = settings.realtimeEndpoint ? validateRealtimeEndpoint(settings.realtimeEndpoint) : undefined;
  const realtimeVocabularyId = settings.realtimeVocabularyId?.trim();
  if (realtimeVocabularyId && !/^[\w-]{1,200}$/.test(realtimeVocabularyId)) throw new Error('热词表 ID 格式无效');
  if (speechInputMode === 'realtime' && routes.stt && !isRealtimeAsrModel(routes.stt.modelId)) throw new Error('持续实时模式仅支持 Fun-ASR-Realtime 或 paraformer-realtime-v2，请在语音转写用途中选择对应模型。');
  if (speechInputMode === 'realtime') resolveRealtimeEndpoint({ ...settings, providers, routes });
  return { version: 2, providers, routes, timeoutMs: settings.timeoutMs, ttsVoice, speechInputMode,
    ...(realtimeEndpoint ? { realtimeEndpoint } : {}), ...(realtimeVocabularyId ? { realtimeVocabularyId } : {}) };
}

export function speechProtocol(modelId: string): 'mimo' | 'transcriptions' {
  return /^mimo-.*-asr$/i.test(modelId) ? 'mimo' : 'transcriptions';
}
export function usesLiveSpeech(settings: AiSettings): boolean {
  if (settings.speechInputMode === 'file') return false;
  if (settings.speechInputMode === 'segmented') return true;
  return !!settings.routes.stt && speechProtocol(settings.routes.stt.modelId) === 'mimo';
}
export function resolveAiRoute(settings: AiSettings, role: AiRole) {
  const route = settings.routes[role] ?? (role === 'vision' ? settings.routes.chat : null);
  if (!route) throw new Error(`请先在「设置 → AI 服务」为${ROLE_LABELS[role]}选择模型`);
  const provider = settings.providers.find(p => p.id === route.providerId);
  if (!provider) throw new Error(`${ROLE_LABELS[role]}使用的连接已被删除，请重新选择`);
  if (role === 'stt') assertSpeechModelSupported(provider, route.modelId);
  if (provider.authMode === 'bearer' && !provider.apiKey.trim()) throw new Error(`${provider.name}缺少 API Key`);
  return { provider: normalizeProvider(provider), modelId: validateModelId(route.modelId) };
}
export function isRoleConfigured(settings: AiSettings, role: AiRole): boolean {
  try { resolveAiRoute(settings, role); return true; } catch { return false; }
}
/** Refresh discovery without losing custom IDs or a selected model omitted by the API. */
export function mergeDiscoveredModels(provider: AiProvider, ids: { id: string; name?: string }[], routes: AiSettings['routes']): AiModel[] {
  const previous = new Map(provider.models.map(m => [m.id, m]));
  const result = new Map<string, AiModel>();
  for (const model of ids) {
    const id = validateModelId(model.id);
    const old = previous.get(id);
    result.set(id, old?.source === 'custom' ? old : { id, name: model.name || id, source: 'discovered',...(old?.capabilities?{capabilities:old.capabilities}:{}) });
  }
  const assigned = new Set(Object.values(routes).filter(r => r?.providerId === provider.id).map(r => r!.modelId));
  for (const old of provider.models) {
    if (old.source === 'custom' || assigned.has(old.id)) {
      if (!result.has(old.id)) result.set(old.id, { ...old, source: 'custom' });
    }
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function removeProvider(settings: AiSettings, id: string): AiSettings {
  const next = structuredClone(settings);
  next.providers = next.providers.filter(p => p.id !== id);
  for (const role of AI_ROLES) if (next.routes[role]?.providerId === id) next.routes[role] = null;
  return next;
}
