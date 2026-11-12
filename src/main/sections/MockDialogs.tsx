/*
 * 模拟面试：高级训练偏好独立成弹窗，和资料、语言保持同一层级的交互。
 */
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Dialog, DialogDesc, DialogTitle, Slider, Switch } from '@/ui/primitives';
import { t } from '@/lib/i18n';
import { SettingLine } from './SettingLine';

export function MockAdvancedDialog({
  open,
  onClose,
  basicsRatio,
  assistMode,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  basicsRatio: number;
  assistMode: boolean;
  onSave: (next: { basicsRatio: number; assistMode: boolean }) => void;
}) {
  const [draft, setDraft] = useState({ basicsRatio, assistMode });
  useEffect(() => {
    if (open) setDraft({ basicsRatio, assistMode });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开时复制草稿

  return (
    <Dialog open={open} onClose={onClose} width={600}>
      <DialogTitle>{t('高级训练偏好')}</DialogTitle>
      <DialogDesc>{t('这些偏好只影响这一场模拟面试，点保存后生效。')}</DialogDesc>
      <div className="mt-4 rounded-lg border border-line">
        <SettingLine icon={Sparkles} title={t('八股占比')} desc={t('100% = 只问八股，0% = 只问项目')} align="center">
          <div className="flex items-center gap-3">
            <Slider className="w-44" min={0} max={100} step={10} value={draft.basicsRatio} onChange={(next) => setDraft((current) => ({ ...current, basicsRatio: next }))} />
            <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-ink-muted">{draft.basicsRatio}%</span>
          </div>
        </SettingLine>
        <SettingLine icon={Sparkles} title={t('AI 辅助提示')} desc={t('开启后，每个问题旁会给出提示要点（练手用，正式面试别开）。')} align="center">
          <Switch ariaLabel={t('AI 辅助提示')} checked={draft.assistMode} onCheckedChange={(next) => setDraft((current) => ({ ...current, assistMode: next }))} />
        </SettingLine>
      </div>
      <p className="mt-3 text-[11px] leading-[18px] text-ink-muted">{t('报告包含整体表现、逐题点评与改进建议；生成后保存在这场记录里，可在「历史记录」回看。')}</p>
      <div className="mt-5 flex justify-between">
        <Button variant="ghost" onClick={onClose}>{t('取消')}</Button>
        <Button onClick={() => { onSave(draft); onClose(); }}>{t('保存')}</Button>
      </div>
    </Dialog>
  );
}
