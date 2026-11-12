/*
 * 笔试助手：把「答题与显示偏好」从页内展开改成独立弹窗，
 * 与面试页的资料 / 语言 / 回答偏好保持一致：进去改、点保存才生效。
 */
import { useEffect, useState } from 'react';
import { Copy, Keyboard, MonitorSmartphone } from 'lucide-react';
import { Button, Dialog, DialogDesc, DialogTitle, Select, Switch, Textarea } from '@/ui/primitives';
import { t } from '@/lib/i18n';
import { SettingLine } from './SettingLine';

export interface ExamPreferenceDraft {
  customization: Record<string, unknown>;
  showCopyCode: boolean;
  showHints: boolean;
  compatibility: boolean;
}

const LANGUAGES = ['auto', 'Python 3', 'Java', 'C++', 'C', 'Go', 'JavaScript', 'TypeScript', 'C#', 'Rust', 'SQL'];
const CODE_MODES = [
  { value: 'auto', label: t('跟随题目') },
  { value: 'acm', label: t('ACM 模式（完整程序）') },
  { value: 'core', label: t('核心代码模式（只写函数）') },
];
const QUALITIES = [
  { value: 'standard', label: t('标准可提交') },
  { value: 'readable', label: t('清晰易读') },
  { value: 'concise', label: t('简洁直接') },
  { value: 'performance', label: t('优先性能') },
];
const ANSWER_LANGUAGES = [
  { value: 'auto', label: t('跟随界面语言') },
  { value: 'zh-CN', label: t('zh-CN') },
  { value: 'en-US', label: t('en-US') },
  { value: 'ja-JP', label: t('ja-JP') },
  { value: 'ko-KR', label: t('ko-KR') },
];

export function ExamPreferencesDialog({
  open,
  onClose,
  value,
  onSave,
  windows,
}: {
  open: boolean;
  onClose: () => void;
  value: ExamPreferenceDraft;
  onSave: (next: ExamPreferenceDraft) => void;
  windows: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (open) setDraft(value);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- 只在打开时复制草稿

  const field = (key: string, fallback: string) => String(draft.customization[key] ?? fallback);
  const patch = (key: string, next: string) =>
    setDraft((current) => ({ ...current, customization: { ...current.customization, [key]: next } }));

  return (
    <Dialog open={open} onClose={onClose} width={600}>
      <DialogTitle>{t('答题与显示偏好')}</DialogTitle>
      <DialogDesc>{t('这些偏好只影响这一场笔试，点保存后生效。')}</DialogDesc>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="text-[11px] text-ink-muted">
          {t('编程题语言')}
          <Select className="mt-1 h-10 border-line text-[13px]" value={field('programmingLanguage', 'auto')} onChange={(event) => patch('programmingLanguage', event.target.value)}>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>{language === 'auto' ? t('跟随题目') : language}</option>
            ))}
          </Select>
        </label>
        <label className="text-[11px] text-ink-muted">
          {t('代码模式')}
          <Select className="mt-1 h-10 border-line text-[13px]" value={field('codeMode', 'auto')} onChange={(event) => patch('codeMode', event.target.value)}>
            {CODE_MODES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
          </Select>
        </label>
        <label className="text-[11px] text-ink-muted">
          {t('编程题取向')}
          <Select className="mt-1 h-10 border-line text-[13px]" value={field('codeQuality', 'standard')} onChange={(event) => patch('codeQuality', event.target.value)}>
            {QUALITIES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
          </Select>
        </label>
        <label className="text-[11px] text-ink-muted">
          {t('回答语言')}
          <Select className="mt-1 h-10 border-line text-[13px]" value={field('answerLanguage', 'auto')} onChange={(event) => patch('answerLanguage', event.target.value)}>
            {ANSWER_LANGUAGES.map((item) => (<option key={item.value} value={item.value}>{item.label}</option>))}
          </Select>
        </label>
      </div>
      <Textarea
        className="mt-3"
        rows={3}
        maxLength={2000}
        placeholder={t('补充要求：希望答案更短 / 多给步骤 / 按考试格式输出…')}
        value={field('customRequirements', '')}
        onChange={(event) => patch('customRequirements', event.target.value)}
      />
      <div className="mt-4 divide-y divide-line rounded-lg border border-line">
        <SettingLine icon={Copy} title={t('显示复制按钮')} desc={t('答案里有代码就复制代码，没有就复制文字。')} align="center">
          <Switch ariaLabel={t('显示复制按钮')} checked={draft.showCopyCode} onCheckedChange={(next) => setDraft((current) => ({ ...current, showCopyCode: next }))} />
        </SettingLine>
        <SettingLine icon={Keyboard} title={t('快捷键提示')} desc={t('在浮窗按钮上显示对应键位。')} align="center">
          <Switch ariaLabel={t('快捷键提示')} checked={draft.showHints} onCheckedChange={(next) => setDraft((current) => ({ ...current, showHints: next }))} />
        </SettingLine>
        <SettingLine icon={MonitorSmartphone} title={t('截图兼容模式（Windows）')} desc={t('优先读取前台窗口，失败后回退屏幕截图。')} align="center">
          <Switch
            ariaLabel={t('截图兼容模式（Windows）')}
            checked={windows && draft.compatibility}
            disabled={!windows}
            onCheckedChange={(next) => setDraft((current) => ({ ...current, compatibility: next }))}
          />
        </SettingLine>
      </div>
      <div className="mt-5 flex justify-between">
        <Button variant="ghost" onClick={onClose}>{t('取消')}</Button>
        <Button onClick={() => { onSave(draft); onClose(); }}>{t('保存')}</Button>
      </div>
    </Dialog>
  );
}
