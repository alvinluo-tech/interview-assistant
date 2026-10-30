/** User intent, independent of UI locale and provider parameter names. */
export type SpeechLanguage = 'zh-CN' | 'en-US' | 'yue-HK';
export type SpeechAccent = 'standard'|'cantonese'|'sichuan'|'chongqing'|'northeastern'|'henan'|'shanghai'|'shaanxi'|'minnan'|'yunnan'|'ningbo'|'gansu';
export interface SpeechProfile {
  version:1; inputLanguage:'auto'|'zh'|'en'; answerLanguage:SpeechLanguage|'follow';
  translationLanguage:SpeechLanguage|'none'; reportLanguage:SpeechLanguage;
  accent:SpeechAccent; rate:number;
}
export interface SpeechRenderSpec {language:SpeechLanguage;accent:SpeechAccent;rate:number;voiceId?:string}
export const SPEECH_LANGUAGES = [{id:'zh-CN',name:'中文'},{id:'en-US',name:'英语'},{id:'yue-HK',name:'粤语'}] as const;
export const SPEECH_ACCENTS = [{id:'standard',name:'标准发音'},{id:'cantonese',name:'粤语'},{id:'sichuan',name:'四川话'},
  {id:'chongqing',name:'重庆话'},{id:'northeastern',name:'东北口音'},{id:'henan',name:'河南话'},
  {id:'shanghai',name:'上海话'},{id:'shaanxi',name:'陕西话'},{id:'minnan',name:'闽南语'},{id:'yunnan',name:'云南话'},{id:'ningbo',name:'宁波话'},{id:'gansu',name:'甘肃话'}] as const;
export const DEFAULT_SPEECH_PROFILE:SpeechProfile={version:1,inputLanguage:'auto',answerLanguage:'zh-CN',translationLanguage:'none',reportLanguage:'zh-CN',accent:'standard',rate:1};
export function normalizeSpeechProfile(value?:Partial<SpeechProfile>,legacyLang?:string):SpeechProfile {
  const legacy=legacyLang?.startsWith('en')?'en-US':legacyLang?.startsWith('yue')?'yue-HK':'zh-CN';
  const profile={...DEFAULT_SPEECH_PROFILE,...(!value&&legacyLang?{answerLanguage:legacy as SpeechLanguage,inputLanguage:legacy==='en-US'?'en' as const:'zh' as const}:{}),...value,version:1 as const};
  if(!['auto','zh','en'].includes(profile.inputLanguage)||!['zh-CN','en-US','yue-HK','follow'].includes(profile.answerLanguage)
    ||!['none','zh-CN','en-US','yue-HK'].includes(profile.translationLanguage)||!['zh-CN','en-US','yue-HK'].includes(profile.reportLanguage)
    ||!SPEECH_ACCENTS.some(item=>item.id===profile.accent)||!Number.isFinite(profile.rate)||profile.rate<0.7||profile.rate>1.4)
    throw new Error('语言或声音设置无效，请重新选择。');
  return profile;
}
export function recognitionLanguage(profile:SpeechProfile){return profile.inputLanguage;}
export function detectTextLanguage(text:string):SpeechLanguage {
  const han=(text.match(/[\u3400-\u9fff]/g)||[]).length;
  const words=(text.match(/[A-Za-z]+/g)||[]).length;
  return words>=3&&words>han/2?'en-US':'zh-CN';
}
export function languageName(language:SpeechLanguage|'follow'){return language==='en-US'?'英语（English）':language==='yue-HK'?'粤语口语':'中文';}
export function languagePrompt(profile:SpeechProfile,task:'interview'|'mock'|'hint'|'report'='interview'):string {
  const language=task==='report'?profile.reportLanguage:profile.answerLanguage;
  const instruction=language==='follow'?'跟随当前问题的主要语言；中英混说时保留技术术语，不根据应用界面语言强行改成中文。':`使用${languageName(language)}输出正文。`;
  return `${instruction}\n语言切换时保持前文技术方案、事实与约束，不重复自我介绍、不编造经历。代码、API 名称、数字和复杂度保留原意。${task==='mock'?'只问一个自然、可朗读的技术问题，方言不等于搞笑人设。':''}${task==='report'?'评价技术内容时不因方言或口音扣分；未经用户选择，不把语言流利度当作技术能力。':''}`;
}
export function speechRenderSpec(profile:SpeechProfile,text:string):SpeechRenderSpec {
  let language=profile.answerLanguage==='follow'?detectTextLanguage(text):profile.answerLanguage;
  if(language==='zh-CN'&&profile.accent==='cantonese')language='yue-HK';
  return {language,accent:language==='en-US'?'standard':language==='yue-HK'?'cantonese':profile.accent,rate:profile.rate};
}
