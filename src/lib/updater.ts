import { useSyncExternalStore } from 'react';
import { cmd, isTauri, listenEvent } from './bridge';
import { getSetting, setSetting } from './store';
import { createUpdateClient, type UpdateSnapshot } from './updateCheck';

export const updater = createUpdateClient({
  invoke: async (command, args) => {
    if (!isTauri()) throw new Error('请在桌面应用中检查和安装更新。');
    return cmd<UpdateSnapshot>(command, args);
  },
  listen: callback => listenEvent<UpdateSnapshot>('updater-state', callback),
  read: key => getSetting(key, null),
  write: setSetting,
  now: Date.now,
});
export function useUpdater() { return useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot); }
export function openUpdateDialog() { window.dispatchEvent(new Event('mianxu-open-updater')); }
