import { openUrl } from '@tauri-apps/plugin-opener';
import { ArrowUpRight } from 'lucide-react';
import { Button, Dialog, DialogDesc, DialogTitle } from '@/ui/primitives';
import { APP_VERSION } from '@/lib/env';
import { t } from '@/lib/i18n';

const GUIDE_URL = 'https://github.com/alvinluo-tech/interview-assistant#readme';

export function HelpDialog({ open, onClose, onFeedback }: { open: boolean; onClose: () => void; onFeedback: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-[440px]">
      <DialogTitle>{t('帮助与应用')}</DialogTitle>
      <DialogDesc>{t('全局快捷键在「设置 → 快捷键」里查看和修改；所有资料只保存在这台电脑上。')}</DialogDesc>
      <p className="mb-4 text-[12px] text-ink-muted">{t('版本 {version}', { version: APP_VERSION })}</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => void openUrl(GUIDE_URL).catch(() => {})}>
          {t('使用指南')}
          <ArrowUpRight size={13} />
        </Button>
        <Button onClick={onFeedback}>{t('问题反馈')}</Button>
      </div>
    </Dialog>
  );
}
