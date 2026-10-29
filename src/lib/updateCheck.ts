export interface UpdateSnapshot {
  phase: 'idle' | 'checking' | 'available' | 'upToDate' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  currentVersion?: string;
  version?: string;
  notes?: string;
  date?: string;
  releaseUrl?: string;
  updatedFrom?: string;
  downloaded: number;
  total?: number;
  busy: boolean;
  canInstall: boolean;
  installReason?: string;
  canRestoreOriginal?: boolean;
  error?: string;
}
export interface UpdateClientDependencies {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<UpdateSnapshot>;
  listen: (callback: (snapshot: UpdateSnapshot) => void) => Promise<() => void>;
  read: (key: string) => unknown;
  write: (key: string, value: unknown) => Promise<void>;
  now: () => number;
}

/** One shared controller for startup notifications and the settings panel. */
export function createUpdateClient(deps: UpdateClientDependencies) {
  let snapshot: UpdateSnapshot = { phase: 'idle', downloaded: 0, busy: false, canInstall: false };
  let inFlight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: UpdateSnapshot) => { snapshot = { ...next }; listeners.forEach(fn => fn()); };
  const run = (command: string, args?: Record<string, unknown>) => {
    if (inFlight) return inFlight;
    const task = deps.invoke(command, args).then(publish).catch(error => {
      publish({ ...snapshot, phase: 'error', error: String((error as Error)?.message || error) });
    }).finally(() => { if (inFlight === task) inFlight = null; });
    inFlight = task;
    return task;
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect: () => deps.listen(publish),
    check: (manual = false) => run('cmd_updater_check', { manual }),
    refresh: () => run('cmd_updater_status'),
    download: () => run('cmd_updater_download'),
    install: async () => {
      if (snapshot.busy) throw new Error('请先结束正在进行的会话再安装更新。');
      if (snapshot.phase !== 'ready') throw new Error('请先下载并验证更新。');
      await run('cmd_updater_install');
    },
    shouldPrompt: () => {
      if (snapshot.busy || snapshot.phase !== 'available' || !snapshot.version) return false;
      const deferred = deps.read('updates.reminder') as { version?: string; until?: number } | undefined;
      return deferred?.version !== snapshot.version || !Number.isFinite(deferred.until) || Number(deferred.until) <= deps.now();
    },
    defer: () => deps.write('updates.reminder', { version: snapshot.version, until: deps.now() + 24 * 3600_000 }),
  };
}
