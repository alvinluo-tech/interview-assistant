export interface QuestionSpeakerDrivers {
  configured: () => boolean;
  cloud: (text: string, signal: AbortSignal) => Promise<ArrayBuffer | null>;
  play: (bytes: ArrayBuffer, state: (speaking: boolean) => void, error: (error: unknown) => void) => () => void;
  system: (text: string, state: (speaking: boolean) => void, error: (error: unknown) => void, signal: AbortSignal) => Promise<() => void>;
}
export function createQuestionSpeaker(drivers: QuestionSpeakerDrivers, state: (speaking: boolean) => void, error: (error: unknown) => void) {
  let generation = 0, cancel: (() => void) | undefined, controller: AbortController | undefined;
  const stop = () => {generation++; controller?.abort(); cancel?.(); cancel = undefined; state(false);};
  return {stop, speak: async (text: string) => {
    stop(); if (!text.trim()) return;
    const current = generation; controller = new AbortController();
    const changed = (speaking: boolean) => {if (current === generation) state(speaking);};
    const failed = (reason: unknown) => {if (current === generation) {state(false); error(reason);}};
    try {
      let release: () => void;
      if (drivers.configured()) {
        const bytes = await drivers.cloud(text, controller.signal);
        if (current !== generation) return;
        if (!bytes?.byteLength) throw new Error('语音服务未返回音频。');
        release = drivers.play(bytes, changed, failed);
      } else release = await drivers.system(text, changed, failed, controller.signal);
      if (current === generation) cancel = release; else release();
    } catch (reason) { failed(reason); }
  }};
}
