/*
 * 主窗口外观（深浅色 + 界面大小）。
 * 此前只在打开「设置 → 通用」时应用：重启后失效、「跟随系统」不生效。
 * 这里在启动时统一应用，并订阅 store 变更（含其它窗口广播）与系统配色。
 */
import { getSetting, subscribeStore } from './store';

export type DesktopTheme = 'system' | 'light' | 'dark';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SYSTEM_DARK_QUERY).matches;
}

/** 'system' 依当前操作系统配色解析为具体主题 */
export function resolveDesktopTheme(theme: DesktopTheme): 'light' | 'dark' {
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return systemPrefersDark() ? 'dark' : 'light';
}

function applyTheme(theme: DesktopTheme) {
  const resolved = resolveDesktopTheme(theme);
  // colorScheme 让原生控件（滚动条、select 等）跟着深浅色走
  document.documentElement.style.colorScheme = resolved;
  document.documentElement.classList.toggle('dark', resolved === 'dark');
}

function applyUiScale(scale: number) {
  const v = typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
  document.documentElement.style.zoom = String(v);
}

/** 立即按当前缓存里的设置应用外观（hydrate 前后各调一次都安全） */
export function refreshDesktopAppearance() {
  applyTheme(getSetting<DesktopTheme>('desktop.theme', 'system'));
  applyUiScale(getSetting('desktop.uiScale', 1));
}

let initialized = false;

/** 启动时调用一次：应用外观 + 订阅后续变化（本窗口设置、跨窗口广播、系统配色） */
export function initDesktopAppearance() {
  if (initialized) return;
  initialized = true;
  // Keep the first-paint theme until the persisted store has been hydrated.
  let initialTheme: DesktopTheme = 'system';
  try {
    const saved = localStorage.getItem('desktop.theme.mirror');
    if (saved === 'light' || saved === 'dark' || saved === 'system') initialTheme = saved;
  } catch { /* use the system theme */ }
  applyTheme(initialTheme);
  applyUiScale(getSetting('desktop.uiScale', 1));

  // setSetting / hydrateStore / ml-store-changed 都会刷新 cache 并触发 listeners
  subscribeStore(refreshDesktopAppearance);

  // 跟随系统：操作系统切换深浅色时实时响应
  try {
    const mq = window.matchMedia(SYSTEM_DARK_QUERY);
    const onChange = () => {
      if (getSetting<DesktopTheme>('desktop.theme', 'system') === 'system') applyTheme('system');
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else mq.addListener(onChange); // 旧版 WebView 兜底
  } catch {
    // 无 matchMedia 时忽略（保持浅色）
  }
}
