import { useAiReady } from '@/lib/aiSettings';
/*
 * 面试题库（对齐原版 oW）：按岗位生成定制题目（本地 AI 版），
 * 题目卡可展开解析、收藏、存进面试资料。
 */
import { useState } from 'react';
import { BookOpen, Loader2, Sparkles, Star, StarOff, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  SectionHeader,
  Select,
  showToast,
} from '@/ui/primitives';
import { useData, writeData, saveEntry, saveMaterial, type Goal, type Material, type Resume } from '@/lib/backend';
import {generatePreparation} from '@/lib/preparation';
import { readData } from '@/lib/backend';
import { getSetting } from '@/lib/store';

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

const PROBABILITY_LABEL: Record<BankQuestion['probability'], { text: string; variant: 'destructive' | 'amber' | 'secondary' }> = {
  high: { text: '优先准备', variant: 'destructive' },
  medium: { text: '建议准备', variant: 'amber' },
  low: { text: '拓展准备', variant: 'secondary' },
};

const EXPERIENCE_OPTIONS = ['应届生', '1-3 年经验', '3-5 年经验', '5-10 年经验', '10 年以上'];

export function QuestionBankPage() {
  const goals = useData<Goal[]>('goals', [])[0];
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  const [goalId, setGoalId] = useState(goals[0]?.id ?? '');
  const [resumeId, setResumeId] = useState(resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '');
  const [experience, setExperience] = useState(EXPERIENCE_OPTIONS[0]);
  const banks = useData<SavedBank[]>('questionBanks', [])[0];
  const bankId = JSON.stringify([goalId,resumeId,experience]);
  const savedBank = banks.find(bank => bank.id === bankId);
  const questions = savedBank?.questions ?? [];
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const [openIdx, setOpenIdx] = useState<number | null>(null);
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
    setProgress('正在读取简历与岗位…');
    try {
      const goal = goals.find((g) => g.id === goalId);
      const resume = resumes.find((r) => r.id === resumeId);
      setProgress('AI 正在生成准备题…');
      const parsed=await generatePreparation({resume,goal,count:10,experience,
        materials:materials.filter(material=>getSetting<string[]>('interview.pendingMaterialIds',[]).includes(material.id))});
      await saveBank({questions:parsed});
      showToast({ type: 'success', title: `已生成 ${parsed.length} 道题` });
    } catch (e) {
      showToast({ type: 'error', title: `生成失败：${String((e as Error).message ?? e)}` });
    } finally {
      setGenerating(false);
      setProgress('');
    }
  };

  const saveToMaterial = async (q: BankQuestion) => {
    let target = materials[0];
    if (!target) {
      target = await saveMaterial({ name: '面试题库收藏', source: 'ai' });
      void readData;
    }
    await saveEntry(target.id, { question: q.question, answer: q.answer,origin:'model_generated' });
    showToast({ type: 'success', title: '已存进面试资料，面试时助手会用上这道题的答案' });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader
          title="按你的简历，准备好怎么答"
          desc="结合岗位与选定资料生成准备题、参考思路和可用经历，优先级用于安排练习。"
        />
        <div className="grid grid-cols-3 gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            这场面试
            <Select className="mt-1" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              {goals.length === 0 && <option value="">不限岗位</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            简历
            <Select className="mt-1" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              <option value="">不带简历</option>
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            经验
            <Select className="mt-1" value={experience} onChange={(e) => setExperience(e.target.value)}>
              {EXPERIENCE_OPTIONS.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          </label>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {aiReady ? '生成约 10 道题，需要几十秒。' : '需要先在「设置 → AI 服务」配置接口。'}
          </span>
          <Button size="sm" onClick={() => void generate()} disabled={generating || !aiReady}>
            {generating ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {generating ? '正在准备…' : '生成我的面试准备'}
          </Button>
        </div>
        {generating && progress && (
          <div className="mt-3 flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
            <Loader2 size={12} className="animate-spin" />
            {progress}
          </div>
        )}
      </Card>

      {questions.length > 0 && (
        <Card className="p-5">
          <SectionHeader title={`${questions.length} 题`} desc="点开一题看参考思路；可以收藏或存进面试资料。" />
          <div className="flex flex-col gap-2">
            {questions.map((q, i) => {
              const open = openIdx === i;
              const fav = favorites.has(q.question);
              return (
                <div key={i} className="rounded-md border">
                  <button
                    type="button"
                    className="flex w-full items-start gap-2 p-2.5 text-left"
                    onClick={() => setOpenIdx(open ? null : i)}
                  >
                    <span className="mt-0.5 text-xs text-muted-foreground">{i + 1}.</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{q.question}</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="secondary">{CATEGORY_LABEL[q.category] ?? q.category}</Badge>
                        <Badge variant={PROBABILITY_LABEL[q.probability]?.variant ?? 'secondary'}>
                          {PROBABILITY_LABEL[q.probability]?.text ?? q.probability}
                        </Badge>
                      </div>
                    </div>
                  </button>
                  {open && (
                    <div className="border-t bg-muted/30 p-2.5">
                      <div className="records-md whitespace-pre-wrap text-[13px]">{q.answer}</div>
                      <div className="mt-2 flex gap-1.5">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            const next = new Set(favorites);
                            if (fav) next.delete(q.question);
                            else next.add(q.question);
                            void saveBank({favorites:[...next]}).then(() => showToast({ type: 'success', title: fav ? '已取消收藏' : '已收藏' }))
                              .catch(error => showToast({type:'error',title:'收藏保存失败',description:String(error)}));
                          }}
                        >
                          {fav ? <StarOff size={12} /> : <Star size={12} />}
                          {fav ? '已收藏' : '收藏'}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => void saveToMaterial(q)}>
                          <Upload size={12} />
                          存进面试资料
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {questions.length === 0 && !generating && (
        <Card className="flex flex-col items-center gap-2 p-10 text-center">
          <BookOpen size={26} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            还没有生成题目。选好简历和岗位，点「生成我的面试准备」。
          </p>
        </Card>
      )}
    </div>
  );
}
