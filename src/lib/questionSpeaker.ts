export interface QuestionSpeakerDrivers {
  configured: () => boolean;
  cloud: (text: string, signal: AbortSignal) => Promise<ArrayBuffer | null>;
  play: (bytes: ArrayBuffer, state: (speaking: boolean) => void, error: (error: unknown) => void) => () => void;
  system: (text: string, state: (speaking: boolean) => void, error: (error: unknown) => void, signal: AbortSignal) => Promise<() => void>;
  cloudStream?: (text: string, state: (speaking: boolean) => void, error: (error: unknown) => void, signal: AbortSignal) => Promise<() => void>;
}
export type SpeechPhase = 'idle' | 'preparing' | 'speaking';
export function createQuestionSpeaker(drivers: QuestionSpeakerDrivers, state: (speaking: boolean) => void, error: (error: unknown) => void, phase?: (phase: SpeechPhase) => void) {
  let generation = 0, cancel: (() => void) | undefined, controller: AbortController | undefined;
  const stop = () => {generation++; controller?.abort(); cancel?.(); cancel = undefined; state(false); phase?.('idle');};
  return {stop, speak: async (text: string) => {
    stop(); if (!text.trim()) return;
    const current = generation; controller = new AbortController();
    phase?.('preparing');
    const changed = (speaking: boolean) => {if (current === generation) {state(speaking); phase?.(speaking ? 'speaking' : 'idle');}};
    const failed = (reason: unknown) => {if (current === generation) {generation++; controller?.abort(); cancel?.(); cancel = undefined; state(false); phase?.('idle'); error(reason);}};
    try {
      let release: () => void;
      if (drivers.configured()) {
        if (drivers.cloudStream) {
          release = await drivers.cloudStream(text, changed, failed, controller.signal);
          if (current === generation) cancel = release; else release();
          return;
        }
        const bytes = await drivers.cloud(text, controller.signal);
        if (current !== generation) return;
        if (!bytes?.byteLength) throw new Error('语音服务未返回音频。');
        release = drivers.play(bytes, changed, failed);
      } else release = await drivers.system(text, changed, failed, controller.signal);
      if (current === generation) cancel = release; else release();
    } catch (reason) { failed(reason); }
  }};
}
