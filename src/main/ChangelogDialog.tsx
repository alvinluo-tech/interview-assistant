/* 更新日志弹窗。 */
import { Button, Dialog, DialogTitle } from '@/ui/primitives';
import { setSetting } from '@/lib/store';
import { APP_VERSION } from '@/lib/env';
import { CHANGELOG } from '@/lib/changelog';
import { t } from '@/lib/i18n';

export function ChangelogDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={() => {
        void setSetting('changelog.seenDate', `${new Date().toISOString().slice(0, 10)}#${APP_VERSION}`);
        onClose();
      }}
      className="max-w-lg"
    >
      <DialogTitle>{t('已更新到新版本')}</DialogTitle>
      <div className="mb-4 flex flex-col gap-4">
        {CHANGELOG.map((e) => (
          <div key={e.date}>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">{e.date}</div>
            <div className="flex flex-col gap-1.5">
              {e.items.map((it, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span
                    className={`mt-0.5 shrink-0 rounded px-1 py-px text-[11px] font-medium ${
                      it.tag === 'new'
                        ? 'bg-primary/10 text-primary'
                        : it.tag === 'improved'
                          ? 'bg-sky-500/10 text-sky-600 dark:text-sky-400'
                          : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {it.tag === 'new' ? t('新功能') : it.tag === 'improved' ? t('体验优化') : t('问题修复')}
                  </span>
                  <span>{t(it.text)}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            void setSetting('changelog.snoozedDate', new Date().toISOString().slice(0, 10));
            onClose();
          }}
        >
          {t('今日不再提示')}
        </Button>
        <Button
          size="sm"
          onClick={() => {
            void setSetting('changelog.seenDate', `${new Date().toISOString().slice(0, 10)}#${APP_VERSION}`);
            onClose();
          }}
        >
          {t('知道了')}
        </Button>
      </div>
    </Dialog>
  );
}
