import {connectRealtimeSocket} from '@/lib/realtimeTransport';
import { getAiSettings } from './aiSettings';
import { resolveAiRoute, resolveRealtimeEndpoint } from './aiConfig';
import { transcriptionLanguage } from './aiProtocol';
import { openRealtimeAsr, type RealtimeCallbacks } from './realtimeAsrProtocol';

export type RealtimeCapture = Awaited<ReturnType<typeof openRealtimeAsr>>;
export async function openConfiguredRealtimeAsr(callbacks: RealtimeCallbacks, options: { signal?: AbortSignal; language?: string; silenceMs?: number } = {}): Promise<RealtimeCapture> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) throw new Error('持续实时识别需要在桌面应用中使用。');
  const settings = getAiSettings();
  const { provider, modelId } = resolveAiRoute(settings, 'stt');
  return openRealtimeAsr({ endpoint: resolveRealtimeEndpoint(settings), apiKey: provider.apiKey, modelId,
    vocabularyId: settings.realtimeVocabularyId, language: transcriptionLanguage(options.language), silenceMs: options.silenceMs, signal: options.signal },
  connectRealtimeSocket, callbacks);
}

/** Manual voice input uses the same realtime provider without pretending it has a file endpoint. */
export async function recognizeRealtimeWav(wav: Blob, options: { signal?: AbortSignal; lang?: string; onDelta?: (text: string) => void }) {
  const data = new DataView(await wav.arrayBuffer());
  if (data.byteLength < 44 || data.getUint32(24, true) !== 16000 || data.getUint16(22, true) !== 1 || data.getUint16(34, true) !== 16) {
    throw new Error('实时语音输入需要 16kHz 单声道 PCM16 WAV。');
  }
  let last = '', failure: Error | undefined;
  const session = await openConfiguredRealtimeAsr({ onResult: result => { last = result.text; }, onError: error => { failure = error; } }, { signal: options.signal, language: options.lang });
  try {
    const samples = Math.min(data.getUint32(40, true) / 2, (data.byteLength - 44) / 2);
    for (let offset = 0; offset < samples; offset += 1600) {
      options.signal?.throwIfAborted();
      if (failure) throw failure;
      const pcm = new Int16Array(Math.min(1600, samples - offset));
      for (let i = 0; i < pcm.length; i++) pcm[i] = data.getInt16(44 + (offset + i) * 2, true);
      session.push(pcm);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const text = (await session.finish()).trim() || last;
    if (failure) throw failure;
    if (!text) throw new Error('没有识别到有效语音，请说完整一句话后重试。');
    options.onDelta?.(text); return text;
  } finally { await session.close(); }
}
