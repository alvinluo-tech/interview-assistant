import {Select} from '@/ui/primitives';
import {SPEECH_LANGUAGES,SPEECH_ACCENTS,type SpeechProfile} from '@/lib/speechProfile';
import {useAiSettings} from '@/lib/aiSettings';
import {resolveSpeechVoice} from '@/lib/speechCatalog';
import {speechRenderSpec} from '@/lib/speechProfile';
export function SpeechProfilePanel({value,onChange,disabled=false,mock=false}:{value:SpeechProfile;onChange:(value:SpeechProfile)=>void;disabled?:boolean;mock?:boolean}) {
  const patch=(change:Partial<SpeechProfile>)=>onChange({...value,...change});
  const settings=useAiSettings(),route=settings.routes.tts,provider=settings.providers.find(item=>item.id===route?.providerId);
  let notice='系统语音仅能使用本机已经安装的语言；方言建议配置云端语音。',unsupported=false;
  if(mock&&provider&&route){try{const selected=resolveSpeechVoice(provider,route.modelId,settings.ttsVoice,speechRenderSpec(value,value.answerLanguage==='en-US'?'English interview question':'技术面试问题'));notice=`朗读模型：${route.modelId} · 音色：${selected.voice}${selected.support==='experimental'?' · 该口音属于风格尝试，效果不保证':selected.support==='unknown'?' · 自定义服务，请先试播确认':' · 已有官方能力说明'}`;if(/^qwen3?-tts/.test(route.modelId)&&value.rate!==1)notice+='；该接口不支持语速参数，使用默认速度。';}catch(error){unsupported=true;notice=String((error as Error).message||error);}}
  return <div className="space-y-3" data-testid="speech-profile">
    <div className="grid gap-3 sm:grid-cols-3">
      <label className="text-xs font-medium text-muted-foreground">识别语言<Select aria-label="识别语言" className="mt-1" value={value.inputLanguage} disabled={disabled} onChange={event=>patch({inputLanguage:event.target.value as SpeechProfile['inputLanguage']})}><option value="auto">自动 · 支持中英混说</option><option value="zh">中文及方言</option><option value="en">英语</option></Select></label>
      <label className="text-xs font-medium text-muted-foreground">{mock?'面试官出题语言':'参考答案语言'}<Select aria-label="答案语言" className="mt-1" value={value.answerLanguage} disabled={disabled} onChange={event=>patch({answerLanguage:event.target.value as SpeechProfile['answerLanguage']})}><option value="follow">跟随当前问题</option>{SPEECH_LANGUAGES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label className="text-xs font-medium text-muted-foreground">辅助翻译<Select aria-label="辅助翻译" className="mt-1" value={value.translationLanguage} disabled={disabled} onChange={event=>patch({translationLanguage:event.target.value as SpeechProfile['translationLanguage']})}><option value="none">关闭 · 保留原文</option>{SPEECH_LANGUAGES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
    </div>
    {mock&&<div className="grid gap-3 sm:grid-cols-3"><label className="text-xs font-medium text-muted-foreground">面试官口音<Select aria-label="面试官口音" className="mt-1" value={value.accent} disabled={disabled} onChange={event=>patch({accent:event.target.value as SpeechProfile['accent']})}>{SPEECH_ACCENTS.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label className="text-xs font-medium text-muted-foreground">复盘语言<Select aria-label="复盘语言" className="mt-1" value={value.reportLanguage} disabled={disabled} onChange={event=>patch({reportLanguage:event.target.value as SpeechProfile['reportLanguage']})}>{SPEECH_LANGUAGES.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</Select></label>
      <label className="text-xs font-medium text-muted-foreground">朗读速度 · {value.rate.toFixed(1)}×<input aria-label="朗读速度" type="range" className="mt-3 w-full" min={0.7} max={1.4} step={0.1} value={value.rate} disabled={disabled} onChange={event=>patch({rate:Number(event.target.value)})}/></label></div>}
    <p className="text-[11px] leading-relaxed text-muted-foreground">识别和回答语言分别生效。方言朗读会匹配当前模型、音色与地域；不支持时保留文字并说明可选服务，英语使用匹配的英文音色。</p>
    {mock&&<p role={unsupported?'alert':'status'} className={`text-xs ${unsupported?'text-amber-500':'text-muted-foreground'}`}>{notice}</p>}
  </div>;
}
