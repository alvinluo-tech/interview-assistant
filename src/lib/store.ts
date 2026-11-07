/*
 * 设置存储：键名与原版 store.json 完全一致（跨版本兼容）。
 * 内置 useSyncExternalStore 订阅，change 时可选持久化。
 */
import { useSyncExternalStore } from 'react';
import { t } from './i18n';

type Listener = () => void;

const listeners = new Set<Listener>();
const cache = new Map<string, unknown>();
const changes = new Map<string,number>();
let storePromise: Promise<import('@tauri-apps/plugin-store').Store> | null = null;
let hydration: Promise<void> | null = null;
let hydrated = false;
let writes: Promise<void> = Promise.resolve();

const STORE_FILE = 'store.json';

function mirrorDesktopTheme(key: string, value: unknown) {
  if (key !== 'desktop.theme') return;
  try { localStorage.setItem('desktop.theme.mirror', String(value)); } catch { /* storage can be unavailable */ }
}

async function getStore() {
  if (!storePromise) {
    storePromise = import('@tauri-apps/plugin-store').then((m) =>
      m.load(STORE_FILE, { autoSave: false }),
    ).catch(error => { storePromise = null; throw error; });
  }
  return storePromise;
}

/** 已下线的设置键：旧版本写过，现在没有任何读取方，加载时顺手从 store.json 清掉。 */
const RETIRED_KEYS = [
  'local.user',
  'interview.autoOpenMockShell',
  'stealth.hideFromTaskbar',
  'changelog.seenDate',
  'changelog.snoozedDate',
];

export function hydrateStore(): Promise<void> {
  if (hydrated) return Promise.resolve();
  if (hydration) return hydration;
  hydration = (async () => {
    const store = await getStore();
    const loaded = new Map<string, unknown>();
    for (const key of ALL_KEYS) {
      const v = await store.get<unknown>(key);
      if (v !== null && v !== undefined) loaded.set(key, v);
    }
    loaded.forEach((value, key) => {cache.set(key, value);mirrorDesktopTheme(key, value);});
    for (const key of RETIRED_KEYS) {
      // 清理失败只影响文件整洁，不能让设置加载整体失败。
      try {
        const stale = await store.get<unknown>(key);
        if (stale !== null && stale !== undefined) { await store.delete(key); await store.save(); }
      } catch { /* ignore */ }
    }
    hydrated = true;
    listeners.forEach((l) => l());
  })().catch(error => {storePromise = null;throw error;}).finally(() => {hydration = null;});
  return hydration;
}

/** 写设置（持久化 + 广播 + 跨窗口同步） */
export function setSetting<T>(key: string, value: T,_options?:{strict?:boolean}): Promise<void> {
  const write = writes.catch(() => {}).then(async () => {
  const native=typeof window!=='undefined'&&'__TAURI_INTERNALS__' in window;
  const observed=changes.get(key)||0;
  let previous:unknown,changed=false;
  try {
    if(native){
      const {invoke}=await import('@tauri-apps/api/core');
      await invoke('cmd_set_setting',{key,value});
    }else{
    const store = await getStore();
    previous=await store.get(key);
    await store.set(key, value);
    changed=true;
    await store.save();
    }
  } catch (e) {
    if(changed)try{const store=await getStore();if(previous===undefined)await store.delete(key);else await store.set(key,previous);}catch{/* Preserve the original failure. No automatic save is enabled. */}
    throw new Error(t('设置未保存，请检查存储位置和磁盘权限：{message}', { message: String((e as Error).message || e) }));
  }
  if(!native||(changes.get(key)||0)===observed){cache.set(key,value);changes.set(key,observed+1);mirrorDesktopTheme(key, value);listeners.forEach(listener=>listener());}
  // The native transaction already broadcasts in commit order. Re-broadcasting
  // after its IPC response could overwrite a newer setting from another window.
  if(native)return;
  // 跨窗口同步：主窗口的改动要立刻反映到浮窗（各自独立 JS 上下文）
  try {
    const { emit } = await import('@tauri-apps/api/event');
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await emit('ml-store-changed', { key, value, from: getCurrentWindow().label });
  } catch {
    // 非 Tauri 环境忽略
  }
  });
  writes = write;
  // Attach an observer even for legacy fire-and-forget callers; awaited callers still reject.
  void write.catch(error => {void import('./events').then(({bus})=>bus.emit('toast',{type:'error',title:t('设置未保存'),description:String(error.message||error)})).catch(()=>{});});
  return write;
}

/** 订阅其它窗口的 store 变更（每个 webview 启动时调用一次） */
export async function initStoreSync() {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen<{ key: string; value: unknown }>('ml-store-changed', (e) => {
      cache.set(e.payload.key, e.payload.value);
      changes.set(e.payload.key,(changes.get(e.payload.key)||0)+1);
      mirrorDesktopTheme(e.payload.key, e.payload.value);
      listeners.forEach((l) => l());
    });
  } catch (error) {
    if(typeof window!=='undefined'&&'__TAURI_INTERNALS__' in window)throw error;
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
  return [value, (v: T) => {void setSetting(key, v);}];
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
  'interview.speechProfile','mock.speechProfile','interview.speakerMode',
  'ai.taskPreferences',
  'updates.repository',
  'updates.reminder',
  'mock.speechEnabled',
  'capture.mode',
  'capture.compatibilityMode',
  'settings.owner',
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
  'exam.pendingConfig',
  'interview.turnCards',
  'interview.showHotkeyHints',
  'disguise.enabled',
  'disguise.windowTitle',
  'disguise.processName',
  'exam.goalId',
  'exam.customization',
  'exam.customizationOwner',
  'interview.sessionId',
  'interview.pendingMaterialIds',
  // 各页面的选择（简历/岗位/难度等）要跨页面切换保留，组件卸载后从设置恢复。
  'interview.pendingResumeId',
  'mock.pendingResumeId',
  'mock.pendingGoalId',
  'mock.pendingMaterialIds',
  'mock.difficulty',
  'mock.turnBudget',
  'mock.basicsRatio',
  'questionBank.pendingGoalId',
  'questionBank.pendingResumeId',
  'questionBank.experience',
  'interview.pendingConfig',
  'interview.voiceAskGuideDone',
  'interview.passthroughGuideDone',
  'onboarding.firstRunGuide',
  'capture.experimentalSharedSurface',
  'capture.excluded',
  'audio.excludedOutputs',
  'interviewPreference', // 复刻新增：面试偏好（本地化替代 updateInterviewPreference）
  'mac.screenShareNoticeDismissed',
  'desktop.theme', // 主窗口深浅色（'system' | 'light' | 'dark'）
  'desktop.uiScale', // 主窗口界面大小
  'interview.microphoneId', // 麦克风检查/语音提问选择的输入设备
  'mock.assistMode', // 模拟面试 AI 辅助提示开关
  'onboarding.defaultsSeeded', // 示例数据只预置一次
] as const;
