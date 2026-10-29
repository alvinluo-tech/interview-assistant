import { useEffect, useState } from 'react';
import { FolderOpen, HardDrive } from 'lucide-react';
import { Button, Card, SectionHeader, showToast } from '@/ui/primitives';
import { cmd } from '@/lib/bridge';

type Layout = Record<'data' | 'attachments' | 'backups' | 'cache' | 'logs' | 'settings', string>;
const folders = [
  ['data', '记录与资料', '面试、笔试、简历和资料的记录索引。'],
  ['attachments', '原题截图', '独立压缩保存，查看旧记录时按需读取。'],
  ['backups', '记录备份', '上一份记录和你创建的手动备份。'],
  ['cache', '临时缓存', '可重新生成的临时内容。'],
  ['logs', '运行日志', '排查应用问题时使用。'],
] as const;
export function StorageSettings() {
  const [layout, setLayout] = useState<Layout | null>(null), [error, setError] = useState('');
  useEffect(() => {let disposed = false; void cmd<Layout>('cmd_storage_layout').then(value => {if (!disposed) setLayout(value);}).catch(reason => {if (!disposed) setError(String(reason));}); return () => {disposed = true;};}, []);
  const open = (kind: string) => void cmd('cmd_storage_open', {kind}).catch(reason => showToast({type:'error', title:'无法打开文件夹', description:String(reason)}));
  return <Card className="p-5"><SectionHeader title="本机存储" desc="记录、截图和缓存各归其位。应用更新不会清除你的资料。" right={<HardDrive size={17} className="text-muted-foreground" />} />
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="divide-y">{folders.map(([key, title, description]) => <div key={key} className="flex items-center gap-4 py-4">
      <div className="min-w-0 flex-1"><h3 className="text-sm font-medium">{title}</h3><p className="mt-1 text-xs text-muted-foreground">{description}</p>
        <p className="mt-2 truncate font-mono text-[10px] text-muted-foreground" title={layout?.[key]}>{layout?.[key] || '读取目录中…'}</p></div>
      <Button size="sm" variant="outline" disabled={!layout} onClick={() => open(key)}><FolderOpen size={13} />打开文件夹</Button>
    </div>)}</div>
    <div className="mt-3 space-y-2 rounded-md bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
      <p>旧版记录会自动迁入本机资料目录，原文件保留。设置与受保护的密钥沿用原位置。</p>
      <p>迁移到另一台电脑时，请一并备份“记录与资料”和“原题截图”。手动备份只包含记录索引。删除记录后，截图暂时保留，以便恢复旧备份。</p>
    </div>
  </Card>;
}
