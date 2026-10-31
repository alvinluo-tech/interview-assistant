import { useEffect, useState } from 'react';
import { Button, Card, Input, SectionHeader, SettingRow, Switch, showToast } from '@/ui/primitives';
import { useSetting } from '@/lib/store';
import {
  getCaptureStatus, getDisguiseStatus, isTauri, relaunchApp, setCaptureExcluded,
  setDemoVisibleMode, setDisguise, type CaptureStatus, type DisguiseConfig, type DisguiseStatus,
  getPlatformCapabilities, checkScreenCapturePermission, requestScreenCapturePermission,
  openScreenRecordingSettings, type PlatformCapabilities,
} from '@/lib/bridge';

export function StealthTab() {
  const [hideFromTaskbar, setHideFromTaskbar] = useSetting('stealth.hideFromTaskbar', false);
  const [capture, setCapture] = useState<CaptureStatus | null>(null);
  const [identity, setIdentity] = useState<DisguiseStatus | null>(null);
  const [draft, setDraft] = useState<DisguiseConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [capabilities, setCapabilities] = useState<PlatformCapabilities | null>(null);
  const [recordingAllowed, setRecordingAllowed] = useState<boolean | null>(null);

  async function refresh() {
    const [nextCapture, nextIdentity, allowed] = await Promise.all([getCaptureStatus(), getDisguiseStatus(), checkScreenCapturePermission()]);
    setCapture(nextCapture);
    setIdentity(nextIdentity);
    setRecordingAllowed(allowed);
  }

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void Promise.all([getCaptureStatus(), getDisguiseStatus(), getPlatformCapabilities(), checkScreenCapturePermission()]).then(([nextCapture, nextIdentity, platform, allowed]) => {
      if (!active) return;
      setCapture(nextCapture);
      setIdentity(nextIdentity);
      setDraft(nextIdentity.config);
      setCapabilities(platform);
      setRecordingAllowed(allowed);
    }).catch((e: unknown) => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (capabilities?.platform !== 'macos') return;
    let active = true;
    const check = () => { void checkScreenCapturePermission().then(v => { if (active) setRecordingAllowed(v); }).catch(() => {}); };
    window.addEventListener('focus', check);
    return () => { active = false; window.removeEventListener('focus', check); };
  }, [capabilities?.platform]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(String(e));
      showToast({ type: 'error', title: '操作失败', description: String(e) });
      // An unsuccessful transaction may include a rollback failure; read actual native state.
      try { await refresh(); } catch { /* Keep the original error visible. */ }
    } finally { setBusy(false); }
  }

  const captureDisabled = busy || !capture?.supported;
  const identityDisabled = busy || !identity?.supported;
  const enabled = !!capture?.windows.length && capture.windows.every((w) => w.requested);
  const bestEffort = capture?.protectionMode === 'bestEffort';
  const processRename = identity?.processRenameSupported === true;

  return (
    <div className="flex flex-col gap-4">
      {!isTauri() && <p className="text-sm text-muted-foreground">请在桌面客户端中设置这些功能。</p>}
      {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-xs text-destructive">{error}</p>}
      {capabilities?.platform === 'macos' && <Card className="p-5">
        <SectionHeader title="录屏与系统收音权限" desc="截图和采集会议播放声音需要系统授权；麦克风权限由系统另外管理。" />
        <p className="mb-3 text-sm" role="status">{recordingAllowed ? '录屏权限已允许' : '尚未获得录屏权限'}</p>
        {(!capabilities.screenCapture || !capabilities.systemAudio) && <p className="mb-3 text-xs text-destructive">截图与系统收音需要 macOS 13 或更新版本。</p>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || recordingAllowed === true} onClick={() => void act(requestScreenCapturePermission)}>申请权限</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
            if (!await openScreenRecordingSettings()) throw new Error('无法打开系统设置，请手动前往「隐私与安全性 → 屏幕与系统音频录制」。');
          })}>打开系统设置</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(refresh)}>重新检查</Button>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">在「隐私与安全性 → 屏幕与系统音频录制」（较早系统称「屏幕录制」）中允许本应用。授权后若仍显示未允许，请完全退出并重新打开应用。开发模式下系统可能列出终端或开发工具。</p>
      </Card>}
      <Card className="p-5">
        <SectionHeader title="屏幕捕获" desc="控制主窗口和浮窗是否出现在截图、共享屏幕与录屏中。" right={
          <Button size="sm" variant="ghost" disabled={!isTauri() || busy} onClick={() => void act(refresh)}>刷新状态</Button>
        } />
        <SettingRow title={bestEffort ? '限制窗口共享（尽力）' : '反屏幕捕获'} desc={bestEffort ? '请求系统限制其他进程读取窗口；无法保证会议共享或录屏中不可见，设置会保存。' : '默认开启。由 Windows 将主窗口和浮窗排除在支持此功能的屏幕捕获画面之外，设置会保存。'}>
          <Switch ariaLabel={bestEffort ? '限制窗口共享' : '反屏幕捕获'} checked={enabled} disabled={captureDisabled} onCheckedChange={(v) => void act(() => setCaptureExcluded(v))} />
        </SettingRow>
        <SettingRow title="演示可见模式" desc="临时允许主窗口和浮窗出现在共享与录屏中；关闭后恢复捕获设置，重启后自动关闭。">
          <Switch ariaLabel="演示可见模式" checked={capture?.demoVisible ?? false} disabled={captureDisabled} onCheckedChange={(v) => void act(() => setDemoVisibleMode(v))} />
        </SettingRow>
        <div className="mt-2 rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          {capture?.devBypass && <p className="mb-1 text-amber-600 dark:text-amber-400">开发旁路已启用，当前允许捕获。</p>}
          {capture?.windows.map((w) => <p key={w.label}>
            {w.label === 'main' ? '主窗口' : '浮窗'}：{w.error ? `设置异常：${w.error}` : bestEffort ? w.sharingRestricted ? '已设置共享限制，效果需实测' : '未限制窗口共享' : w.affinity === 0x11 ? '捕获排除已设置' : w.affinity === 0 ? '允许捕获' : `亲和性 ${w.affinity}`}
          </p>)}
          <p className="mt-1">{capture?.limitation || '需要 Windows 10 2004 或更新版本。旧系统可能显示黑块；请用实际录屏软件验证效果。'}</p>
        </div>
        <SettingRow title="收起浮窗后不回到任务栏" desc="收起后可从桌面图标重新唤回工作台。">
          <Switch ariaLabel="收起浮窗后不回到任务栏" checked={hideFromTaskbar} onCheckedChange={setHideFromTaskbar} />
        </SettingRow>
      </Card>
      <Card className="p-5">
        <SectionHeader title={processRename ? '进程伪装' : '窗口标题'} desc={processRename ? '窗口标题和图标保存后立即生效；进程文件名需要重启应用。' : 'Mac 支持自定义窗口标题，保存后立即生效。应用名称、图标和进程身份保持原样。'} />
        {identity?.startupError && <p role="alert" className="mb-3 text-xs text-destructive">上次启动未完成伪装：{identity.startupError}</p>}
        {draft && <>
          <SettingRow title={processRename ? '启用进程伪装' : '自定义窗口标题'} desc={processRename ? '以指定文件名的独立副本运行，使用通用程序图标；关闭并重启可恢复原程序。' : '开启后将主窗口和浮窗标题替换为下方内容。关闭可恢复默认标题。'}>
            <Switch ariaLabel={processRename ? '启用进程伪装' : '自定义窗口标题'} checked={draft.enabled} disabled={identityDisabled} onCheckedChange={(v) => setDraft({ ...draft, enabled: v })} />
          </SettingRow>
          <div className={`grid ${processRename ? 'grid-cols-2' : 'grid-cols-1'} gap-3`}>
            {processRename && <label className="text-xs text-muted-foreground">进程文件名
              <Input className="mt-1" value={draft.processName} maxLength={44} disabled={identityDisabled} onChange={(e) => setDraft({ ...draft, processName: e.target.value })} />
              <span className="mt-1 block">1–40 个英文字母、数字、空格或 - . _，可省略 .exe。</span>
            </label>}
            <label className="text-xs text-muted-foreground">窗口标题
              <Input className="mt-1" value={draft.windowTitle} maxLength={128} disabled={identityDisabled} onChange={(e) => setDraft({ ...draft, windowTitle: e.target.value })} />
            </label>
          </div>
          <div className="mt-4 flex gap-2">
            <Button size="sm" disabled={identityDisabled} onClick={() => void act(async () => {
              const status = await setDisguise(draft);
              setIdentity(status);
              setDraft(status.config);
              showToast({ type: 'success', title: status.restartRequired ? '已保存，重启后进程文件名生效' : '已应用窗口身份' });
            })}>保存设置</Button>
            {processRename && <Button size="sm" variant="outline" disabled={identityDisabled || !identity?.restartRequired} onClick={() => void act(relaunchApp)}>重启应用使进程名生效</Button>}
          </div>
        </>}
        {identity && <div className="mt-3 text-xs leading-relaxed text-muted-foreground" aria-live="polite">
          <p>{processRename ? `${identity.runningDisguised ? '当前正在运行伪装副本' : '当前正在运行原程序'}${identity.restartRequired ? '，有待重启的进程设置。' : '。'}` : '窗口标题设置立即生效，无需重启。'}</p>
          <p className="mt-1 break-all">当前程序：{identity.currentExe}</p>
        </div>}
      </Card>
    </div>
  );
}
