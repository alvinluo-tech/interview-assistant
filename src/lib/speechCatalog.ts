import type {AiProvider} from './aiConfig';
import type {SpeechAccent,SpeechLanguage,SpeechRenderSpec} from './speechProfile';
import {bailianRegion} from './realtimeAsrProtocol.js';
export interface SpeechVoice {id:string;name:string;languages:SpeechLanguage[];accents:SpeechAccent[];regions?:string[];instruction?:boolean}
const zh:SpeechLanguage[]=['zh-CN'],en:SpeechLanguage[]=['en-US'],both:SpeechLanguage[]=['zh-CN','en-US'];
const voice=(id:string,name:string,languages:SpeechLanguage[]=both,accents:SpeechAccent[]=['standard'],regions?:string[],instruction=false):SpeechVoice=>({id,name,languages,accents,regions,instruction});
const mimoAccents:SpeechAccent[]=['standard','cantonese','sichuan','northeastern','henan','chongqing'];
const qwenAudioDialects:SpeechAccent[]=['standard','cantonese','chongqing','northeastern','shanghai','shaanxi','yunnan','ningbo','gansu'];
export function voicesForModel(model:string):SpeechVoice[]{
  if(model==='mimo-v2.5-tts')return [...['苏打','冰糖','茉莉','白桦'].map(id=>voice(id,id,[...zh,'yue-HK'],mimoAccents,undefined,true)),...['Mia','Chloe','Milo','Dean'].map(id=>voice(id,id,en))];
  if(/^qwen3?-tts-flash(?:-|$)/.test(model))return [voice('Cherry','芊悦 · 女声'),voice('Serena','苏瑶 · 女声'),voice('Ethan','晨煦 · 男声'),voice('Chelsie','千雪 · 女声'),
    voice('Rocky','阿强 · 粤语',['yue-HK','en-US'],['cantonese']),voice('Kiki','阿清 · 粤语',['yue-HK','en-US'],['cantonese']),voice('Eric','程川 · 四川话',both,['sichuan'])];
  if(model==='qwen-audio-3.1-tts-flash')return [voice('longanhuan_v3.1','龙安欢 · 多方言',[...zh,'yue-HK'],qwenAudioDialects,['beijing','singapore'],true),
    voice('xunanchuan_v3.1','许南川 · 多方言',[...zh,'yue-HK'],qwenAudioDialects,['beijing','singapore'],true),
    voice('longanlingxin_v3.1','龙安灵心 · 多方言',[...zh,'yue-HK'],qwenAudioDialects,['beijing','singapore'],true),
    voice('Abby_v3.1','Abby · 美式英文',en,['standard'],['beijing','singapore'],true),voice('Emily_v3.1','Emily · 英式英文',en,['standard'],['beijing','singapore'],true),voice('David_v3.1','David · 美式英文',en,['standard'],['beijing','singapore'],true)];
  if(/^qwen-audio-3\.0-tts/.test(model))return [voice('longanhuan_v3.6','龙安欢',both,['standard'],['beijing','singapore'],true)];
  if(model==='cosyvoice-v3-flash')return [voice('longanyang','龙安洋 · 男声',both,['standard'],['beijing','singapore']),
    voice('longanhuan_v3','龙安欢 · 多方言',[...both,'yue-HK'],['standard','cantonese','northeastern','henan','shaanxi','sichuan'],['beijing'],true),
    voice('longanyue_v3','龙安粤 · 粤语',['yue-HK','en-US'],['cantonese'],['beijing','singapore']),
    voice('longlaotie_v3','龙老铁 · 东北话',both,['northeastern'],['beijing']),voice('longshange_v3','龙陕哥 · 陕西话',both,['shaanxi'],['beijing','singapore']),voice('longanmin_v3','龙安闽 · 闽南语',both,['minnan'],['beijing','singapore'])];
  return [];
}
export function speechRegion(provider:Pick<AiProvider,'baseUrl'>){try{return bailianRegion(new URL(provider.baseUrl).hostname);}catch{return undefined;}}
export function availableVoices(provider:Pick<AiProvider,'baseUrl'>,model:string):SpeechVoice[]{
  const region=speechRegion(provider);return voicesForModel(model).filter(voice=>!voice.regions||!region||voice.regions.includes(region));
}
export const ACCENT_INSTRUCTIONS:Record<SpeechAccent,string>={standard:'普通话',cantonese:'粤语',sichuan:'四川话',chongqing:'重庆话',northeastern:'东北话',henan:'河南话',shanghai:'上海话',shaanxi:'陕西话',minnan:'闽南语',yunnan:'云南话',ningbo:'宁波话',gansu:'甘肃话'};
export function resolveSpeechVoice(provider:Pick<AiProvider,'baseUrl'>,model:string,preferredVoice:string,spec:SpeechRenderSpec){
  const voices=availableVoices(provider,model),language=spec.language,accent=language==='en-US'?'standard':spec.accent;
  const matching=voices.filter(item=>item.languages.includes(language)&&(language==='en-US'||item.accents.includes(accent))).sort((a,b)=>a.accents.length-b.accents.length);
  const selected=matching.find(item=>item.id===(spec.voiceId || preferredVoice)) || matching[0];
  if(!selected){
    if(!voicesForModel(model).length && accent==='standard')return {voice:spec.voiceId || preferredVoice || 'alloy',support:'unknown' as const,languageHint:language==='en-US'?'English':'Chinese',instruction:''};
    throw new Error(`当前模型/音色在${speechRegion(provider)==='singapore'?'新加坡':'所选地域'}不支持这个朗读口音。重庆/东北等可选择 qwen-audio-3.1-tts-flash；也可更换音色或使用标准发音。`);
  }
  const dialect=ACCENT_INSTRUCTIONS[accent];
  const instruction=language==='en-US'?'Speak in natural, professional English. Read only the given text.':accent==='standard'?'请用普通话，以自然、专业、友好的面试官语气朗读，只朗读给定文本。':model==='cosyvoice-v3-flash'?`请用${accent==='cantonese'?'广东话':dialect}表达。`:`请用${dialect}自然、专业地朗读，只朗读给定文本，不添加内容。`;
  return {voice:selected.id,languageHint:language==='en-US'?'English':'Chinese',instruction,
    support:model==='mimo-v2.5-tts'&&accent==='chongqing'?'experimental' as const:'documented' as const,
    useInstruction:model.startsWith('mimo-')||selected.instruction};
}
