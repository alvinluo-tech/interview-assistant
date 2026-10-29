import { useAiReady } from '@/lib/aiSettings';
/*
 * 模拟面试工作台（对齐原版 zU）：配置 → 建会话 → 开独立面试间窗口。
 * 会话与复盘全部落 data.json：支持「有一场还没结束」续场与历史回看。
 */
import { useState } from 'react';
import { Clock, FileSearch, Play, Sparkles } from 'lucide-react';
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
import { getSetting, useSetting } from '@/lib/store';
import { buildKnowledgeContext } from '@/lib/knowledgeContext';
import { cmd } from '@/lib/bridge';
import { activeMockSession, mockMeta } from '@/lib/mock';
import { MockReportDialog } from './MockReportDialog';

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

export function MockPage() {
  const [sessions] = useData<InterviewSession[]>('interviewSessions', []);
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  const goals = useData<Goal[]>('goals', [])[0];
  const [resumeId, setResumeId] = useState(resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '');
  const [goalId, setGoalId] = useState(goals[0]?.id ?? '');
  const [difficulty, setDifficulty] = useState(DIFFICULTY[0].key);
  const [turnBudget, setTurnBudget] = useState(12);
  const [basicsRatio, setBasicsRatio] = useState(50);
  const [assistMode, setAssistMode] = useSetting('mock.assistMode', false);
  const [starting, setStarting] = useState(false);
  const [abandoning, setAbandoning] = useState<string | null>(null);
  const [reportViewingId, setReportViewingId] = useState<string | null>(null);
  const aiReady = useAiReady('chat');

  const pending = activeMockSession(sessions);
  const lastReported = sessions.find((s) => {
    const meta = mockMeta(s);
    return s.type === 'MOCK_INTERVIEW' && s.status === 'COMPLETED' && Boolean(meta?.report);
  });
  const reportViewing = sessions.find((s) => s.id === reportViewingId) ?? null;

  const start = async () => {
    if (!resumeId || !goalId) {
      showToast({ type: 'error', title: '先选好简历和岗位' });
      return;
    }
    if (!aiReady) {
      showToast({ type: 'error', title: '需要先在「设置 → AI 服务」配置接口' });
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
            goalName: goal?.name,
            company: goal?.companyName,
            resumeSummary: resume?.summary,
            knowledgeContext: buildKnowledgeContext({ resume, goal,
              materials: materials.filter(material => getSetting<string[]>('interview.pendingMaterialIds', []).includes(material.id)),
              query: goal?.description || goal?.name }).text,
            difficultyLabel: DIFFICULTY.find((d) => d.key === difficulty)?.label ?? '应届生',
            turnBudget,
            basicsRatio,
            assistMode,
          },
        },
      });
      await openMockWindow(session.id);
    } catch (e) {
      showToast({ type: 'error', title: '创建模拟面试失败', description: String((e as Error).message ?? e) });
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
    showToast({ type: 'info', title: '已放弃这场，不会生成复盘报告' });
  };

  return (
    <div className="flex flex-col gap-4">
      {pending && (
        <Card className="border-primary/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-9 items-center justify-center rounded-full bg-primary/10">
                <Clock size={16} className="text-primary" />
              </span>
              <div>
                <div className="text-sm font-medium">有一场还没结束</div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {mockMeta(pending)?.config.goalName ?? pending.title} · 开始于{' '}
                  {new Date(pending.createdAt).toLocaleString('zh-CN')}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAbandoning(pending.id)}>
                放弃这场
              </Button>
              <Button size="sm" onClick={() => void openMockWindow(pending.id)}>
                继续面试
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
                <div className="text-sm font-medium">上一场面试</div>
                <div className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
                  {mockMeta(lastReported)?.config.goalName ?? lastReported.title} · 复盘报告已生成
                </div>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setReportViewingId(lastReported.id)}>
              查看复盘
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-5">
        <SectionHeader
          title="开始一场模拟面试"
          desc="AI 面试官按你的简历和岗位出题，会根据你的回答追问；结束后生成复盘报告。"
          right={
            <Button onClick={() => void start()} disabled={starting || Boolean(pending)}>
              <Play size={14} />
              {starting ? '准备中…' : '开始模拟面试'}
            </Button>
          }
        />

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-muted-foreground">
            简历
            <Select className="mt-1" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              {resumes.length === 0 && <option value="">先去资料管理上传</option>}
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.isSample ? ' · 不作为你的背景' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            岗位
            <Select className="mt-1" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              {goals.length === 0 && <option value="">先去资料管理新建</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-4">
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">难度</div>
            <div className="flex flex-wrap gap-1.5">
              {DIFFICULTY.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => setDifficulty(d.key)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    difficulty === d.key ? 'border-primary/50 bg-primary/10 text-primary' : 'hover:bg-accent'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-muted-foreground">题量（{turnBudget} 题）</div>
            <div className="flex flex-wrap gap-1.5">
              {ROUNDS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setTurnBudget(r)}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                    turnBudget === r ? 'border-primary/50 bg-primary/10 text-primary' : 'hover:bg-accent'
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
            <span className="text-xs font-medium text-muted-foreground">八股占比</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{basicsRatio}%</span>
          </div>
          <Slider min={0} max={100} step={10} value={basicsRatio} onChange={setBasicsRatio} />
          <div className="mt-0.5 text-[11px] text-muted-foreground">100% = 只问八股，0% = 只问项目</div>
        </div>

        <div className="mt-3 border-t pt-1">
          <SettingRow title="AI 辅助提示" desc="开启后，每个问题旁会给出提示要点（练手用，正式面试别开）。">
            <Switch checked={assistMode} onCheckedChange={setAssistMode} />
          </SettingRow>
        </div>

        {!aiReady && (
          <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
            还没有配置 AI 接口：到「设置 → AI 服务」填写后开始。
          </div>
        )}
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={15} className="text-primary" />
          <span className="text-sm font-medium">结束后会生成一份复盘报告</span>
          <Badge variant="secondary">本地生成</Badge>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          报告包含整体表现、逐题点评与改进建议；生成后保存在这场记录里，可在「历史记录」回看。
        </p>
      </Card>

      <ConfirmDialog
        open={abandoning != null}
        title="放弃这场模拟面试？"
        body="放弃后这场直接结束，不会再生成复盘报告，也无法继续作答。"
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
