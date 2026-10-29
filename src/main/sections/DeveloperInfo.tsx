import { ArrowUpRight, Code2 } from 'lucide-react';
import { showToast } from '@/ui/primitives';

export function DeveloperInfo() {
  const open = (url: string) => void import('@tauri-apps/plugin-opener').then(({openUrl}) => openUrl(url))
    .catch(reason => showToast({type:'error', title:'链接暂时无法打开', description:String(reason)}));
  return <div className="mt-6 flex flex-wrap items-center gap-4 border-t pt-5">
    <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border bg-muted/40 font-mono text-sm tracking-tight text-muted-foreground" aria-hidden>AL</div>
    <div className="min-w-0 flex-1"><p className="text-[10px] tracking-[.16em] text-muted-foreground">DEVELOPED BY</p><p className="mt-1 text-sm font-semibold tracking-tight">Alvin Luo</p><p className="mt-0.5 text-xs text-muted-foreground">专注本地优先的 AI 工具与数字体验。</p></div>
    <div className="flex items-center gap-4 text-xs text-muted-foreground">
      <button className="inline-flex items-center gap-1.5 hover:text-foreground" onClick={() => open('https://alvin-luo.me')}>个人网站<ArrowUpRight size={13} /></button>
      <button className="inline-flex items-center gap-1.5 hover:text-foreground" onClick={() => open('https://github.com/alvinluo-tech')}><Code2 size={13} />GitHub<ArrowUpRight size={13} /></button>
    </div>
  </div>;
}
