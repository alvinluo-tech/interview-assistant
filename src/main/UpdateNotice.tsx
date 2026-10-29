import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDownToLine, ArrowRight, Check, CheckCircle2, ChevronDown, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { Button, showToast } from '@/ui/primitives';
import { cmd, isTauri } from '@/lib/bridge';
import { openUpdateDialog, updater, useUpdater } from '@/lib/updater';
import { downloadProgress, formatBytes, releaseDate, releaseNotes, updatePresentation } from '@/lib/updatePresentation';
import brandIcon from '../../src-tauri/icons/128x128.png';
import './update-notice.css';

export function UpdateStatusButton() {
  const state = useUpdater();
  const label = state.version && ['available', 'ready'].includes(state.phase) ? `${state.phase === 'ready' ? '更新已就绪' : '发现新版本'} ${state.version}` : '检查更新';
  return <Button size="sm" variant="outline" onClick={openUpdateDialog}><RefreshCw size={12} />{label}</Button>;
}

export function UpdateNotice() {
  const state = useUpdater();
  const [open, setOpen] = useState(false);
  const manual = useRef(false);
  const announced = useRef(false);
  const dialog = useRef<HTMLElement>(null);
  const id = useId();
  const locked = state.phase === 'installing';
  const canClose = useRef(true);
  canClose.current = !locked;
  const close = () => { if (canClose.current) { setOpen(false); void updater.defer(); } };
  const closeRef = useRef(close);
  closeRef.current = close;

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
    const show = () => { manual.current = true; setOpen(true); if (!['downloading', 'verifying', 'ready', 'installing'].includes(updater.getSnapshot().phase)) void updater.check(true); };
    window.addEventListener('mianxu-open-updater', show);
    return () => window.removeEventListener('mianxu-open-updater', show);
  }, []);
  useEffect(() => {
    if (state.busy && !manual.current) setOpen(false);
    else if (!open && updater.shouldPrompt() && !document.hidden) { manual.current = false; setOpen(true); void updater.defer(); }
    if (state.updatedFrom && !announced.current) { announced.current = true; showToast({ type: 'success', title: `已更新到 ${state.currentVersion}` }); }
  }, [state, open]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => dialog.current?.focus());
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]') || []).filter(node => node.getClientRects().length);
      const first = controls[0], last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); dialog.current?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', key, true);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = overflow; window.removeEventListener('keydown', key, true); if (previous?.isConnected) previous.focus(); };
  }, [open]);

  const view = updatePresentation(state);
  const notes = releaseNotes(state.notes || '');
  const progress = downloadProgress(state);
  const date = releaseDate(state.date);
  const busyPhase = ['checking', 'downloading', 'verifying', 'installing'].includes(state.phase);
  const showProgress = ['downloading', 'verifying', 'ready'].includes(state.phase);
  const releasePage = async () => { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(state.releaseUrl || 'https://github.com/alvinluo-tech/interview-assistant/releases/latest'); };
  const action = async () => {
    try {
      if (view.action === 'check') await updater.check(true);
      else if (view.action === 'download') await updater.download();
      else if (view.action === 'install') await updater.install();
      else if (view.action === 'restore') await cmd('cmd_updater_restore_original');
      else if (view.action === 'release') await releasePage();
    } catch (error) { showToast({ type: 'error', title: String((error as Error).message || error) }); }
  };
  const step = state.phase === 'installing' ? 3 : state.phase === 'ready' ? 2 : state.phase === 'verifying' ? 1 : 0;
  return <>
    {state.version && ['available', 'ready'].includes(state.phase) && <div className="update-banner">
      <span className="update-banner-dot" /><span>{state.phase === 'ready' ? '更新已就绪' : '发现新版本'} {state.version}{state.busy ? ' · 会话结束后可安装' : ''}</span>
      <button onClick={openUpdateDialog}>查看更新 <ArrowRight size={13} /></button>
    </div>}
    {open && createPortal(<div className="update-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section ref={dialog} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1} className="update-card" data-phase={state.phase}>
        <div className="update-brand-row"><img src={brandIcon} width={42} height={42} alt="" /><div><strong>Mianxu</strong><span>客户端更新</span></div>
          {!locked && <button className="update-close" aria-label="关闭更新窗口" onClick={close}><X size={18} /></button>}
        </div>
        <div className="update-heading"><h2 id={`${id}-title`} aria-live="polite">{view.title}</h2>{busyPhase ? <LoaderCircle className="update-spin" size={25} /> : ['ready', 'upToDate'].includes(state.phase) ? <CheckCircle2 className="update-success-icon" size={26} /> : null}</div>
        <p id={`${id}-description`} className="update-description">{view.description}</p>
        <div className="update-version-row"><span>当前 <b>v{state.currentVersion || '…'}</b></span>{state.version && <><ArrowRight size={14} /><span className="update-version-target">v{state.version}</span></>}{date && <time>{date}</time>}</div>
        {state.phase === 'error' && <div role="alert" className="update-error"><p>可以继续使用当前版本，或重新尝试更新。</p>{state.error && <details><summary>查看错误详情</summary><pre>{state.error}</pre></details>}</div>}
        {state.installReason && <div className="update-context">{state.installReason}</div>}
        {state.busy && <div className="update-context">当前会话正在进行，结束面试、笔试、录音或手机副屏会话后即可安装。</div>}
        {showProgress && <div className="update-download">
          <div className="update-download-caption"><span>{state.phase === 'ready' ? '下载完成' : state.phase === 'verifying' ? '正在验证文件' : '下载进度'}</span><b>{progress.percent === null ? '正在获取…' : `${progress.percent}%`}</b></div>
          <div role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent ?? undefined} className={`update-progress ${progress.percent === null ? 'is-indeterminate' : ''}`}><span style={progress.percent === null ? undefined : { width: `${progress.percent}%` }} /></div>
          <div className="update-download-size">{formatBytes(progress.downloaded)}{progress.total ? ` / ${formatBytes(progress.total)}` : ''}</div>
          <ol className="update-steps">{['下载更新', '校验文件', '准备安装'].map((label, index) => <li key={label} data-complete={step > index} data-active={step === index}>{step > index ? <Check size={12} /> : <span />}{label}</li>)}</ol>
        </div>}
        {notes.summary && state.phase !== 'error' && <p className="update-release-summary">{notes.summary}</p>}
        {notes.highlights.length > 0 && state.phase !== 'error' && <ul className="update-highlights">{notes.highlights.map((text, index) => <li key={index}><Check size={14} /><span>{text}</span></li>)}</ul>}
        {notes.blocks.length > 0 && <details className="update-notes"><summary>查看完整更新说明 <ChevronDown size={14} /></summary><div>{notes.blocks.map((block, index) => block.kind === 'heading' ? <h3 key={index}>{block.text}</h3> : block.kind === 'code' ? <pre key={index}>{block.text}</pre> : block.kind === 'bullet' ? <ul key={index}><li>{block.text}</li></ul> : <p key={index}>{block.text}</p>)}</div></details>}
        <footer className="update-footer"><div className="update-actions">{!locked && <button className="update-later" onClick={close}>{state.phase === 'ready' ? '稍后安装' : '稍后提醒'}</button>}{view.action && <button className="update-primary" disabled={view.disabled} onClick={() => void action()}>{view.action === 'download' ? <ArrowDownToLine size={16} /> : view.action === 'install' ? <RefreshCw size={15} /> : null}{view.actionLabel}{!['download', 'install'].includes(view.action) && <ArrowRight size={15} />}</button>}</div>
          <div className="update-footer-meta"><span><ShieldCheck size={13} />官方更新 · 安装前验证文件</span>{!locked && <button onClick={() => void releasePage().catch(() => showToast({ type: 'error', title: '暂时无法打开发布页，请稍后重试' }))}>发布页 <ExternalLink size={12} /></button>}</div>
        </footer>
      </section>
    </div>, document.body)}
  </>;
}
