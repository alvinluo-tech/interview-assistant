import type { SpeechAudioChunk, SpeechConsumer } from './ttsProtocol.js';
import type { SpeechOutput } from './ttsPlayback.js';

interface CloudSpeechDrivers {
  identity(): unknown;
  load(text: string, signal: AbortSignal, push: SpeechConsumer): Promise<void>;
  output(state: (speaking: boolean) => void, error: (reason: unknown) => void): SpeechOutput;
}
/** Per-window, memory-only replay cache. Partial/cancelled audio is never retained. */
export function createCloudSpeechSession(drivers: CloudSpeechDrivers) {
  const cache = new Map<string, SpeechAudioChunk[]>();
  let identity: unknown, cacheBytes = 0;
  const clear = () => {cache.clear();cacheBytes = 0;};
  return {clear, speak: async (text: string, state: (speaking: boolean) => void, error: (reason: unknown) => void, signal: AbortSignal) => {
    signal.throwIfAborted();
    const current = drivers.identity(); if (current !== identity) {clear();identity = current;}
    const output = drivers.output(state,error);
    const stop = () => {signal.removeEventListener('abort',stop);output.stop();};
    signal.addEventListener('abort',stop,{once:true});
    try {
      let completed: SpeechAudioChunk[] | undefined, completedSize = 0;
      const cached = cache.get(text);
      if (cached) {
        cache.delete(text);cache.set(text,cached);
        for (const chunk of cached) {signal.throwIfAborted();await output.write(chunk);}
      } else {
        const chunks: SpeechAudioChunk[] = []; let size = 0;
        await drivers.load(text,signal,async chunk => {
          signal.throwIfAborted();
          await output.write(chunk); signal.throwIfAborted();
          size += chunk.bytes.length;
          if (size <= 8*1024*1024) chunks.push({...chunk,bytes:new Uint8Array(chunk.bytes)});
          else chunks.length = 0;
        });
        signal.throwIfAborted();
        if (chunks.length && current === drivers.identity()) {completed = chunks;completedSize = size;}
      }
      signal.throwIfAborted();output.finish();
      if (completed) {
        cache.set(text,completed);cacheBytes += completedSize;
        while (cache.size > 8 || cacheBytes > 12*1024*1024) {
          const oldest = cache.keys().next().value!;
          cacheBytes -= cache.get(oldest)!.reduce((total,chunk)=>total+chunk.bytes.length,0);cache.delete(oldest);
        }
      }
      return stop;
    } catch (reason) {stop();throw reason;}
  }};
}
