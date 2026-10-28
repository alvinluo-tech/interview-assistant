import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { defaultAiSettings, isRoleConfigured, validateAiSettings, type AiRole, type AiSettings } from './aiConfig';

let settings = defaultAiSettings();
let loadError = '';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(l => l());
const desktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
export const getAiSettings = () => settings;
export const getAiLoadError = () => loadError;
export const subscribeAiSettings = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
export function useAiSettings() { return useSyncExternalStore(subscribeAiSettings, getAiSettings, getAiSettings); }
export function useAiReady(role: AiRole = 'chat') { return isRoleConfigured(useAiSettings(), role) && !loadError; }
export async function reloadAiSettings() {
  if (!desktop()) return;
  try {
    const value = await invoke<AiSettings | null>('cmd_ai_load_settings');
    if (value) settings = validateAiSettings(value, true);
    else settings = defaultAiSettings();
    loadError = '';
  } catch (error) { loadError = String(error); settings = { ...settings }; }
  notify();
}
export async function initializeAiSettings() {
  // Subscribe before reading so another window cannot save between hydration and listening.
  if (desktop()) await listen('ai-settings-changed', () => { void reloadAiSettings(); });
  await reloadAiSettings();
}
export async function saveAiSettings(value: AiSettings) {
  if (loadError) throw new Error(`请先解决配置读取问题：${loadError}`);
  const normalized = validateAiSettings(value);
  if (desktop()) await invoke('cmd_ai_save_settings', { config: normalized });
  settings = structuredClone(normalized);
  notify();
  return settings;
}
