/** Identity evidence arrives independently of transcript text. Unknown is never a peer identity. */
export type SpeakerRole='candidate'|'interviewer'|'unknown'|'overlap';
export interface SpeakerDecision {role:SpeakerRole;score:number;revision:number;clusterId?:string;source?:'local-match'|'manual'|'channel'}
export interface SpeakerAction {id:string;text:string;kind:'candidate'|'question'|'retract';decision:SpeakerDecision}
export class SpeakerTurnRouter {
  private closed=false;
  private segments=new Map<string,{text:string;final:boolean;decision?:SpeakerDecision;applied?:string}>();
  constructor(private readonly action:(value:SpeakerAction)=>void){}
  text(input:{id:string;text:string;final:boolean}){if(this.closed)return;const state=this.segments.get(input.id)||{text:'',final:false};Object.assign(state,{text:input.text,final:input.final});this.segments.set(input.id,state);this.route(input.id);}
  speaker(id:string,decision:SpeakerDecision){if(this.closed)return;const state=this.segments.get(id)||{text:'',final:false};if(state.decision&&decision.revision<=state.decision.revision)return;state.decision=decision;this.segments.set(id,state);this.route(id);}
  private route(id:string){const state=this.segments.get(id)!;if(!state.final||!state.decision||!state.text)return;
    const {decision}=state;const key=`${decision.revision}:${decision.role}`;if(state.applied===key)return;
    if(state.applied)this.action({id,text:state.text,kind:'retract',decision});
    if(decision.role==='candidate'||decision.role==='interviewer'){this.action({id,text:state.text,kind:decision.role==='candidate'?'candidate':'question',decision});state.applied=key;}
    else state.applied=undefined;
    while(this.segments.size>2000)this.segments.delete(this.segments.keys().next().value!);
  }
  close(){this.closed=true;this.segments.clear();}
}
/** PCM16 at one clock. Missing/evicted ranges are explicit, not silently replaced by nearby speech. */
export class AudioTimeline {
  private blocks:{start:number;data:Int16Array}[]=[];private total=0;
  constructor(private rate=16000,private seconds=90){}
  get samples(){return this.total;}
  push(pcm:Int16Array){this.blocks.push({start:this.total,data:new Int16Array(pcm)});this.total+=pcm.length;const oldest=this.total-this.rate*this.seconds;while(this.blocks.length&&this.blocks[0].start+this.blocks[0].data.length<=oldest)this.blocks.shift();}
  range(startMs:number,endMs:number):Int16Array|null {
    const start=Math.round(startMs*this.rate/1000),end=Math.round(endMs*this.rate/1000);
    if(start<0||end<=start||end>this.total||!this.blocks.length||start<this.blocks[0].start)return null;
    const output=new Int16Array(end-start);for(const block of this.blocks){const a=Math.max(start,block.start),b=Math.min(end,block.start+block.data.length);if(b>a)output.set(block.data.subarray(a-block.start,b-block.start),a-start);}return output;
  }
  reset(){this.blocks=[];this.total=0;}
}
