import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff } from 'lucide-react';
import { openMicrophone } from '@/lib/microphone';
import { useSetting } from '@/lib/store';
import { Button, Select } from '@/ui/primitives';

export function MicrophoneCheck({ enabled }: { enabled: boolean }) {
  const [deviceId, setDeviceId] = useSetting('interview.microphoneId', '');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState('尚未检测');
  const [level, setLevel] = useState(0);
  const [error, setError] = useState('');
  const lastMeter = useRef(0);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try { const list = await navigator.mediaDevices?.enumerateDevices(); if (alive) setDevices(list?.filter(d => d.kind === 'audioinput') ?? []); } catch { /* Capture reports permission/device errors. */ }
    };
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => { alive = false; navigator.mediaDevices?.removeEventListener('devicechange', refresh); };
  }, [testing]);

  useEffect(() => {
    if (!enabled) setTesting(false);
    if (!testing || !enabled) return;
    let disposed = false;
    let close: (() => Promise<void>) | undefined;
    let heard = false;
    const startedAt = performance.now();
    setError(''); setStatus('正在请求麦克风…'); setLevel(0);
    const timer = window.setTimeout(() => { if (!disposed && !heard) setStatus('未检测到声音，请检查系统输入音量或切换麦克风'); }, 6000);
    void openMicrophone({ deviceId, onPcm: (_pcm, volume) => {
      if (disposed) return;
      if (volume >= 12) heard = true;
      if (performance.now() - lastMeter.current < 100) return;
      lastMeter.current = performance.now();
      setLevel(Math.min(100, Math.round(volume / 80 * 100)));
      setStatus(volume >= 12 ? '已收到声音' : heard ? '麦克风正常，等待说话' : performance.now() - startedAt > 6000 ? '未检测到声音，请检查系统输入音量或切换麦克风' : '请对着麦克风说一句话');
    }, onError: message => { if (!disposed) { setError(message); setTesting(false); } } }).then(async capture => {
      if (disposed) { await capture.close(); return; }
      close = capture.close;
      setStatus(`已连接：${capture.label}`);
      void navigator.mediaDevices.enumerateDevices().then(list => { if (!disposed) setDevices(list.filter(d => d.kind === 'audioinput')); }).catch(() => {});
    }).catch(e => { if (!disposed) { setError(e.message); setTesting(false); } });
    return () => { disposed = true; clearTimeout(timer); void close?.(); setLevel(0); };
  }, [testing, enabled, deviceId]);

  return (
    <div className="mb-4 rounded-lg border bg-muted/20 p-3" data-testid="microphone-check">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Mic size={15} />麦克风检测</div>
      <div className="flex gap-2">
        <Select aria-label="录音麦克风" value={deviceId} disabled={!enabled} onChange={event => { setTesting(false); setError(''); setStatus('设备已切换，请重新检测'); setDeviceId(event.target.value); }}>
          <option value="">跟随系统默认麦克风</option>
          {devices.filter(d => d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, index) => <option key={d.deviceId} value={d.deviceId}>{d.label || `麦克风 ${index + 1}`}</option>)}
          {deviceId && !devices.some(d => d.deviceId === deviceId) && <option value={deviceId}>先前选择的设备（请重新检测）</option>}
        </Select>
        <Button size="sm" variant="outline" disabled={!enabled} onClick={() => { if (testing) setStatus('检测已停止'); setTesting(!testing); }}>
          {testing ? <MicOff size={13} /> : <Mic size={13} />}{testing ? '停止检测' : '测试麦克风'}
        </Button>
      </div>
      <div role="meter" aria-label="麦克风输入音量" aria-valuemin={0} aria-valuemax={100} aria-valuenow={level} className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-100" style={{ width: `${level}%` }} />
      </div>
      <div className="mt-2 text-xs text-muted-foreground" role="status">{status}</div>
      {error && <div role="alert" className="mt-2 text-xs text-destructive">{error}</div>}
      <p className="mt-1.5 text-[11px] text-muted-foreground">检测仅显示本机音量，不发送录音。练习时请说完整一句话，停顿后自动转写。</p>
    </div>
  );
}
