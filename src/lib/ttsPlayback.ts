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
  const stop = () => {
    if (closed) return;
    closed = true;
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
    if (lastByte !== undefined) throw new Error('语音音频数据不完整，请重新朗读。');
    finished = true; if (!sources.size) stop();
  }, write: async chunk => {
    if (closed) return;
    await ready; if (closed) return;
    if (context.state !== 'running') throw new Error('音频播放尚未获准，请点击问题旁的朗读按钮重试。');
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
      if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('语音采样率无效。');
      buffer = context.createBuffer(1,length,sampleRate);
      const samples = buffer.getChannelData(0), view = new DataView(bytes.buffer);
      for (let i = 0; i < length; i++) samples[i] = view.getInt16(i * 2,true) / 32768;
    }
    if (!buffer.length && buffer.duration === 0) return;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
    // A small initial buffer absorbs network jitter. Subsequent buffers remain sample-contiguous.
    const start = Math.max(nextTime, context.currentTime + (nextTime ? 0.02 : 0.12));
    nextTime = start + buffer.duration; sources.add(source);
    source.onended = () => {
      sources.delete(source); source.disconnect();
      if (!closed && finished && !sources.size) stop();
    };
    try {source.start(start); state(true);} catch (reason) {stop(); error(reason); throw reason;}
  }};
}
