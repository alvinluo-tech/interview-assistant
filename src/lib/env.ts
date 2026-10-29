/** 平台环境助手 */
import { version as packageVersion } from '../../package.json';
export function platform(): 'windows' | 'macos' | 'linux' {
  const p = navigator.platform.toLowerCase();
  if (p.includes('mac')) return 'macos';
  if (p.includes('win')) return 'windows';
  return 'linux';
}

export function isMac(): boolean {
  return platform() === 'macos';
}

export function isWindows(): boolean {
  return platform() === 'windows';
}

/** 客户端版本（与 tauri.conf / package.json 同步） */
export const APP_VERSION = packageVersion;

/** 品牌（保持与原应用一致的显示名） */
export const BRAND = '骆耀升老公酱面试助手';
