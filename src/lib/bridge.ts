/*
 * 原生命令桥：cmd_* 封装（与原版 zC 对象同形）+ 事件监听助手。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, emit, emitTo } from '@tauri-apps/api/event';

export function isTauri(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return null as T;
  return invoke<T>(name, args);
}

// ---------- overlay 窗口 ----------
export const showOverlay = () => cmd<number>('cmd_show_overlay');
export const hideOverlay = () => cmd<void>('cmd_hide_overlay');
export const positionOverlay = (pos: { x: number; y: number }) =>
  cmd<void>('cmd_position_overlay', { pos });
export const setOverlaySize = (width: number, height: number) =>
  cmd<void>('cmd_set_overlay_size', { width, height });
export interface ZoneRectInput {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export const setOverlayZones = (zones: ZoneRectInput[]) =>
  cmd<void>('cmd_set_overlay_zones', { zones });
export const setOverlayInteractive = (interactive: boolean) =>
  cmd<void>('cmd_set_overlay_interactive', { interactive });
export const setDragActive = (active: boolean) =>
  cmd<void>('cmd_set_drag_active', { active });
export const getCursorPos = () => cmd<{ 0: number; 1: number }>('cmd_get_cursor_pos');
export const setCursorPointFeed = (on: boolean) =>
  cmd<void>('cmd_set_cursor_point_feed', { on });
export const overlayHeartbeat = () => cmd<void>('cmd_overlay_heartbeat');
export const overlayShowSeq = () => cmd<number>('cmd_overlay_show_seq');
export const overlaySessionReady = (seq: number, business: boolean) =>
  cmd<void>('cmd_overlay_session_ready', { seq, business });
export const setSessionActive = (active: boolean) =>
  cmd<void>('cmd_set_session_active', { active });
export const releaseSessionIfNotReady = (seq: number) =>
  cmd<boolean>('cmd_release_session_if_not_ready', { seq });
export const applyOverlayStyles = (styles: unknown) =>
  cmd<void>('cmd_apply_overlay_styles', { styles });

// ---------- 主窗口 ----------
export const showMain = () => cmd<void>('cmd_show_main');
export const hideMain = () => cmd<void>('cmd_hide_main');
export const minimizeMain = () => cmd<void>('cmd_minimize_main');

// ---------- 热键 ----------
export const setActionHotkeys = (bindings: { action: string; accelerator: string }[]) =>
  cmd<void>('cmd_set_action_hotkeys', { bindings });
export const setPanicHotkey = (accelerator: string | null) =>
  cmd<void>('cmd_set_panic_hotkey', { accelerator });
export const panicHotkeyStatus = () =>
  cmd<{ registered: boolean }>('cmd_panic_hotkey_status');

// ---------- 系统音频 ----------
export interface AudioCaptureInfo {
  captureId?: string;
  devices: AudioOutputDevice[];
  sampleRate: number;
  channels: number;
}
export const checkScreenCapturePermission = () => cmd<boolean>('cmd_check_screen_capture_permission');
export const requestScreenCapturePermission = () => cmd<boolean>('cmd_request_screen_capture_permission');
export const openScreenRecordingSettings = () => cmd<boolean>('cmd_open_screen_recording_settings');
async function ensureScreenCapturePermission(): Promise<void> {
  if (!isTauri()) throw new Error('请在桌面应用中使用截图或系统收音。');
  if (await checkScreenCapturePermission()) return;
  await requestScreenCapturePermission();
  if (!await checkScreenCapturePermission()) {
    throw new Error('尚未获得屏幕与系统音频录制权限。请前往「设置 → 隐蔽 → 录屏与系统收音权限」打开系统设置并允许本应用访问，必要时重启应用。');
  }
}
export const startSystemAudioCapture = async () => {
  await ensureScreenCapturePermission();
  return cmd<AudioCaptureInfo>('cmd_start_system_audio_capture');
};
export const stopSystemAudioCapture = () => cmd<void>('cmd_stop_system_audio_capture');
export interface AudioOutputDevice {
  id: string;
  name: string;
  is_default: boolean;
}
export const listSystemAudioOutputs = () => cmd<AudioOutputDevice[]>('cmd_list_system_audio_outputs');
export const setSystemAudioExcludedOutputs = (ids: string[]) =>
  cmd<void>('cmd_set_system_audio_excluded_outputs', { ids });

// ---------- 截屏 ----------
export const captureScreen = async (opts?: {
  compatibilityMode?: boolean;
  captureMode?: string;
  protectedOnTop?: boolean;
}) => {
  await ensureScreenCapturePermission();
  return cmd<string>('cmd_capture_screen', {
    compatibilityMode: opts?.compatibilityMode || undefined,
    captureMode: opts?.captureMode || undefined,
    protectedOnTop: opts?.protectedOnTop === true ? true : undefined,
  });
};

// ---------- 杂项 ----------
export const readRecentLogs = (limit?: number) =>
  cmd<string[]>('cmd_read_recent_logs', { limit: limit ?? 200 });
export const osVersion = () => cmd<string>('cmd_os_version');
export const relaunchApp = () => cmd<void>('cmd_relaunch');
export const getDemoVisibleMode = () => cmd<boolean>('cmd_get_demo_visible_mode');
export const setDemoVisibleMode = (enable: boolean) =>
  cmd<void>('cmd_set_demo_visible_mode', { enable });
export interface CaptureStatus {
  supported: boolean;
  protectionMode: 'windowsAffinity' | 'bestEffort' | 'unsupported';
  limitation: string | null;
  demoVisible: boolean;
  devBypass: boolean;
  windows: { label: string; requested: boolean; affinity: number | null; sharingRestricted: boolean | null; error: string | null }[];
}
export interface DisguiseConfig {
  enabled: boolean;
  processName: string;
  windowTitle: string;
}
export interface DisguiseStatus {
  supported: boolean;
  processRenameSupported: boolean;
  config: DisguiseConfig;
  currentExe: string;
  runningDisguised: boolean;
  restartRequired: boolean;
  startupError: string | null;
}
export interface PlatformCapabilities {
  platform: string;
  systemAudio: boolean;
  screenCapture: boolean;
  cursorZones: boolean;
  windowTitle: boolean;
  processRename: boolean;
  outputDeviceExclusion: boolean;
  captureProtection: 'windowsAffinity' | 'bestEffort' | 'unsupported';
}
export const getPlatformCapabilities = () => cmd<PlatformCapabilities>('cmd_platform_capabilities');
export const getCaptureStatus = () => cmd<CaptureStatus>('cmd_get_capture_status');
export const setCaptureExcluded = (enable: boolean, label?: 'main' | 'overlay') =>
  cmd<void>('cmd_set_capture_excluded', { enable, label });
export const getDisguiseStatus = () => cmd<DisguiseStatus>('cmd_get_disguise_status');
export const setDisguise = (config: DisguiseConfig) => cmd<DisguiseStatus>('cmd_set_disguise', { config });
export const pendingNewerVersion = () => cmd<string | null>('cmd_pending_newer_version');

// ---------- 事件 ----------
export { listen, emit, emitTo };

/** Await registration before starting a producer that can emit immediately. */
export async function listenEvent<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) throw new Error('系统收音需要在桌面应用中使用');
  return listen<T>(event, e => handler(e.payload));
}

export function onEvent<T>(event: string, handler: (payload: T) => void) {
  if (!isTauri()) return () => {};
  let un: (() => void) | null = null;
  listen<T>(event, (e) => handler(e.payload)).then((u) => {
    un = u;
  });
  return () => {
    un?.();
  };
}
