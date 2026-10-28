/** Streaming linear resampler. Keep the boundary sample and a non-negative cursor. */
export class PcmResampler {
  private tail = new Float32Array(0);
  private position = 0;
  constructor(private readonly sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('无效的音频采样率');
  }
  process(block: Float32Array): Int16Array {
    const input = new Float32Array(this.tail.length + block.length);
    input.set(this.tail); input.set(block, this.tail.length);
    const step = this.sampleRate / 16000;
    const result: number[] = [];
    while (this.position + 1 < input.length) {
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const sample = input[index] * (1 - fraction) + input[index + 1] * fraction;
      result.push(Math.round(Math.max(-1, Math.min(1, sample)) * 32767));
      this.position += step;
    }
    const consumed = Math.min(Math.floor(this.position), Math.max(0, input.length - 1));
    this.tail = input.slice(consumed);
    this.position -= consumed;
    return Int16Array.from(result);
  }
}

export function microphoneError(error: unknown): string {
  const name = (error as Error)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝。请在 Windows「设置 → 隐私和安全性 → 麦克风」允许桌面应用访问，然后重试。';
  if (name === 'NotFoundError') return '没有找到麦克风。请连接输入设备，然后重试。';
  if (name === 'OverconstrainedError') return '所选麦克风已不可用。请返回工作台重新选择设备。';
  if (name === 'NotReadableError' || name === 'AbortError') return '麦克风无法读取，可能被其他应用独占。请检查设备后重试。';
  return (error as Error)?.message || '麦克风启动失败，请检查输入设备后重试。';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]);
  } finally { clearTimeout(timer); }
}

export interface MicrophoneCapture {
  label: string;
  setPaused(paused: boolean): Promise<void>;
  close(): Promise<void>;
}

/** The workbench test and interview use the same capture path. Test audio stays local. */
export async function openMicrophone(options: {
  deviceId?: string;
  onPcm: (pcm: Int16Array, volume: number) => void;
  onError: (message: string) => void;
}): Promise<MicrophoneCapture> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法访问麦克风，请使用桌面客户端。');
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let processor: ScriptProcessorNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let closed = false;
  let ready = false;
  let paused = false;
  const close = async () => {
    closed = true; ready = false;
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); }
    source?.disconnect();
    stream?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop(); });
    if (context) { context.onstatechange = null; await context.close().catch(() => {}); }
  };
  try {
    const request = navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true,
      ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}),
    } });
    void request.then(late => { if (closed) late.getTracks().forEach(track => track.stop()); }, () => {});
    stream = await withTimeout(request, 15000, '等待麦克风授权超时，请允许访问麦克风后重试。');
    context = new AudioContext();
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    const resampler = new PcmResampler(context.sampleRate);
    processor.onaudioprocess = event => {
      if (!ready || closed || paused) return;
      const pcm = resampler.process(event.inputBuffer.getChannelData(0));
      if (!pcm.length) return;
      let sum = 0;
      for (const sample of pcm) sum += Math.abs(sample / 32767);
      options.onPcm(pcm, sum / pcm.length * 800);
    };
    source.connect(processor);
    // ScriptProcessor's output is zero-filled; no microphone monitoring/feedback.
    processor.connect(context.destination);
    if (context.state !== 'running') await withTimeout(context.resume(), 4000, '音频尚未启动，请点击「重试收音」激活麦克风。');
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('所选设备没有可用的音频轨道。');
    track.onended = () => { if (!closed) options.onError('麦克风已断开，请连接设备后点击「重试收音」。'); };
    track.onmute = () => { if (ready && !paused) options.onError('麦克风输入被系统静音或中断，请检查设备后重试。'); };
    context.onstatechange = () => { if (ready && !paused && !closed && context?.state !== 'running') options.onError('音频采集已中断，请点击「重试收音」。'); };
    ready = true;
    return { label: track.label || '默认麦克风', close, async setPaused(value) {
      paused = value;
      stream?.getTracks().forEach(track => { track.enabled = !value; });
      if (!value && context?.state === 'suspended') await withTimeout(context.resume(), 4000, '音频恢复失败，请点击「重试收音」。');
    } };
  } catch (error) { await close(); throw new Error(microphoneError(error)); }
}
