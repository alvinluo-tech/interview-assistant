/*
 * 应用入口：hash 场景路由（#overlay / #mock / 主窗口），对齐原版 vJ。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { applyDocumentLang, windowScene } from './lib/i18n';
import { hydrateStore, initStoreSync } from './lib/store';
import { hydrateData, ensureDefaultData, initDataSync, getDataError } from './lib/backend';
import { isTauri } from './lib/bridge';
import { initializeAiSettings } from './lib/aiSettings';
import { initDesktopAppearance, refreshDesktopAppearance } from './lib/desktopAppearance';

applyDocumentLang();
// Every document layer must be transparent before the overlay can render.
const scene = windowScene();
document.documentElement.classList.toggle('overlay', scene === 'overlay');
document.body.classList.toggle('overlay', scene === 'overlay');
// 主窗口深浅色/界面大小：先按系统配色应用，hydrate 后再按持久化设置刷新
// （浮窗自带样式体系、模拟面试窗固定深色，都不归这里管）
if (scene === 'main') initDesktopAppearance();

void (async () => {
  if (isTauri()) {
    await initializeAiSettings();
    await hydrateStore();
    await initStoreSync();
    if (scene === 'main') refreshDesktopAppearance();
    await hydrateData();
    await initDataSync();
    if(!getDataError())await ensureDefaultData();
  }
  const { App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App scene={scene} />
    </React.StrictMode>,
  );
})();

// 全局错误兜底（对齐原版：window.error/unhandledrejection → 上报 + toast）
const errorSink: string[] = [];
(window as unknown as { __errors: string[] }).__errors = errorSink;
window.addEventListener('error', (e) => {
  const msg = String((e.error as Error | undefined)?.stack ?? e.message);
  errorSink.push(msg);
  if (errorSink.length > 400) errorSink.splice(0,errorSink.length-400);
  console.error('[desktop] uncaught error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = `rejection: ${String((e.reason as Error | undefined)?.stack ?? e.reason)}`;
  errorSink.push(msg);
  if (errorSink.length > 400) errorSink.splice(0,errorSink.length-400);
  console.error('[desktop] unhandled rejection', e.reason);
});
