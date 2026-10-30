import type { AiProvider } from './aiConfig.js';
import { bailianRegion } from './realtimeAsrProtocol.js';

export type TtsService = 'mimo' | 'qwen' | 'bailian' | 'compatible';
export function isSpeechSynthesisModel(model: string): boolean {
  return /(?:^|\/)(?:mimo-[\w.-]*tts[\w.-]*|qwen[\w.-]*tts[\w.-]*|cosyvoice[\w.-]*|tts-\d[\w.-]*|gpt-[\w.-]*tts[\w.-]*)$/i.test(model);
}
export function ttsService(provider: Pick<AiProvider, 'baseUrl'>, model: string): TtsService {
  if (/^mimo-[\w.-]*tts(?:-|$)/i.test(model)) return 'mimo';
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol === 'https:' && !url.port && bailianRegion(url.hostname)
      && /^\/(?:compatible-mode|api)\/v1\/?$/.test(url.pathname)) {
      if (/^(?:qwen-audio-[\w.-]*tts|cosyvoice)(?:-|$)/i.test(model)) return 'bailian';
      if (/^qwen[\w.-]*tts(?:-|$)/i.test(model)) return 'qwen';
    }
  } catch { /* The request layer reports invalid connection URLs. */ }
  return 'compatible';
}
export function ttsVoices(provider: Pick<AiProvider, 'baseUrl'>, model: string): {id:string; name:string}[] {
  const service = ttsService(provider, model);
  if (service === 'mimo') return ['苏打','冰糖','茉莉','白桦','Mia','Chloe','Milo','Dean'].map(id => ({id, name:id}));
  if (service === 'qwen') return [{id:'Cherry',name:'芊悦 · 女声'},{id:'Serena',name:'苏瑶 · 女声'},{id:'Ethan',name:'晨煦 · 男声'},{id:'Chelsie',name:'千雪 · 女声'}];
  if (service === 'bailian') {
    if (/^qwen-audio-/i.test(model)) return [{id:'longanhuan_v3.6',name:'龙安欢 · 自然女声'}];
    if (model === 'cosyvoice-v3-flash') return [{id:'longanyang',name:'龙安洋 · 男声'}];
    return [];
  }
  return ['alloy','echo','fable','onyx','nova','shimmer'].map(id => ({id,name:id}));
}
export function defaultTtsVoice(provider: Pick<AiProvider, 'baseUrl'>, model: string): string {
  return ttsVoices(provider, model)[0]?.id || '';
}
