/*
 * 本地账号菜单（替代原版云端登录）：显示本地身份、AI 接口入口、数据导出。
 */
import { Button, Dialog, DialogTitle, Input } from '@/ui/primitives';
import { setSetting, useSetting } from '@/lib/store';

export function LocalProfileDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [user, setUser] = useSetting('local.user', { name: '本地用户', email: '' });
  if (!open) return null;
  return (
    <Dialog open onClose={onClose} className="max-w-sm">
      <DialogTitle>本地身份</DialogTitle>
      <div className="mb-3 flex flex-col gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          显示名称
          <Input className="mt-1" value={user.name} onChange={(e) => setUser({ ...user, name: e.target.value })} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          邮箱（选填）
          <Input
            className="mt-1"
            placeholder="you@example.com"
            value={user.email}
            onChange={(e) => setUser({ ...user, email: e.target.value })}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          本复刻版不连接云端账号；所有数据保存在本机 store.json / data.json。
        </p>
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={() => void setSetting('local.user', user)}>
          保存
        </Button>
      </div>
    </Dialog>
  );
}
