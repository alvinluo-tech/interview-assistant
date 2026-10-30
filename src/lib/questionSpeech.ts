import { cmd, isTauri, listenEvent } from './bridge';
import { getAiSettings } from './aiSettings';
import { createQuestionSpeaker, streamSpeech, synthesizeSpeech } from './aiRequests';
import { createCloudSpeechSession } from './ttsSession';
import { createSpeechOutput } from './ttsPlayback';
import type { SpeechPhase } from './questionSpeaker';

export function questionSpeaker(state: (speaking: boolean) => void, error: (reason: unknown) => void, phase?: (phase: SpeechPhase) => void) {
  const cloud = createCloudSpeechSession({identity:getAiSettings,load:streamSpeech,output:createSpeechOutput});
  const speaker = createQuestionSpeaker({
    configured: () => !!getAiSettings().routes.tts,
    cloud: synthesizeSpeech,
    cloudStream: cloud.speak,
    play: (bytes, changed, failed) => {
      const url = URL.createObjectURL(new Blob([bytes])); const audio = new Audio(url);
      const clean = () => {audio.pause(); audio.src = ''; URL.revokeObjectURL(url);};
      audio.onplay = () => changed(true); audio.onended = () => {changed(false); clean();};
      audio.onerror = () => {failed(new Error('音频播放失败，请检查音色和模型配置。')); clean();};
      void audio.play().catch(reason => {failed(reason); clean();});
      return clean;
    },
    system: async (text, changed, failed, signal) => {
      if (!isTauri()) {
        if (!window.speechSynthesis) throw new Error('当前浏览器无法播放系统语音。请在桌面应用中使用。');
        const utterance = new SpeechSynthesisUtterance(text); utterance.lang = 'zh-CN';
        utterance.onstart = () => changed(true); utterance.onend = () => changed(false);
        utterance.onerror = event => {if (event.error !== 'canceled' && event.error !== 'interrupted') failed(event.error);};
        speechSynthesis.speak(utterance); return () => speechSynthesis.cancel();
      }
      const id = crypto.randomUUID();
      const off = await listenEvent<{id: string; speaking: boolean; error?: string}>('system-speech-state', event => {
        if (event.id !== id) return; changed(event.speaking); if (event.error) failed(event.error);
      });
      if (signal.aborted) {off(); return () => {};}
      const stop = () => {off(); void cmd('cmd_system_speech_stop', {id}).catch(() => {});};
      signal.addEventListener('abort', stop, {once:true});
      try {await cmd('cmd_system_speech', {id, text});} catch (reason) {off(); signal.removeEventListener('abort', stop); throw reason;}
      return () => {signal.removeEventListener('abort', stop); stop();};
    },
  }, state, error, phase);
  return {...speaker,dispose:() => {speaker.stop();cloud.clear();}};
}
