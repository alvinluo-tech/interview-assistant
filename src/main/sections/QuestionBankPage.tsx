import { useAiReady } from '@/lib/aiSettings';
/*
 * 面试题库：按岗位生成定制题目（本地 AI 版），
 * 题目卡可展开解析、收藏、存进面试资料。
 */
import { useState } from 'react';
import { BookOpen, Loader2, Sparkles, Star, StarOff, Upload } from 'lucide-react';
import {
  Button,
  Select,
  showToast,
} from '@/ui/primitives';
import { useData, writeData, saveEntry, saveMaterial, type Goal, type Material, type Resume } from '@/lib/backend';
import {generatePreparation} from '@/lib/preparation';
import { readData } from '@/lib/backend';
import { getSetting, useSetting } from '@/lib/store';
import { t } from '@/lib/i18n';

interface BankQuestion {
  category: string;
  probability: 'high' | 'medium' | 'low';
  question: string;
  answer: string;
}
interface SavedBank { id: string; questions: BankQuestion[]; favorites: string[]; createdAt: number }

const CATEGORY_LABEL: Record<string, string> = {
  resume_deep: '简历追问',
  job_skill: '岗位技能',
  company: '公司相关',
  behavior: '行为面',
  reverse: '反问面试官',
};

const EXPERIENCE_OPTIONS = ['应届生', '1-3 年经验', '3-5 年经验', '5-10 年经验', '10 年以上'];

export function QuestionBankPage({ onNavigate }: { onNavigate?: (section: 'interview') => void } = {}) {
  const goals = useData<Goal[]>('goals', [])[0];
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  // 选择要跨页面保留：bankId 由这三项组成，重置会让已生成的题库看起来消失。
  const [storedGoalId, setGoalId] = useSetting<string>('questionBank.pendingGoalId', '');
  const goalId = goals.some((g) => g.id === storedGoalId) ? storedGoalId : (goals[0]?.id ?? '');
  const goal = goals.find((g) => g.id === goalId);
  const [storedResumeId, setResumeId] = useSetting<string>('questionBank.pendingResumeId', '');
  const resumeId = resumes.some((r) => r.id === storedResumeId) ? storedResumeId : (resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '');
  const [experience, setExperience] = useSetting<string>('questionBank.experience', EXPERIENCE_OPTIONS[0]);
  const banks = useData<SavedBank[]>('questionBanks', [])[0];
  const bankId = JSON.stringify([goalId,resumeId,experience]);
  const savedBank = banks.find(bank => bank.id === bankId);
  const questions = savedBank?.questions ?? [];
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  // 用「序号 + 题干」定位展开项：重新生成题库后下标会指向别的题。
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [scopeOpen, setScopeOpen] = useState(false);
  // 「存进面试资料」的目标资料：默认第一份，可在页面顶部改，避免固定写进 materials[0]。
  const [targetMaterialId, setTargetMaterialId] = useState('');
  const favorites = new Set(savedBank?.favorites ?? []);
  async function saveBank(patch: Partial<SavedBank>) {
    const current = readData<SavedBank[]>('questionBanks', []);
    const previous = current.find(bank => bank.id === bankId);
    await writeData('questionBanks', [{id:bankId,questions:[],favorites:[],createdAt:Date.now(),...previous,...patch},...current.filter(bank=>bank.id!==bankId)]);
  }
  const aiReady = useAiReady('chat');

  const generate = async () => {
    if (generating) return;
    setGenerating(true);
    setProgress(t('正在读取简历与岗位…'));
    try {
      const goal = goals.find((g) => g.id === goalId);
      const resume = resumes.find((r) => r.id === resumeId);
      setProgress(t('AI 正在生成准备题…'));
      const parsed=await generatePreparation({resume,goal,count:10,experience,
        materials:materials.filter(material=>getSetting<string[]>('interview.pendingMaterialIds',[]).includes(material.id))});
      await saveBank({questions:parsed});
      showToast({ type: 'success', title: t('已生成 {count} 道题', { count: parsed.length }) });
    } catch (e) {
      showToast({ type: 'error', title: t('生成失败：{message}', { message: String((e as Error).message ?? e) }) });
    } finally {
      setGenerating(false);
      setProgress('');
    }
  };

  const saveToMaterial = async (q: BankQuestion) => {
    let target = materials.find((m) => m.id === targetMaterialId);
    if (!target) {
      target = await saveMaterial({ name: t('面试题库收藏'), source: 'ai' });
      setTargetMaterialId(target.id);
    }
    await saveEntry(target.id, { question: q.question, answer: q.answer,origin:'model_generated' });
    showToast({ type: 'success', title: t('已存进面试资料，面试时助手会用上这道题的答案') });
  };

  const selected = questions.find((q, i) => `${i}:${q.question}` === openKey) ?? questions[0];
  const selectedKey = selected ? `${questions.indexOf(selected)}:${selected.question}` : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-line bg-surface-raised px-3 py-1 text-[12px]">
            {goal ? (goal.companyName ? `${goal.companyName} · ${goal.name}` : goal.name) : t('不限岗位')}
          </span>
          <span className="rounded-full border border-line bg-surface-raised px-3 py-1 text-[12px]">
            {resumes.find((r) => r.id === resumeId)?.title ?? t('不带简历')}
          </span>
          <button
            type="button"
            onClick={() => setScopeOpen((v) => !v)}
            aria-expanded={scopeOpen}
            className="rounded-full px-2 py-1 text-[12px] text-primary hover:underline"
          >
            {t('调整范围')}
          </button>
        </div>
        <Button size="sm" onClick={() => void generate()} disabled={generating || !aiReady} title={aiReady ? undefined : t('需要先在「设置 → AI 服务」配置接口。')}>
          {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
          {generating ? t('正在准备…') : t('生成准备题')}
        </Button>
      </div>

      {scopeOpen && (
        <div className="grid grid-cols-4 gap-3 rounded-xl border border-line bg-surface-raised p-4">
          <label className="text-[11px] text-ink-muted">
            {t('这场面试')}
            <Select className="mt-1 h-9 text-[13px]" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              {goals.length === 0 && <option value="">{t('不限岗位')}</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>{g.companyName ? `${g.companyName} · ${g.name}` : g.name}</option>
              ))}
            </Select>
          </label>
          <label className="text-[11px] text-ink-muted">
            {t('简历')}
            <Select className="mt-1 h-9 text-[13px]" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              <option value="">{t('不带简历')}</option>
              {resumes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
            </Select>
          </label>
          <label className="text-[11px] text-ink-muted">
            {t('经验')}
            <Select className="mt-1 h-9 text-[13px]" value={experience} onChange={(e) => setExperience(e.target.value)}>
              {EXPERIENCE_OPTIONS.map((x) => <option key={x} value={x}>{t(x)}</option>)}
            </Select>
          </label>
          <label className="text-[11px] text-ink-muted">
            {t('存进面试资料')}
            <Select className="mt-1 h-9 text-[13px]" value={targetMaterialId} onChange={(e) => setTargetMaterialId(e.target.value)}>
              <option value="">{t('面试题库收藏')}</option>
              {materials.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </label>
        </div>
      )}

      {generating && progress && (
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-muted">
          <Loader2 size={12} className="animate-spin" />
          {progress}
        </div>
      )}

      {questions.length === 0 && !generating && (
        <div className="mx-auto mt-6 flex w-full max-w-[460px] flex-col items-center gap-4 rounded-xl border border-line bg-surface-raised px-6 py-10 text-center shadow-card">
          <span className="flex size-11 items-center justify-center rounded-xl bg-selection text-primary">
            <BookOpen size={20} />
          </span>
          <div>
            <p className="text-[15px] font-medium leading-6">{t('还没有准备题')}</p>
            <p className="mt-1.5 text-[12px] leading-[19px] text-ink-muted">{t('选好岗位和简历，生成一组可以提前练的问题。')}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void generate()} disabled={!aiReady} title={aiReady ? undefined : t('需要先在「设置 → AI 服务」配置接口。')}>
              <Sparkles size={13} />
              {t('生成准备题')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setScopeOpen(true)}>{t('调整范围')}</Button>
          </div>
        </div>
      )}

      {questions.length > 0 && (
        <div className="grid grid-cols-[248px_minmax(0,1fr)] items-start gap-6">
          <div className="flex flex-col gap-1.5">
            {questions.map((q, i) => {
              const itemKey = `${i}:${q.question}`;
              const active = itemKey === selectedKey;
              return (
                <button
                  key={itemKey}
                  type="button"
                  onClick={() => setOpenKey(itemKey)}
                  className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    active ? 'border-line bg-surface-raised shadow-card' : 'border-transparent hover:bg-[var(--mx-action-secondary-hover)]'
                  }`}
                >
                  <div className="line-clamp-2 text-[13px] font-medium leading-[20px]">{q.question}</div>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">
                    {t(CATEGORY_LABEL[q.category] ?? q.category)}
                    {favorites.has(q.question) && <Star size={11} className="text-primary" />}
                  </div>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="rounded-xl border border-line bg-surface-raised p-6 shadow-card">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-medium tracking-[0.08em] text-primary">{t(CATEGORY_LABEL[selected.category] ?? selected.category)}</div>
                  <h3 className="mt-2 text-[18px] font-semibold leading-[26px]">{selected.question}</h3>
                </div>
                <button
                  type="button"
                  aria-label={favorites.has(selected.question) ? t('取消收藏') : t('收藏')}
                  onClick={() => {
                    const next = new Set(favorites);
                    const fav = favorites.has(selected.question);
                    if (fav) next.delete(selected.question);
                    else next.add(selected.question);
                    void saveBank({favorites:[...next]}).then(() => showToast({ type: 'success', title: fav ? t('已取消收藏') : t('已收藏') }))
                      .catch(error => showToast({type:'error',title:t('收藏保存失败'),description:String(error)}));
                  }}
                  className={`flex size-8 items-center justify-center rounded-md border border-line ${favorites.has(selected.question) ? 'text-primary' : 'text-ink-muted hover:bg-[var(--mx-action-secondary-hover)]'}`}
                >
                  {favorites.has(selected.question) ? <StarOff size={14} /> : <Star size={14} />}
                </button>
              </div>
              <div className="mt-4 whitespace-pre-wrap text-[13px] leading-[22px] text-ink">{selected.answer}</div>
              <div className="mt-5 flex gap-2 border-t border-line pt-4">
                <Button size="sm" variant="outline" onClick={() => void saveToMaterial(selected)}>
                  <Upload size={12} />
                  {t('存进面试资料')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => onNavigate?.('interview')}>
                  {t('结合项目练习')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
