import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { Button, Dialog, DialogTitle, showToast } from '@/ui/primitives';
import { cmd, isTauri } from '@/lib/bridge';
import { openUpdateDialog, updater, useUpdater } from '@/lib/updater';

const labels: Record<string, string> = {
  idle: '检查更新', checking: '正在检查更新…', available: '发现新版本', upToDate: '当前已是最新版本',
  downloading: '正在下载更新…', verifying: '正在验证更新签名…', ready: '更新已就绪', installing: '正在安装更新…', error: '更新暂时不可用',
};
export function UpdateStatusButton() {
  const state = useUpdater();
  return <Button size="sm" variant="outline" onClick={openUpdateDialog}>
    <RefreshCw size={12} />
    {state.version && ['available', 'ready'].includes(state.phase) ? `${labels[state.phase]} ${state.version}` : labels[state.phase]}
  </Button>;
}

export function UpdateNotice() {
  const state = useUpdater();
  const [open, setOpen] = useState(false);
  const announced = useRef(false);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false, off: (() => void) | undefined;
    void updater.connect().then(unlisten => { if (disposed) unlisten(); else off = unlisten; }).catch(() => {});
    const first = window.setTimeout(() => void updater.check(false), 8000);
    const poll = window.setInterval(() => { if (!document.hidden) void updater.refresh(); }, 10_000);
    const periodic = window.setInterval(() => { if (!document.hidden) void updater.check(false); }, 6 * 3600_000);
    const focus = () => void updater.refresh();
    window.addEventListener('focus', focus);
    return () => { disposed = true; off?.(); window.clearTimeout(first); window.clearInterval(poll); window.clearInterval(periodic); window.removeEventListener('focus', focus); };
  }, []);
  useEffect(() => {
    const show = () => { setOpen(true); if (!['downloading', 'verifying', 'ready', 'installing'].includes(updater.getSnapshot().phase)) void updater.check(true); };
    window.addEventListener('mianxu-open-updater', show);
    return () => window.removeEventListener('mianxu-open-updater', show);
  }, []);
  useEffect(() => {
    if (state.busy) setOpen(false);
    else if (updater.shouldPrompt() && !document.hidden) { setOpen(true); void updater.defer(); }
    if (state.updatedFrom && !announced.current) { announced.current = true; showToast({ type: 'success', title: `已更新到 ${state.currentVersion}` }); }
  }, [state]);
  const locked = state.phase === 'installing';
  const close = () => { if (!locked) { setOpen(false); void updater.defer(); } };
  const releasePage = () => void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(state.releaseUrl || 'https://github.com/alvinluo-tech/interview-assistant/releases/latest'));
  const install = () => void updater.install().catch(error => showToast({ type: 'error', title: String((error as Error).message || error) }));
  const transferring = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  return <>
    {state.version && ['available', 'ready'].includes(state.phase) && <div className="flex items-center justify-between gap-3 border-b bg-primary/5 px-4 py-2 text-xs">
      <span>{labels[state.phase]} {state.version}{state.busy ? ' · 会话结束后可安装' : ''}</span>
      <Button size="sm" variant="ghost" onClick={openUpdateDialog}>查看更新</Button>
    </div>}
    <Dialog open={open} onClose={close} dismissable={!locked}>
      <DialogTitle>{labels[state.phase] || '客户端更新'}{state.version ? ` ${state.version}` : ''}</DialogTitle>
      <p className="mb-3 text-xs text-muted-foreground">当前版本 {state.currentVersion || '读取中…'} · 官方签名更新</p>
      {state.date && <p className="mb-2 text-xs text-muted-foreground">发布时间：{state.date}</p>}
      {state.notes && <div className="mb-4 max-h-52 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{state.notes}</div>}
      {state.error && <p role="alert" className="mb-3 text-sm text-destructive">{state.error}</p>}
      {state.installReason && <p className="mb-3 text-sm text-muted-foreground">{state.installReason}</p>}
      {state.busy && <p className="mb-3 text-sm text-amber-700">请先结束面试、笔试、录音或手机副屏会话，再安装更新。</p>}
      {['downloading', 'verifying', 'ready'].includes(state.phase) && <div className="mb-4 space-y-1">
        <progress aria-label="更新下载进度" className="h-2 w-full" max={100} value={state.phase === 'ready' ? 100 : percent ?? undefined} />
        <p className="text-xs text-muted-foreground">{(state.downloaded / 1024 / 1024).toFixed(1)} MB{state.total ? ` / ${(state.total / 1024 / 1024).toFixed(1)} MB · ${percent}%` : ''}</p>
      </div>}
      {state.phase === 'ready' && <p className="mb-3 text-sm">更新已下载并通过签名验证。安装将重启应用，请先保存正在编辑的内容。</p>}
      {locked && <p className="mb-3 text-sm">正在交给系统安装更新，请勿关闭应用。</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {!locked && <Button size="sm" variant="ghost" onClick={releasePage}>官方发布页</Button>}
        {!transferring && state.phase !== 'ready' && <Button size="sm" variant="outline" onClick={() => void updater.check(true)}>重新检查</Button>}
        {state.canRestoreOriginal && <Button size="sm" disabled={state.busy || transferring} onClick={() => void cmd('cmd_updater_restore_original').catch(error => showToast({ type: 'error', title: String(error) }))}>恢复原程序后更新</Button>}
        {state.version && ['available', 'error'].includes(state.phase) && state.canInstall && <Button size="sm" onClick={() => void updater.download()}><Download size={12} />下载更新</Button>}
        {state.phase === 'ready' && <Button size="sm" disabled={state.busy || !state.canInstall} onClick={install}>重启并安装</Button>}
        {!locked && <Button size="sm" variant="secondary" onClick={close}>{state.phase === 'ready' ? '稍后安装' : '稍后提醒'}</Button>}
      </div>
    </Dialog>
  </>;
}
