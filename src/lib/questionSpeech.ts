import { cmd, isTauri, listenEvent } from './bridge';
import { getAiSettings } from './aiSettings';
import { createQuestionSpeaker, streamSpeech, synthesizeSpeech } from './aiRequests';
import { createCloudSpeechSession } from './ttsSession';
import { createSpeechOutput } from './ttsPlayback';
import type { SpeechPhase } from './questionSpeaker';
import type {SpeechRenderSpec} from './speechProfile';

export function questionSpeaker(state: (speaking: boolean) => void, error: (reason: unknown) => void, phase?: (phase: SpeechPhase) => void,render?:(text:string)=>SpeechRenderSpec) {
  let spec:SpeechRenderSpec|undefined,lastSettings:unknown,settingsRevision=0;
  const identity=()=>{const settings=getAiSettings();if(settings!==lastSettings){lastSettings=settings;settingsRevision++;}return `${settingsRevision}:${JSON.stringify(spec || {})}`;};
  const cloud = createCloudSpeechSession({identity,load:(text,signal,push)=>streamSpeech(text,signal,push,spec),output:createSpeechOutput});
  const speaker = createQuestionSpeaker({
    configured: () => !!getAiSettings().routes.tts,
    cloud: (text,signal)=>synthesizeSpeech(text,signal,spec),
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
        const utterance = new SpeechSynthesisUtterance(text); utterance.lang = spec?.language || 'zh-CN';utterance.rate=spec?.rate || 1;
        if(spec&&spec.accent!=='standard'&&spec.accent!=='cantonese')throw new Error('系统语音没有已确认的这个方言音色，请配置支持的云端语音。');
        if(spec){const voices=speechSynthesis.getVoices();const voice=voices.find(voice=>{const lang=voice.lang.toLowerCase().replace('_','-');return spec!.language==='yue-HK'?lang.startsWith('yue')||lang==='zh-hk':spec!.language==='en-US'?lang.startsWith('en'):lang.startsWith('zh')&&lang!=='zh-hk';});if(voice)utterance.voice=voice;else if(voices.length)throw new Error('本机未安装匹配的语音包，可继续文字面试或配置云语音。');}
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
      try {await cmd('cmd_system_speech', {id, text,...(spec?{language:spec.language,rate:spec.rate,accent:spec.accent}:{})});} catch (reason) {off(); signal.removeEventListener('abort', stop); throw reason;}
      return () => {signal.removeEventListener('abort', stop); stop();};
    },
  }, state, error, phase);
  return {...speaker,speak:async(text:string)=>{spec=render?.(text);return speaker.speak(text);},dispose:() => {speaker.stop();cloud.clear();}};
}
