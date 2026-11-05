import { t } from './i18n';
import type { SpeechAudioChunk } from './ttsProtocol.js';

export interface SpeechOutput {
  write(chunk: SpeechAudioChunk): Promise<void>;
  finish(): void;
  stop(): void;
}
/** Schedule PCM on the audio clock, rather than chaining HTMLAudio onended events. */
export function createSpeechOutput(state: (speaking: boolean) => void, error: (reason: unknown) => void,
  contextFactory: () => AudioContext = () => new AudioContext()): SpeechOutput {
  const context = contextFactory();
  const sources = new Set<AudioBufferSourceNode>();
  let closed = false, finished = false, nextTime = 0, lastByte: number | undefined;
  const waiting = new Set<() => void>();
  const waitForCapacity = async () => {
    let lastClock = context.currentTime;
    let lastProgress = Date.now();
    while (!closed && (sources.size >= 32 || nextTime - context.currentTime > 2)) {
      if (context.currentTime > lastClock) {
        lastClock = context.currentTime;
        lastProgress = Date.now();
      }
      if (context.state !== 'running' || Date.now() - lastProgress > 5000) {
        stop();
        throw new Error(t('音频播放已暂停或设备没有响应，请恢复音频设备后重试。'));
      }
      await new Promise<void>(resolve => {
        const release = () => { clearTimeout(timer); waiting.delete(release); resolve(); };
        const timer = setTimeout(release, 50);
        waiting.add(release);
      });
    }
  };
  const stop = () => {
    if (closed) return;
    closed = true;
    for (const release of waiting) release();
    for (const source of sources) {
      source.onended = null;
      try {source.stop();} catch { /* A device failure may leave a source unstarted. */ }
      source.disconnect();
    }
    sources.clear(); state(false); void context.close().catch(() => {});
  };
  const ready = context.resume();
  // Attach rejection handling immediately; write() still propagates the original failure.
  void ready.catch(() => {});
  return {stop, finish: () => {
    if (closed) return;
    if (lastByte !== undefined) throw new Error(t('语音音频数据不完整，请重新朗读。'));
    finished = true; if (!sources.size) stop();
  }, write: async chunk => {
    if (closed) return;
    await ready; if (closed) return;
    if (context.state !== 'running') throw new Error(t('音频播放尚未获准，请点击问题旁的朗读按钮重试。'));
    let buffer: AudioBuffer;
    if (chunk.format === 'encoded') {
      buffer = await context.decodeAudioData(new Uint8Array(chunk.bytes).buffer);
      if (closed) return;
    } else {
      const bytes = new Uint8Array(chunk.bytes.length + (lastByte === undefined ? 0 : 1));
      let offset = 0;
      if (lastByte !== undefined) {bytes[0] = lastByte; offset = 1;}
      bytes.set(chunk.bytes,offset);
      lastByte = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
      const length = Math.floor(bytes.length / 2); if (!length) return;
      const sampleRate = chunk.sampleRate || 24000;
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error(t('语音采样率无效。'));
      buffer = context.createBuffer(1,length,sampleRate);
      const samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2,true) / 32768;
    }
    if (!buffer.length && buffer.duration === 0) return;
    // Bound both playback lead time and node count, including large single responses.
    for (let offset = 0; offset < buffer.duration; offset += 0.5) {
      await waitForCapacity();
      if (closed) return;
      const duration = Math.min(0.5, buffer.duration - offset);
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      const start = Math.max(nextTime, context.currentTime + (nextTime ? 0.02 : 0.12));
      nextTime = start + duration; sources.add(source);
      source.onended = () => {
        sources.delete(source); source.disconnect();
        for (const release of waiting) release();
        if (!closed && finished && !sources.size) stop();
      };
      try {source.start(start, offset, duration); state(true);} catch (reason) {stop(); error(reason); throw reason;}
    }
  }};
}
