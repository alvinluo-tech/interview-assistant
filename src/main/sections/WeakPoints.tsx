/*
 * 复盘后的「待确认薄弱点」：勾选后写入长期记忆。
 * 复用两处：历史记录里的复盘弹窗，以及模拟面试结束页。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, showToast } from '@/ui/primitives';
import { addMemory } from '@/lib/memory';
import { t } from '@/lib/i18n';

export function WeakPoints({
  points,
  accepted = [],
  onSaved,
  variant = 'light',
}: {
  points: string[];
  accepted?: string[];
  onSaved: (texts: string[]) => void | Promise<void>;
  variant?: 'light' | 'dark';
}) {
  const done = useMemo(() => new Set(accepted), [accepted]);
  const pending = points.filter((point) => !done.has(point));
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPicked(new Set(pending.map((_, index) => index)));
    // Re-check everything when a new list arrives; the user unticks what does not apply.
  }, [points]);

  if (pending.length === 0) return null;

  const toggle = (index: number) => {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const save = async () => {
    const texts = pending.filter((_, index) => picked.has(index));
    if (texts.length === 0) return;
    setSaving(true);
    try {
      await addMemory(texts);
      await onSaved(texts);
      showToast({ type: 'success', title: t('已加入长期记忆') });
    } catch (error) {
      showToast({ type: 'error', title: t('记忆未保存'), description: String((error as Error).message ?? error) });
    } finally {
      setSaving(false);
    }
  };

  const box = variant === 'dark' ? 'border-amber-500/30 bg-amber-500/10' : 'border-amber-500/30 bg-amber-500/5';
  const hint = variant === 'dark' ? 'text-neutral-400' : 'text-muted-foreground';

  return (
    <section className={`rounded-md border p-3 ${box}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium">{t('待确认的薄弱点')}</h3>
        <span className={`text-[11px] ${hint}`}>{t('勾选后加入长期记忆')}</span>
      </div>
      <p className={`mt-0.5 text-[11px] ${hint}`}>{t('这些是这场问答里暴露的短板，不是能力定论；之后回答会参考它们。')}</p>
      <ul className="mt-2 space-y-1">
        {pending.map((point, index) => (
          <li key={point}>
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] leading-snug">
              <input
                type="checkbox"
                className="mt-0.5 size-3.5 accent-current"
                checked={picked.has(index)}
                onChange={() => toggle(index)}
              />
              <span>{point}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex justify-end">
        <Button size="sm" disabled={picked.size === 0 || saving} onClick={() => void save()}>
          {saving ? t('保存中…') : t('加入长期记忆')}
        </Button>
      </div>
    </section>
  );
}
