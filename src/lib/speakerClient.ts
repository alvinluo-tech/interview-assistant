import {cmd,isTauri} from './bridge';
import type {SpeakerDecision} from './speakerRouting';
export interface SpeakerStatus {ready:boolean;enrolled:boolean;saved:boolean;preparing:boolean;cached?:boolean}
export async function speakerStatus():Promise<SpeakerStatus>{if(!isTauri())return {ready:false,enrolled:false,saved:false,preparing:false};return cmd('cmd_speaker_status');}
export async function identifySpeaker(owner:string,id:string,pcm:Int16Array|null):Promise<SpeakerDecision>{
 if(!pcm)return {role:'unknown',score:0,revision:1,source:'local-match'};
 return cmd('cmd_speaker_identify',{owner,segmentId:id,pcm:Array.from(pcm)});
}
