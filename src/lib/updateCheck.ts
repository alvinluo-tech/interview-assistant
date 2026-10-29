export interface AvailableUpdate { version: string; releaseUrl: string; downloadUrl?: string }
export const DEFAULT_UPDATE_REPOSITORY = 'alvinluo-tech/interview-assistant';
export interface UpdateSnapshot {
  phase: 'idle' | 'checking' | 'available' | 'upToDate' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'error';
  currentVersion?: string;
  version?: string;
  notes?: string;
  date?: string;
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
function version(value: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) throw new Error('版本号格式无效');
  const numbers = match.slice(1,4).map(Number);
  if (numbers.some(number => !Number.isSafeInteger(number))) throw new Error('版本号过大');
  return {numbers, pre:match[4]?.split('.')};
}
export function compareVersions(a: string, b: string): number {
  const left = version(a), right = version(b);
  for (let i=0;i<3;i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i]-right.numbers[i];
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i=0;i<Math.max(left.pre.length,right.pre.length);i++) {
    const l=left.pre[i], r=right.pre[i];
    if (l===r) continue;
    if (l===undefined || r===undefined) return l===undefined ? -1 : 1;
    const ln=/^\d+$/.test(l), rn=/^\d+$/.test(r);
    if (ln && rn) return Number(l)-Number(r);
    if (ln !== rn) return ln ? -1 : 1;
    return l<r ? -1 : 1;
  }
  return 0;
}
export async function checkForUpdate(repository: string, current: string, platform: string,
  fetcher: (url: string, options: RequestInit) => Promise<Pick<Response,'ok'|'status'|'json'>>) : Promise<AvailableUpdate | null> {
  if (!['windows-x64', 'macos-arm64', 'macos-x64'].includes(platform)) throw new Error('当前平台尚不支持客户端更新。');
  repository=repository.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository)) throw new Error('请输入 GitHub 仓库 owner/repo');
  const installed=version(current);
  const response=await fetcher(`https://api.github.com/repos/${repository}/releases?per_page=30`, {
    headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'mianxu-update-check'},signal:AbortSignal.timeout(15000),redirect:'error',
  });
  if (!response.ok) throw new Error(`检查更新失败（HTTP ${response.status}），请检查公开仓库名称、网络或 GitHub 限流。`);
  const releases=await response.json();
  if (!Array.isArray(releases) || !releases.length) throw new Error('该仓库尚无公开发布版本。');
  const valid=releases.filter(release=>{
    try { return !release.draft && (installed.pre || !release.prerelease && !version(release.tag_name).pre) && compareVersions(release.tag_name,current)>0; }
    catch { return false; }
  }).sort((a,b)=>compareVersions(b.tag_name,a.tag_name));
  if (!valid.length) return null;
  const selected=valid[0];
  const safeUrl=(value: unknown, prefix: string): string | undefined => {
    if (typeof value!=='string') return undefined;
    try { const url=new URL(value); return url.protocol==='https:' && url.hostname==='github.com' && !url.port && !url.username && !url.password
      && !url.search && !url.hash && url.pathname.toLowerCase().startsWith(`/${repository}/${prefix}/`.toLowerCase()) ? url.href : undefined; } catch { return undefined; }
  };
  const releaseUrl=safeUrl(selected.html_url,'releases/tag');
  if (!releaseUrl) throw new Error('发布页地址无效，已停止更新检查。');
  const suffix=platform==='windows-x64' ? '_x64-setup.exe' : platform==='macos-arm64' ? '_arm64.dmg' : '_x64.dmg';
  const asset=Array.isArray(selected.assets) ? selected.assets.find((asset: {name?: string})=>asset.name?.endsWith(suffix)) : undefined;
  return {version:selected.tag_name, releaseUrl, downloadUrl:safeUrl(asset?.browser_download_url,'releases/download')};
}
