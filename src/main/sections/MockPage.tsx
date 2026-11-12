import { useAiReady } from '@/lib/aiSettings';
/*
 * 模拟面试工作台：配置 → 建会话 → 开独立面试间窗口。
 * 会话与复盘全部落 data.json：支持「有一场还没结束」续场与历史回看。
 */
import { useState } from 'react';
import { Check, Clock, FileSearch, Play, Sparkles } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  SectionHeader,
  Select,
  SettingRow,
  Slider,
  Switch,
  showToast,
} from '@/ui/primitives';
import {
  createSession,
  completeSession,
  updateSession,
  useData,
  type Goal,
  type InterviewSession,
  type Resume,
  type Material,
} from '@/lib/backend';
import { useSetting } from '@/lib/store';
import { captureKnowledge } from '@/lib/knowledgeContext';
import { cmd } from '@/lib/bridge';
import { activeMockSession, mockMeta } from '@/lib/mock';
import { MockReportDialog } from './MockReportDialog';
import {SpeechProfilePanel} from './SpeechProfilePanel';
import {useSpeechProfile} from '@/lib/speechPreferences';
import { t } from '@/lib/i18n';

const DIFFICULTY = [
  { key: 'FRESH_GRADUATE', label: '应届生' },
  { key: '1_3_YEARS', label: '1-3 年' },
  { key: '3_5_YEARS', label: '3-5 年' },
  { key: '5_10_YEARS', label: '5-10 年' },
  { key: '10_YEARS', label: '10 年以上' },
];

const ROUNDS = [8, 12, 16, 20, 24];

async function openMockWindow(sessionId: string) {
  await cmd('cmd_open_mock', { sessionId });
}

export function MockPage({ onNavigate }: { onNavigate?: (section: string) => void }) {
  const [speechProfile,saveSpeechProfile]=useSpeechProfile('mock');
  const [sessions] = useData<InterviewSession[]>('interviewSessions', []);
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  const goals = useData<Goal[]>('goals', [])[0];
  // 这里的选项都要跨页面切换保留（组件在切页时会卸载），因此统一存进设置。
  const defaultResumeId = resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '';
  const [storedResumeId, setResumeId] = useSetting<string>('mock.pendingResumeId', '');
  const resumeId = resumes.some((r) => r.id === storedResumeId) ? storedResumeId : defaultResumeId;
  const [storedGoalId, setGoalId] = useSetting<string>('mock.pendingGoalId', '');
  const goalId = goals.some((g) => g.id === storedGoalId) ? storedGoalId : (goals[0]?.id ?? '');
  const [difficulty, setDifficulty] = useSetting<string>('mock.difficulty', DIFFICULTY[0].key);
  const [turnBudget, setTurnBudget] = useSetting<number>('mock.turnBudget', 12);
  const [basicsRatio, setBasicsRatio] = useSetting<number>('mock.basicsRatio', 50);
  const [assistMode, setAssistMode] = useSetting('mock.assistMode', false);
  const [starting, setStarting] = useState(false);
  const [materialIds, setMaterialIds] = useSetting<string[]>('mock.pendingMaterialIds', []);
  const [abandoning, setAbandoning] = useState<string | null>(null);
  const [reportViewingId, setReportViewingId] = useState<string | null>(null);
  const aiReady = useAiReady('chat');

  const pending = activeMockSession(sessions);
  const lastReported = sessions.find((s) => {
    const meta = mockMeta(s);
    return s.type === 'MOCK_INTERVIEW' && s.status === 'COMPLETED' && Boolean(meta?.report);
  });
  const reportViewing = sessions.find((s) => s.id === reportViewingId) ?? null;

  const blockReason = starting
    ? t('正在准备…')
    : pending
      ? t('先结束或放弃「{name}」这场', { name: mockMeta(pending)?.config.goalName ?? pending.title })
      : !resumeId
        ? t('先在「资料管理」上传一份简历')
        : !goalId
          ? t('先在「资料管理」新建一个岗位')
          : !aiReady
            ? t('先在「设置 → AI 服务」配置接口')
            : '';

  const start = async () => {
    if (!resumeId || !goalId) {
      showToast({ type: 'error', title: t('先选好简历和岗位') });
      return;
    }
    if (!aiReady) {
      showToast({ type: 'error', title: t('需要先在「设置 → AI 服务」配置接口') });
      return;
    }
    setStarting(true);
    try {
      const resume = resumes.find((r) => r.id === resumeId);
      const goal = goals.find((g) => g.id === goalId);
      const session = await createSession({
        type: 'MOCK_INTERVIEW',
        title: `模拟面试 · ${goal?.name ?? ''} ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
        goalId: goal?.id ?? null,
        resumeId: resume?.id ?? null,
        metadata: {
          mock: true,
          config: {
            speechProfile,
            goalName: goal?.name,
            company: goal?.companyName,
            resumeSummary: resume?.summary,
            knowledge: captureKnowledge({ resume, goal,
              materials: materials.filter(material => materialIds.includes(material.id)),
              query: goal?.description || goal?.name }),
            difficultyLabel: DIFFICULTY.find((d) => d.key === difficulty)?.label ?? '应届生',
            turnBudget,
            basicsRatio,
            assistMode,
          },
        },
      });
      await openMockWindow(session.id);
    } catch (e) {
      showToast({ type: 'error', title: t('创建模拟面试失败'), description: String((e as Error).message ?? e) });
    } finally {
      setStarting(false);
    }
  };

  const abandon = async (session: InterviewSession) => {
    const meta = mockMeta(session);
    await completeSession(session.id);
    await updateSession(session.id, {
      metadata: { ...(session.metadata ?? {}), ...(meta ? { ...meta, abandoned: true } : { mock: true, abandoned: true }) },
    });
    setAbandoning(null);
    showToast({ type: 'info', title: t('已放弃这场，不会生成复盘报告') });
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5"><SectionHeader title={t('语言与面试官声音')} desc={t('选择训练语言和口音。实际可用的声音取决于配置的模型与地域；没有云语音配置时使用已安装的系统语音。')}/><SpeechProfilePanel mock value={speechProfile} disabled={starting} onChange={value=>void saveSpeechProfile(value).catch(error=>showToast({type:'error',title:t('语言设置保存失败'),description:String(error)}))}/></Card>
      {pending && (
        <Card className="border-primary/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary/10">
                <Clock size={16} className="text-primary" />
              </span>
              <div>
                <div className="text-sm font-medium">{t('有一场还没结束')}</div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {t('{name} · 已答 {answered}/{total} 题 · 上次 {time}', {
                    name: mockMeta(pending)?.config.goalName ?? pending.title,
                    answered: pending.messages.filter((m) => m.role === 'ASSISTANT').length,
                    total: mockMeta(pending)?.config.turnBudget ?? 12,
                    time: new Date(pending.createdAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
                  })}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAbandoning(pending.id)}>
                {t('放弃这场')}
              </Button>
              <Button size="sm" onClick={() => void openMockWindow(pending.id)}>
                {t('继续面试')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {lastReported && !pending && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-muted">
                <FileSearch size={16} className="text-muted-foreground" />
              </span>
              <div>
                <div className="text-sm font-medium">{t('上一场面试')}</div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {t('{name} · 复盘报告已生成', { name: mockMeta(lastReported)?.config.goalName ?? lastReported.title })}
                </div>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setReportViewingId(lastReported.id)}>
              {t('查看复盘')}
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <SectionHeader
          title={t('开始一场模拟面试')}
          desc={t('AI 面试官按你的简历和岗位出题，会根据你的回答追问；结束后生成复盘报告。')}
          right={
            <Button onClick={() => void start()} disabled={starting || Boolean(pending)} title={blockReason || undefined}>
              <Play size={14} />
              {starting ? t('准备中…') : t('开始模拟面试')}
            </Button>
          }
        />
        {blockReason && <p className="mt-2 text-xs text-muted-foreground">{blockReason}</p>}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-muted-foreground">
            {t('简历')}
            <Select className="mt-1" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              {resumes.length === 0 && <option value="">{t('先去资料管理上传')}</option>}
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.isSample ? t(' · 不作为你的背景') : ''}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            {t('岗位')}
            <Select
              className="mt-1"
              value={goalId}
              title={goals.find((g) => g.id === goalId) ? (goals.find((g) => g.id === goalId)!.companyName ? `${goals.find((g) => g.id === goalId)!.companyName} · ${goals.find((g) => g.id === goalId)!.name}` : goals.find((g) => g.id === goalId)!.name) : undefined}
              onChange={(e) => setGoalId(e.target.value)}
            >
              {goals.length === 0 && <option value="">{t('先去资料管理新建')}</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('面试资料（已选 {count}/20 份）', { count: materialIds.length })}</span>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => onNavigate?.('resource')}>{t('管理资料')}</button>
          </div>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2">
            {materials.length === 0 && <span className="text-xs text-muted-foreground">{t('还没有面试资料，先在「资料管理」里上传或新建一份')}</span>}
            {materials.map((m) => {
              const on = materialIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMaterialIds(on ? materialIds.filter((x) => x !== m.id) : [...materialIds, m.id].slice(0, 20))}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${on ? 'border-primary/40 bg-selection text-selection-fg' : 'hover:bg-[var(--mx-action-secondary-hover)]'}`}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('难度')}</div>
            <div className="grid grid-cols-5 gap-1.5">
              {DIFFICULTY.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDifficulty(d.key)}
                  title={t(d.label)}
                  className={`flex items-center justify-center gap-1 truncate rounded-full border px-2 py-1 text-center text-xs transition-colors ${
                    difficulty === d.key ? 'border-primary/40 bg-selection text-selection-fg' : 'hover:bg-[var(--mx-action-secondary-hover)]'
                  }`}
                >
                  {difficulty === d.key && <Check size={11} className="shrink-0" />}
                  <span className="truncate">{t(d.label)}</span>
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">{t('题量（{n} 题）', { n: turnBudget })}</div>
            <div className="flex flex-wrap gap-1.5">
              {ROUNDS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setTurnBudget(r)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    turnBudget === r ? 'border-primary/40 bg-selection text-selection-fg' : 'hover:bg-[var(--mx-action-secondary-hover)]'
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('八股占比')}</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{basicsRatio}%</span>
          </div>
          <Slider min={0} max={100} step={10} value={basicsRatio} onChange={setBasicsRatio} />
          <div className="mt-0.5 text-[11px] text-muted-foreground">{t('100% = 只问八股，0% = 只问项目')}</div>
        </div>

        <div className="mt-3 border-t pt-1">
          <SettingRow title={t('AI 辅助提示')} desc={t('开启后，每个问题旁会给出提示要点（练手用，正式面试别开）。')}>
            <Switch ariaLabel={t('AI 辅助提示')} checked={assistMode} onCheckedChange={setAssistMode} />
          </SettingRow>
        </div>

        {!aiReady && (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            {t('还没有配置 AI 接口：到「设置 → AI 服务」填写后开始。')}
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-primary" />
          <span className="text-sm font-medium">{t('结束后会生成一份复盘报告')}</span>
          <Badge variant="secondary">{t('本地生成')}</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('报告包含整体表现、逐题点评与改进建议；生成后保存在这场记录里，可在「历史记录」回看。')}
        </p>
      </Card>

      <ConfirmDialog
        open={abandoning != null}
        title={t('放弃这场模拟面试？')}
        body={t('放弃后这场直接结束，不会再生成复盘报告，也无法继续作答。')}
        onCancel={() => setAbandoning(null)}
        onConfirm={() => {
          const target = sessions.find((s) => s.id === abandoning);
          if (target) void abandon(target);
        }}
      />
      <MockReportDialog session={reportViewing} onClose={() => setReportViewingId(null)} />
    </div>
  );
}
