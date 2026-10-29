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

applyDocumentLang();
// Every document layer must be transparent before the overlay can render.
const scene = windowScene();
document.documentElement.classList.toggle('overlay', scene === 'overlay');
document.body.classList.toggle('overlay', scene === 'overlay');

void (async () => {
  if (isTauri()) {
    await initializeAiSettings();
    await hydrateStore();
    await initStoreSync();
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
  console.error('[desktop] uncaught error', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = `rejection: ${String((e.reason as Error | undefined)?.stack ?? e.reason)}`;
  errorSink.push(msg);
  console.error('[desktop] unhandled rejection', e.reason);
});
