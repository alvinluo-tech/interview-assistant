/*
 * 场景分发（对齐原版 vJ/yJ）：#overlay → 浮窗应用；#mock → 模拟面试窗口；
 * 其余 → 主窗口应用。
 */
import { useEffect } from 'react';
import { OverlayApp } from './overlay/OverlayApp';
import { onEvent, isTauri } from './lib/bridge';
import { switchLocale } from './lib/i18n';
import { MockApp } from './mock/MockApp';
import { MainWindow } from './main/MainWindow';
import { ErrorBoundary } from './ErrorBoundary';

export function App({ scene }: { scene: 'overlay' | 'mock' | 'main' }) {
  // 语言切换事件：主窗口/模拟面试窗整窗 reload（对齐原版 vt）；
  // 浮窗不能中途 reload（会杀掉进行中的会话），等会话空闲（浮窗隐藏且引擎无活动
  // 会话）后再刷新，保证浮窗不会遗留旧语言。
  useEffect(() => {
    if (!isTauri()) return;
    if (scene !== 'overlay') {
      return onEvent<{ locale?: string; overlayOnly?: boolean }>(
        'desktop-locale-changed',
        (p) => {
          if (p?.overlayOnly) return;
          void switchLocale((p.locale as never) ?? 'zh-cn');
          window.location.reload();
        },
      );
    }
    let reloading = false;
    const reloadIfIdle = () => {
      if (reloading) return;
      void import('@/lib/interviewEngine').then(({ getInterviewEngineState }) => {
        if (!getInterviewEngineState().sessionId) {
          reloading = true;
          window.location.reload();
        }
      });
    };
    // 每次浮窗隐藏都尝试刷新；会话仍活跃（如应急隐藏）时跳过，等真正空闲的那次隐藏
    const offHidden = onEvent('overlay-hidden', () => reloadIfIdle());
    void (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const visible = await getCurrentWindow().isVisible().catch(() => true);
      if (!visible) reloadIfIdle();
    })();
    return offHidden;
  }, [scene]);

  return (
    <ErrorBoundary scene={scene}>
      {scene === 'overlay' ? <OverlayApp /> : scene === 'mock' ? <MockApp /> : <MainWindow />}
    </ErrorBoundary>
  );
}
