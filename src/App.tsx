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
  // 语言切换事件：主窗口整窗 reload（对齐原版 vt）
  useEffect(() => {
    if (!isTauri()) return;
    return onEvent<{ locale?: string; overlayOnly?: boolean }>(
      'desktop-locale-changed',
      (p) => {
        if (scene === 'overlay') return; // 浮窗等会话空闲再刷新
        if (p?.overlayOnly) return;
        void switchLocale((p.locale as never) ?? 'zh-cn');
        window.location.reload();
      },
    );
  }, [scene]);

  return (
    <ErrorBoundary scene={scene}>
      {scene === 'overlay' ? <OverlayApp /> : scene === 'mock' ? <MockApp /> : <MainWindow />}
    </ErrorBoundary>
  );
}
