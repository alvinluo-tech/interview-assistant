/*
 * 复盘报告弹窗：历史记录与模拟面试共用。
 */
import { Dialog, DialogTitle, DialogDesc, Button } from '@/ui/primitives';
import { Md } from '@/overlay/Md';
import { updateSession, type InterviewSession } from '@/lib/backend';
import { mockMeta } from '@/lib/mock';
import { WeakPoints } from './WeakPoints';
import { t } from '@/lib/i18n';

export function MockReportDialog({
  session,
  onClose,
}: {
  session: InterviewSession | null;
  onClose: () => void;
}) {
  const meta = session ? mockMeta(session) : null;
  const accepted = meta?.weakPointsAccepted ?? [];
  return (
    <Dialog open={session != null} onClose={onClose} className="sm:max-w-2xl">
      <DialogTitle>{t('复盘报告')}</DialogTitle>
      <DialogDesc>
        {session?.title}
        {meta?.report ? '' : t(' · 报告还没有生成')}
      </DialogDesc>
      <div className="mt-3 max-h-[52vh] overflow-y-auto rounded-md border bg-muted/30 p-3 text-[13px] leading-relaxed">
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
      <div className="mt-3">
        <WeakPoints
          points={meta?.weakPoints ?? []}
          accepted={accepted}
          onSaved={(texts) =>
            updateSession(session!.id, {
              metadata: { ...(session!.metadata ?? {}), weakPointsAccepted: [...accepted, ...texts] },
            })
          }
        />
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" onClick={onClose}>
          {t('关闭')}
        </Button>
      </div>
    </Dialog>
  );
}
