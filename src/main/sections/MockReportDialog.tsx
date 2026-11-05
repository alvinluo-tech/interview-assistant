/*
 * 复盘报告弹窗：Records 与 MockPage 共用（对齐原版「复盘报告」查看入口）。
 */
import { Dialog, DialogTitle, DialogDesc, Button } from '@/ui/primitives';
import { Md } from '@/overlay/Md';
import type { InterviewSession } from '@/lib/backend';
import { mockMeta } from '@/lib/mock';
import { t } from '@/lib/i18n';

export function MockReportDialog({
  session,
  onClose,
}: {
  session: InterviewSession | null;
  onClose: () => void;
}) {
  const meta = session ? mockMeta(session) : null;
  return (
    <Dialog open={session != null} onClose={onClose} className="sm:max-w-2xl">
      <DialogTitle>{t('复盘报告')}</DialogTitle>
      <DialogDesc>
        {session?.title}
        {meta?.report ? '' : t(' · 报告还没有生成')}
      </DialogDesc>
      <div className="mt-3 max-h-[60vh] overflow-y-auto rounded-md border bg-muted/30 p-3 text-[13px] leading-relaxed">
        {meta?.report ? (
          <Md text={meta.report} />
        ) : (
          <p className="text-muted-foreground">
            {meta?.reportStatus === 'error'
              ? t('上次生成失败：{msg}。可在记录里重新生成。', { msg: t(meta.reportError ?? '未知错误') })
              : t('这场还没有复盘报告。')}
          </p>
        )}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose}>
          {t('关闭')}
        </Button>
      </div>
    </Dialog>
  );
}
