import type { UpdateSnapshot } from './updateCheck';

export type NoteBlock = { kind: 'heading' | 'paragraph' | 'bullet' | 'code'; text: string };
const readable = (value: string) => value.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim();

/** A deliberately small text-only release-note format. Remote HTML is never interpreted. */
export function releaseNotes(value: string) {
  const blocks: NoteBlock[] = [];
  let code: string[] | null = null;
  for (const line of value.slice(0, 32_000).split(/\r?\n/).slice(0, 400)) {
    if (/^\s*```/.test(line)) {
      if (code) { blocks.push({ kind: 'code', text: code.join('\n') }); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim() || /^#\s/.test(line)) continue;
    const heading = /^#{2,6}\s+(.+)/.exec(line);
    const bullet = /^\s*(?:[-*+] |\d+[.)] )(.+)/.exec(line);
    const kind = heading ? 'heading' : bullet ? 'bullet' : 'paragraph';
    const text = readable(heading?.[1] || bullet?.[1] || line);
    if (kind === 'paragraph' && blocks[blocks.length - 1]?.kind === 'paragraph') blocks[blocks.length - 1].text += ` ${text}`;
    else blocks.push({ kind, text });
  }
  if (code) blocks.push({ kind: 'code', text: code.join('\n') });
  const summary = blocks[0]?.kind === 'paragraph' ? blocks.shift()!.text : '';
  const highlights = blocks.filter(block => block.kind === 'bullet').slice(0, 3).map(block => block.text);
  return { summary, highlights, blocks };
}

export function formatBytes(value?: number) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

export function downloadProgress(state: Pick<UpdateSnapshot, 'phase' | 'downloaded' | 'total'>) {
  const downloaded = Number.isFinite(state.downloaded) ? Math.max(0, state.downloaded) : 0;
  const total = state.total && Number.isFinite(state.total) && state.total > 0 ? state.total : undefined;
  return { downloaded, total, percent: state.phase === 'ready' ? 100 : total ? Math.min(100, Math.round(downloaded / total * 100)) : null };
}

export function releaseDate(value?: string | null) {
  if (!value) return null;
  const normalized = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}:[\d.]+) ([+-]\d{2}:\d{2}):00$/, (_, day, hour, rest, offset) => `${day}T${hour.padStart(2, '0')}:${rest}${offset}`);
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date) : null;
}

export function updateFailure(error?: string | null) {
  const detail = error || '';
  if (/签名|验证|signature|signed.version/i.test(detail)) return { title: '更新文件未通过验证', description: '请重新下载更新。验证通过后才会允许安装。', detail };
  if (/网络|连接|timeout|connection|HTTP|network|请求/i.test(detail)) return { title: '暂时无法连接更新服务', description: '请检查网络连接后重试，也可以前往发布页手动下载。', detail };
  return { title: '本次更新未完成', description: '可以稍后重试，或前往发布页下载最新版本。', detail };
}

export function updatePresentation(state: UpdateSnapshot) {
  const views = {
    idle: ['让应用保持最新', '检查是否有新的功能和体验改进。'],
    checking: ['正在检查更新', '正在获取最新版本信息，请稍候。'],
    available: ['发现新版本', '看看这次更新带来了哪些变化。'],
    upToDate: ['已经是最新版本', '当前版本已是最新，安心继续使用。'],
    downloading: ['正在下载更新', '下载期间可以返回工作台，完成后由你决定安装时间。'],
    verifying: ['正在验证更新文件', '下载已完成，正在检查文件的完整性与来源。'],
    ready: ['更新已准备就绪', '安装将重启应用，请先保存正在编辑的内容。'],
    installing: ['正在安装更新', '应用即将退出并更新，请等待安装完成。'],
    error: [updateFailure(state.error).title, updateFailure(state.error).description],
  };
  let action: 'check' | 'download' | 'install' | 'release' | 'restore' | null;
  if (['checking', 'downloading', 'verifying', 'installing'].includes(state.phase)) action = null;
  else if (state.canRestoreOriginal) action = 'restore';
  else if (!state.canInstall && (state.version || ['available', 'ready'].includes(state.phase))) action = 'release';
  else if (state.phase === 'ready') action = 'install';
  else if (state.phase === 'available' || state.phase === 'error' && state.version) action = 'download';
  else action = 'check';
  const labels = { check: '检查更新', download: state.phase === 'error' ? '重新下载' : '下载更新', install: '重启并安装', release: '下载官方安装包', restore: '恢复原程序后更新' };
  return { title: views[state.phase][0], description: views[state.phase][1], action, actionLabel: action ? labels[action] : '', disabled: state.busy && (action === 'install' || action === 'restore') };
}
