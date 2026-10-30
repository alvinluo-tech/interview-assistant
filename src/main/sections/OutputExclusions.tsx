import {useEffect, useState} from 'react';
import {isWindows} from '@/lib/env';
import {isTauri, listSystemAudioOutputs, type AudioOutputDevice} from '@/lib/bridge';
import {useSetting} from '@/lib/store';

/** Windows captures the default endpoint plus any non-excluded extra endpoints. */
export function OutputExclusions({active}:{active:boolean}) {
  const [excluded,setExcluded]=useSetting<string[]>('audio.excludedOutputs',[]);
  const [devices,setDevices]=useState<AudioOutputDevice[]>([]);
  const [error,setError]=useState('');
  const [revision,setRevision]=useState(0);
  useEffect(()=>{
    if(!isWindows() || !isTauri())return;
    let disposed=false;
    void listSystemAudioOutputs().then(outputs=>{if(!disposed){setDevices(outputs ?? []);setError('');}})
      .catch(reason=>{if(!disposed)setError(String((reason as Error).message||reason));});
    return ()=>{disposed=true;};
  },[revision]);
  if(!isWindows() || !isTauri())return null;
  return <details className="mb-4 rounded-md border p-3 text-xs">
    <summary className="cursor-pointer font-medium">系统收音设备</summary>
    <p className="my-2 text-muted-foreground">默认播放设备始终采集。可排除其他播放设备；此设置按设备筛选，不能单独排除同一设备上的某个播放器。</p>
    {devices.map(device=><label key={device.id} className="mb-2 flex items-center gap-2">
      <input type="checkbox" disabled={active || device.is_default} checked={!device.is_default && excluded.includes(device.id)}
        onChange={event=>setExcluded(event.target.checked?[...new Set([...excluded,device.id])]:excluded.filter(id=>id!==device.id))} />
      <span>{device.name}{device.is_default?'（默认设备，保留采集）':'（勾选后排除）'}</span>
    </label>)}
    {!devices.length && !error && <p className="my-2 text-muted-foreground">未检测到可用的播放设备。</p>}
    {error && <p role="alert" className="my-2 text-destructive">读取播放设备失败：{error}</p>}
    {active && <p className="my-2 text-muted-foreground">请结束本场面试后调整收音设备。</p>}
    <button type="button" disabled={active} className="text-primary disabled:opacity-50" onClick={()=>setRevision(value=>value+1)}>刷新设备</button>
  </details>;
}
