/*
 * 应用入口：hash 场景路由（#overlay / #mock / 主窗口）。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { applyDocumentLang, windowScene, t } from './lib/i18n';
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

const root = createRoot(document.getElementById('root')!);
let starting = false, aiInitialized = false, storeSynced = false, dataSynced = false;
async function start() {
  if (starting) return;
  starting = true;
  root.render(<main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground" role="status">{t('正在加载本机资料…')}</main>);
  try {
  if (isTauri()) {
    if (!aiInitialized) {await initializeAiSettings();aiInitialized = true;}
    await hydrateStore();
    if (!storeSynced) {await initStoreSync();storeSynced = true;}
    if (scene === 'main') refreshDesktopAppearance();
    await hydrateData();
    if (!dataSynced) {await initDataSync();dataSynced = true;}
    if(scene === 'main' && !getDataError())await ensureDefaultData();
  }
  const { App } = await import('./App');
  root.render(
    <React.StrictMode>
      <App scene={scene} />
    </React.StrictMode>,
  );
  } catch (error) {
    root.render(<main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center text-foreground">
      <h1 className="text-lg font-semibold">{t('暂时无法加载本机资料')}</h1>
      <p className="max-w-lg text-sm text-muted-foreground">{t('请检查磁盘空间、资料目录权限或文件占用，解决后重试。已有资料会保留。')}</p>
      <p role="alert" className="max-w-lg break-words text-sm">{t(String((error as Error).message || error))}</p>
      <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground" onClick={() => void start()}>{t('重试启动')}</button>
    </main>);
  } finally {starting = false;}
}
void start();

// 全局错误兜底（window.error/unhandledrejection → 上报 + toast）
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
