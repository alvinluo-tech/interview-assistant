import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button, Dialog, DialogDesc, DialogTitle, Select, Slider, Textarea } from '@/ui/primitives';
import { t } from '@/lib/i18n';
import { ANSWER_STYLES, type AnswerStyle } from '@/lib/ai';
import type { Material } from '@/lib/backend';
import { SPEECH_LANGUAGES, type SpeechProfile } from '@/lib/speechProfile';
import { SpeechProfilePanel } from './SpeechProfilePanel';

/** R3 要求：资料选择在独立模态里完成，草稿只在「保存」时写回。 */
export const MATERIAL_LIMIT = 20;

export function MaterialsDialog({
  open,
  onClose,
  materials,
  value,
  onSave,
  onManage,
}: {
  open: boolean;
  onClose: () => void;
  materials: Material[];
  value: string[];
  onSave: (ids: string[]) => void;
  onManage: () => void;
}) {
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]);
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setDraft(value.slice(0, MATERIAL_LIMIT));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开时复制草稿

  const needle = query.trim().toLowerCase();
  const shown = materials.filter((m) => !needle || m.name.toLowerCase().includes(needle));
  const full = draft.length >= MATERIAL_LIMIT;
  const toggle = (id: string) => {
    setDraft((next) => (next.includes(id) ? next.filter((x) => x !== id) : next.length >= MATERIAL_LIMIT ? next : [...next, id]));
  };

  return (
    <Dialog open={open} onClose={onClose} width={600}>
      <DialogTitle>{t('选择本场资料')}</DialogTitle>
      <DialogDesc>{t('只使用勾选的资料组织回答；选定后才会写回本场设置。')}</DialogDesc>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t('搜索资料')}
            placeholder={t('搜索资料')}
            className="h-9 w-full rounded-md border border-line-control bg-surface-raised pl-8 pr-3 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/35"
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-ink-muted" data-testid="materials-count">
          {t('已选 {count} 份', { count: draft.length })} / {MATERIAL_LIMIT}
        </span>
      </div>
      <div className="mt-3 max-h-[min(460px,55vh)] overflow-y-auto rounded-lg border border-line">
        {shown.length === 0 && (
          <div className="px-4 py-10 text-center text-xs text-ink-muted">
            {materials.length === 0 ? t('还没有面试资料') : t('没有找到匹配的资料')}
          </div>
        )}
        {shown.map((m) => {
          const on = draft.includes(m.id);
          return (
            <label
              key={m.id}
              className="flex min-h-[52px] cursor-pointer items-center gap-3 border-b border-line px-4 py-2 last:border-b-0 hover:bg-[var(--mx-action-secondary-hover)]"
            >
              <input
                type="checkbox"
                checked={on}
                disabled={!on && full}
                onChange={() => toggle(m.id)}
                aria-label={m.name}
                className="size-4 shrink-0 accent-[var(--mx-action-primary)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{m.name}</span>
                <span className="mt-0.5 block truncate text-[11px] text-ink-muted">
                  {t('{count} 条问答', { count: m.entries.length })} · {new Date(m.updatedAt).toLocaleDateString()}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {full && <p className="mt-2 text-[11px] text-ink-muted">{t('最多选 {count} 份；先取消一份，再继续添加。', { count: MATERIAL_LIMIT })}</p>}
      <div className="mt-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button type="button" className="-ml-2 inline-flex h-8 items-center rounded-md px-2 text-xs text-ink-muted hover:bg-[var(--mx-action-secondary-hover)] hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35 disabled:opacity-40" disabled={draft.length === 0} onClick={() => setDraft([])}>
            {t('清空')}
          </button>
          <button
            type="button"
            className="inline-flex h-8 items-center rounded-md px-2 text-xs text-primary hover:bg-[var(--mx-action-secondary-hover)] focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/35"
            onClick={() => {
              onClose();
              onManage();
            }}
          >
            {t('管理资料')}
          </button>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('取消')}
          </Button>
          <Button
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            {t('保存')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function LanguageDialog({
  open,
  onClose,
  value,
  onSave,
  disabled,
}: {
  open: boolean;
  onClose: () => void;
  value: SpeechProfile;
  onSave: (next: SpeechProfile) => void;
  disabled: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开时复制草稿

  return (
    <Dialog open={open} onClose={onClose} width={540} className="p-6">
      <DialogTitle>{t('语言与声音')}</DialogTitle>
      <DialogDesc>{t('识别语言、参考答案语言与辅助翻译分别生效。')}</DialogDesc>
      {disabled && <p className="mb-3 rounded-lg border border-line bg-surface-sunken px-3 py-2 text-[11px] text-ink-muted">{t('面试进行中不能修改语言设置，结束后再来。')}</p>}
      <div className="[&_.grid]:grid-cols-1 [&_.grid]:gap-4">
        <SpeechProfilePanel value={draft} onChange={setDraft} disabled={disabled} />
      </div>
      <div className="mt-5 flex justify-between">
        <Button variant="ghost" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button
          disabled={disabled}
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          {t('保存')}
        </Button>
      </div>
    </Dialog>
  );
}

export function PreferencesDialog({
  open,
  onClose,
  style,
  custom,
  silence,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  style: AnswerStyle;
  custom: string;
  silence: number;
  onSave: (next: { answerStyle: AnswerStyle; customAnswerStyle: string; silenceGateMs: number }) => void;
}) {
  const [draft, setDraft] = useState({ style, custom, silence });
  useEffect(() => {
    if (open) setDraft({ style, custom, silence });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开时复制草稿

  return (
    <Dialog open={open} onClose={onClose} width={600}>
      <DialogTitle>{t('回答偏好')}</DialogTitle>
      <DialogDesc>{t('这些偏好只影响本场面试的作答。')}</DialogDesc>
      <div className="space-y-5">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t('回答风格')}</span>
          <Select className="mt-2" aria-label={t('回答风格')} value={draft.style} onChange={(event) => setDraft({ ...draft, style: event.target.value as AnswerStyle })}>
            {ANSWER_STYLES.map((item) => (
              <option key={item.key} value={item.key}>
                {t(item.label)}
              </option>
            ))}
          </Select>
        </label>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('等面试官说完的时间')}</span>
            <span className="text-xs tabular-nums text-ink-muted" data-testid="silence-value">
              {draft.silence}ms
            </span>
          </div>
          <div className="mt-2">
            <Slider min={300} max={6000} step={100} value={draft.silence} onChange={(silenceGateMs) => setDraft({ ...draft, silence: silenceGateMs })} />
          </div>
          <div className="mt-2 flex gap-2">
            {[
              { label: t('灵敏'), value: 1000 },
              { label: t('适中'), value: 1600 },
              { label: t('稳妥'), value: 2200 },
            ].map((preset) => (
              <button
                key={preset.value}
                type="button"
                onClick={() => setDraft({ ...draft, silence: preset.value })}
                className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
                  draft.silence === preset.value ? 'border-primary bg-selection text-selection-fg' : 'border-line text-ink-muted hover:bg-[var(--mx-action-secondary-hover)]'
                }`}
              >
                {preset.label} {preset.value}
              </button>
            ))}
          </div>
        </div>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">{t('额外要求')}</span>
          <Textarea
            className="mt-2"
            rows={3}
            maxLength={2000}
            placeholder={t('例如：回答尽量控制在 1 分钟内，多提订单系统项目')}
            value={draft.custom}
            onChange={(event) => setDraft({ ...draft, custom: event.target.value })}
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {t('取消')}
        </Button>
        <Button
          onClick={() => {
            onSave({ answerStyle: draft.style, customAnswerStyle: draft.custom, silenceGateMs: draft.silence });
            onClose();
          }}
        >
          {t('保存')}
        </Button>
      </div>
    </Dialog>
  );
}

export function languageSummary(profile: SpeechProfile, langName: (id: string) => string): string {
  const translation = profile.translationLanguage;
  const answer = profile.answerLanguage === 'follow' ? t('跟随当前问题') : SPEECH_LANGUAGES.find((item) => item.id === profile.answerLanguage)?.name ?? profile.answerLanguage;
  return `${t('解答')} ${answer}${translation === 'none' ? '' : ` · ${t('辅助翻译')} ${langName(translation)}`}`;
}
