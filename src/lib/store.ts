/*
 * 设置存储：键名与原版 store.json 完全一致（跨版本兼容）。
 * 内置 useSyncExternalStore 订阅，change 时可选持久化。
 */
import { useSyncExternalStore } from 'react';

type Listener = () => void;

const listeners = new Set<Listener>();
const cache = new Map<string, unknown>();
let storePromise: Promise<import('@tauri-apps/plugin-store').Store> | null = null;
let hydrating = false;

const STORE_FILE = 'store.json';

async function getStore() {
  if (!storePromise) {
    storePromise = import('@tauri-apps/plugin-store').then((m) =>
      m.load(STORE_FILE, { autoSave: true }),
    );
  }
  return storePromise;
}

export async function hydrateStore() {
  if (hydrating) return;
  hydrating = true;
  try {
    const store = await getStore();
    for (const key of ALL_KEYS) {
      const v = await store.get<unknown>(key);
      if (v !== null && v !== undefined) {
        cache.set(key, v);
      }
    }
    listeners.forEach((l) => l());
  } catch (e) {
    console.warn('[store] hydrate failed', e);
  }
}

/** 写设置（持久化 + 广播 + 跨窗口同步） */
export async function setSetting<T>(key: string, value: T) {
  cache.set(key, value);
  listeners.forEach((l) => l());
  try {
    const store = await getStore();
    await store.set(key, value);
    await store.save();
  } catch (e) {
    console.warn('[store] persist failed', e);
  }
  // 跨窗口同步：主窗口的改动要立刻反映到浮窗（各自独立 JS 上下文）
  try {
    const { emit } = await import('@tauri-apps/api/event');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await emit('ml-store-changed', { key, value, from: getCurrentWindow().label });
  } catch {
    // 非 Tauri 环境忽略
  }
}

/** 订阅其它窗口的 store 变更（每个 webview 启动时调用一次） */
export async function initStoreSync() {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ key: string; value: unknown }>('ml-store-changed', (e) => {
      cache.set(e.payload.key, e.payload.value);
      listeners.forEach((l) => l());
    });
  } catch {
    // 忽略
  }
}

export function getSetting<T>(key: string, fallback: T): T {
  const v = cache.get(key);
  return v === undefined ? fallback : (v as T);
}

/** React hook：订阅设置 */
export function useSetting<T>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => getSetting(key, fallback),
    () => fallback,
  );
  return [value, (v: T) => void setSetting(key, v)];
}

export function subscribeStore(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------------- 键名与默认值（与原版一致） ----------------

export const DEFAULT_OVERLAY_STYLE: OverlayStyle = {
  theme: 'light',
  examBgOpacity: 0.85,
  examBorderOpacity: 0,
  examHeight: 520,
  examTextOpacity: 1,
  examWidth: 420,
  fontScale: 1,
  hotkeyOpacityStep: 0.1,
  interviewBgOpacity: 0.85,
  interviewBorderOpacity: 0,
  interviewHeight: 620,
  interviewTextOpacity: 1,
  interviewWidth: 400,
  paletteBg: '',
  paletteFg: '',
  scrollSpeed: 1,
  textBold: false,
  textHalo: true,
};

export interface OverlayStyle {
  theme: 'light' | 'dark';
  examBgOpacity: number;
  examBorderOpacity: number;
  examHeight: number;
  examTextOpacity: number;
  examWidth: number;
  fontScale: number;
  hotkeyOpacityStep: number;
  interviewBgOpacity: number;
  interviewBorderOpacity: number;
  interviewHeight: number;
  interviewTextOpacity: number;
  interviewWidth: number;
  paletteBg: string;
  paletteFg: string;
  scrollSpeed: number;
  textBold: boolean;
  textHalo: boolean;
}

export interface ExamCustomization {
  answerLanguage: string; // 'auto' | 语言代码
  programmingLanguage: string; // 'auto' | 'Python 3' | ...
  codeQuality: 'standard' | 'readable' | 'concise' | 'performance';
  codeMode: 'auto' | 'acm' | 'core';
  customRequirements: string;
  instructionsPrompt: string;
  instructionsBase: { text: string; lang: string; style: string } | null;
  quickPrompts: string[];
}

export const DEFAULT_EXAM_CUSTOMIZATION: ExamCustomization = {
  answerLanguage: 'auto',
  programmingLanguage: 'auto',
  codeQuality: 'standard',
  codeMode: 'auto',
  customRequirements: '',
  instructionsPrompt: '',
  instructionsBase: null,
  quickPrompts: [],
};

export const ALL_KEYS = [
  'updates.repository',
  'capture.mode',
  'capture.compatibilityMode',
  'settings.owner',
  'interview.autoOpenMockShell',
  'exam.showCopyCodeButton',
  'overlay.stylePresets',
  'interview.dualCamera',
  'exam.nativeOsd',
  'interview.newestFirst',
  'interview.interactive',
  'interview.followStreaming',
  'interview.audioSource',
  'overlay.position',
  'overlay.style',
  'interview.followNewRound',
  'overlay.mode',
  'overlay.actionHotkeysRetiredMigrated',
  'onboarding.skipped',
  'panic.hotkey',
  'overlay.actionHotkeys',
  'exam.dualCamera',
  'overlay.hotkeyScheme',
  'interview.silenceGateMs',
  'interview.answerFirst',
  'notice.usageAcknowledged.v2',
  'interview.autoAnswer',
  'interview.solverExamMode',
  'overlay.parkedLooks',
  'exam.mode',
  'interview.turnCards',
  'interview.showHotkeyHints',
  'disguise.enabled',
  'disguise.windowTitle',
  'disguise.processName',
  'stealth.hideFromTaskbar',
  'changelog.seenDate',
  'changelog.snoozedDate',
  'exam.goalId',
  'exam.customization',
  'exam.customizationOwner',
  'interview.sessionId',
  'interview.pendingMaterialIds',
  'interview.pendingConfig',
  'interview.voiceAskGuideDone',
  'interview.passthroughGuideDone',
  'onboarding.firstRunGuide',
  'capture.experimentalSharedSurface',
  'capture.excluded',
  'audio.excludedOutputs',
  'interviewPreference', // 复刻新增：面试偏好（本地化替代 updateInterviewPreference）
  'mac.screenShareNoticeDismissed',
  'local.user', // 复刻新增：本地用户
] as const;
