import {getSetting,setSetting,useSetting} from './store';
import {useMemo} from 'react';
import {normalizeSpeechProfile,type SpeechProfile} from './speechProfile';
export type SpeechScene='interview'|'mock';
function readProfile(value:Partial<SpeechProfile>|undefined,legacy?:string){try{return normalizeSpeechProfile(value,legacy);}catch{return normalizeSpeechProfile(undefined,legacy);}}
export function getSpeechProfile(scene:SpeechScene):SpeechProfile {
  const saved=getSetting<Partial<SpeechProfile>|undefined>(`${scene}.speechProfile`,undefined);
  const legacy=scene==='interview'?getSetting<Record<string,unknown>>('interviewPreference',{}).lang:undefined;
  return readProfile(saved,typeof legacy==='string'?legacy:undefined);
}
export function useSpeechProfile(scene:SpeechScene):[SpeechProfile,(value:SpeechProfile)=>Promise<void>] {
  const value=useSetting<Partial<SpeechProfile>|undefined>(`${scene}.speechProfile`,undefined)[0];
  const legacy=useSetting<Record<string,unknown>|undefined>('interviewPreference',undefined)[0]?.lang;
  const profile=useMemo(()=>readProfile(value,scene==='interview'&&typeof legacy==='string'?legacy:undefined),[value,legacy,scene]);
  return [profile,value=>setSetting(`${scene}.speechProfile`,normalizeSpeechProfile(value),{strict:true})];
}
