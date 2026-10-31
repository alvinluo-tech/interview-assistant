/*
 * 手机副屏二维码卡（对齐原版 lB，BS:37325-37426）：
 * 「答案只显示在手机上，电脑屏幕上什么都不留」——扫码后浮窗画面投到手机网页，
 * 本地浮窗隐身。原版走 getTempToken + 服务端中继；本地版由 Rust 起局域网服务。
 */
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { MonitorSmartphone, RefreshCw } from 'lucide-react';
import { Badge, Button, Card } from '@/ui/primitives';
import { onEvent } from '@/lib/bridge';
import {
  dualUrlWithToken,
  startDualScreen,
  stopDualScreen,
  requestDualView,
  type DualStartInfo,
} from '@/lib/dualScreen';

export function DualScreenCard() {
  const [info, setInfo] = useState<DualStartInfo | null>(null);
  const [qrData, setQrData] = useState('');
  const [peers, setPeers] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const launch = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await startDualScreen();
      setInfo(result);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const stop = async () => {
    try { await stopDualScreen(); setInfo(null); setPeers(0); setError(''); }
    catch { setError('停止副屏失败，请重试。'); }
  };

  // 组件卸载时停服务（回到工作台不影响已连接会话则保留——原版常驻入口，这里保持运行）
  useEffect(() => {
    return onEvent<{ count: number; reason?: string }>('dual-peer', (p) => {
      setPeers(p.count);
      if (p.reason === 'stopped') { setInfo(null); setQrData(''); }
    });
  }, []);

  useEffect(() => {
    if (!info || !canvasRef.current) return;
    const url = dualUrlWithToken(info);
    setQrData(url);
    QRCode.toCanvas(canvasRef.current, url, { width: 168, margin: 1, errorCorrectionLevel: 'M' }).catch(
      () => setError('二维码生成失败'),
    );
  }, [info]);

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-semibold">
            <MonitorSmartphone size={14} className="text-primary" />
            手机副屏
          </div>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            连接后电脑浮窗内容隐藏，答案显示在手机上。可直接在手机操作，也可用电脑鼠标悬停手机映射的按钮；手机可随时切回电脑或结束笔试。
          </p>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-amber-700 dark:text-amber-400">副屏连接目前未加密，请仅在可信的私人网络中使用；同一网络中的攻击者可能截获内容和连接地址。</p>
        </div>
        <Badge variant={peers > 0 ? 'default' : 'secondary'}>{peers > 0 ? '手机已连接' : '未连接'}</Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-4">
        {!info ? (
          <>
            <Button size="sm" onClick={() => void launch()} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
              {loading ? '启动中…' : '生成连接二维码'}
            </Button>
            <Button size="sm" variant="ghost" disabled={loading} onClick={() => void stop()}>停止副屏并切回电脑</Button>
          </>
        ) : (
          <>
            <canvas ref={canvasRef} className="rounded-md border bg-white p-1" width={168} height={168} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="text-xs text-muted-foreground">
                手机连同一个 Wi-Fi，用相机/微信扫码打开；或手动输入：
              </div>
              <div className="flex items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded border bg-muted/50 px-2 py-1 text-[11px]">
                  {qrData}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(qrData)
                      .then(() => setError(''))
                      .catch(() => setError('复制失败'))
                  }
                >
                  复制
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={peers === 0} onClick={() => void requestDualView('desktop').catch(() => setError('切换失败，请重试。'))}>切回电脑</Button>
                <Button size="sm" variant="outline" disabled={peers === 0} onClick={() => void requestDualView('phone').catch(() => setError('切换失败，请重试。'))}>继续副屏</Button>
                <Button size="sm" variant="ghost" disabled={loading} onClick={() => void launch()}>
                  换一个二维码
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void stop()}
                >
                  断开手机连接
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                同一场笔试切换显示端会保留连接；手机可点“继续副屏”，无需重扫。结束笔试、更换二维码或主动断开连接后，需要重新扫码。
              </p>
            </div>
          </>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-red-500">{error}</div>}
    </Card>
  );
}
