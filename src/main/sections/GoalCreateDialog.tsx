/*
 * 新建岗位：三个字段的小表单，放在弹窗里，避免把页面撑开或留下半截输入框。
 * 创建成功后由调用方决定是否顺手选中它。
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogDesc, DialogTitle, Input } from '@/ui/primitives';
import { saveGoal, type Goal } from '@/lib/backend';
import { t } from '@/lib/i18n';

export function GoalCreateDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (goal: Goal) => void;
}) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    setCompany('');
    setSaving(false);
    // Dialog 的焦点陷阱会先落在关闭按钮上，这里把光标放回第一个输入框。
    const timer = window.setTimeout(() => nameRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const goal = await saveGoal({ name: trimmed, companyName: company.trim() });
      onCreated(goal);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} width={480}>
      <DialogTitle>{t('新建岗位')}</DialogTitle>
      <DialogDesc>{t('只需要岗位名称；公司可以之后再补。')}</DialogDesc>
      <div className="mt-4 flex flex-col gap-3">
        <label className="text-[11px] text-ink-muted">
          {t('岗位名称')}
          <Input
            ref={nameRef}
            className="mt-1"
            value={name}
            maxLength={80}
            placeholder={t('例如 高级后端工程师')}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </label>
        <label className="text-[11px] text-ink-muted">
          {t('公司（选填）')}
          <Input className="mt-1" value={company} maxLength={80} onChange={(event) => setCompany(event.target.value)} />
        </label>
      </div>
      <div className="mt-5 flex justify-between">
        <Button variant="ghost" onClick={onClose}>{t('取消')}</Button>
        <Button disabled={!name.trim() || saving} onClick={() => void submit()}>{saving ? t('创建中…') : t('创建')}</Button>
      </div>
    </Dialog>
  );
}
