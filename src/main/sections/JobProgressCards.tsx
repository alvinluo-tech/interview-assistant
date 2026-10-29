/*
 * 求职进展回访（1:1 对齐原版 yB/dB/gB/_B，BS:37639-37796）：
 * 回访卡（最近一场未标结果的会话）+ 打卡卡（每 5 场问 offer/OC 数）+ 未过推广卡。
 * 原版走服务端 jobProgress.followUp/submitCheckin；这里用本地会话数据驱动同一套交互。
 */
import { useState } from 'react';
import { CalendarCheck, MessageCircleQuestion } from 'lucide-react';
import { useData, type ExamSessionRecord, type Goal, type InterviewSession } from '@/lib/backend';

export interface JobProgressState {
  lastCheckinCount: number;
  lastCheckinAt: number;
  offerCount: number;
  ocCount: number;
}

const EMPTY_PROGRESS: JobProgressState = {
  lastCheckinCount: 0,
  lastCheckinAt: 0,
  offerCount: 0,
  ocCount: 0,
};

const CHECKIN_EVERY = 5;

function roundLabel(index: number): string {
  return ['一面', '二面', '三面', 'HR 面'][index] ?? '那一轮面试';
}

function goalLine(goals: Goal[], goalId?: string | null): string {
  const g = goals.find((x) => x.id === goalId);
  if (!g) return '';
  return g.companyName ? `${g.companyName} · ${g.name}` : g.name;
}

function clampCount(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return undefined;
  return Math.min(99, Math.max(0, n));
}

export function JobProgressCards() {
  const [sessions, setSessions] = useData<InterviewSession[]>('interviewSessions', []);
  const [exams, setExams] = useData<ExamSessionRecord[]>('examSessions', []);
  const [goals] = useData<Goal[]>('goals', []);
  const [progress, setProgress] = useData<JobProgressState>('jobProgress', EMPTY_PROGRESS);
  const [marking, setMarking] = useState(false);
  const [offerInput, setOfferInput] = useState('');
  const [ocInput, setOcInput] = useState('');

  // 最近一场结束且未标结果的会话（面试或笔试，按结束时间取最新）
  const candidates = [
    ...sessions
      .filter((s) => s.type === 'INTERVIEW' && s.status === 'COMPLETED' && !s.outcome)
      .map((s) => ({ kind: 'interview' as const, id: s.id, at: s.endedAt ?? s.createdAt, goalId: s.goalId, createdAt: s.createdAt })),
    ...exams
      .filter((e) => e.status === 'COMPLETED' && !e.outcome)
      .map((e) => ({ kind: 'exam' as const, id: e.id, at: e.endedAt ?? e.createdAt, goalId: e.goalId, createdAt: e.createdAt })),
  ].sort((a, b) => b.at - a.at);
  const pending = candidates[0] ?? null;

  // 面试轮次 = 同岗位此前完成的面试场数（一面/二面/三面/HR 面）
  let interviewTitle = '';
  if (pending?.kind === 'interview') {
    const prior = sessions
      .filter((s) => s.type === 'INTERVIEW' && s.status === 'COMPLETED' && s.goalId === pending.goalId)
      .sort((a, b) => a.createdAt - b.createdAt);
    const line = goalLine(goals, pending.goalId) || '那场面试';
    interviewTitle = `${line} ${roundLabel(prior.findIndex((s) => s.id === pending.id))}之后怎么样了？`;
  }
  const examTitle = pending?.kind === 'exam' ? `${goalLine(goals, pending.goalId) || '那场'} 的笔试过了吗？` : '';

  const completedCount =
    sessions.filter((s) => s.type === 'INTERVIEW' && s.status === 'COMPLETED').length +
    exams.filter((e) => e.status === 'COMPLETED').length;
  const checkinDue = completedCount >= progress.lastCheckinCount + CHECKIN_EVERY && completedCount > 0;

  const mark = async (markValue: string) => {
    if (!pending || marking) return;
    setMarking(true);
    try {
      if (pending.kind === 'interview') {
        setSessions(
          sessions.map((s) =>
            s.id === pending.id ? { ...s, outcome: markValue as InterviewSession['outcome'] } : s,
          ),
        );
      } else {
        setExams(
          exams.map((e) =>
            e.id === pending.id ? { ...e, outcome: markValue as ExamSessionRecord['outcome'] } : e,
          ),
        );
      }
    } finally {
      setMarking(false);
    }
  };

  const submitCheckin = (skip: boolean) => {
    const offer = clampCount(offerInput);
    const oc = clampCount(ocInput);
    if (!skip && offer === undefined && oc === undefined) return;
    setProgress({
      lastCheckinCount: completedCount,
      lastCheckinAt: Date.now(),
      offerCount: skip ? progress.offerCount : offer ?? progress.offerCount,
      ocCount: skip ? progress.ocCount : oc ?? progress.ocCount,
    });
    setOfferInput('');
    setOcInput('');
  };

  if (!pending && !checkinDue) return null;

  return (
    <div className="mb-4 space-y-3">
      {pending && (
        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-start gap-2">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[14px] font-semibold leading-snug text-foreground">
                {pending.kind === 'exam' ? examTitle : interviewTitle}
              </h2>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                标一下，同岗位下一轮面试时 AI 会结合前几轮的表现来作答。
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {(pending.kind === 'exam'
              ? [
                  { mark: 'PASSED', label: '过了', ghost: false },
                  { mark: 'FAILED', label: '没过', ghost: false },
                  { mark: 'WAITING', label: '还在等', ghost: true },
                ]
              : [
                  { mark: 'PASSED', label: '进下一轮', ghost: false },
                  { mark: 'OC', label: '拿到 OC', ghost: false },
                  { mark: 'OFFER', label: '拿到 offer', ghost: false },
                  { mark: 'FAILED', label: '没过', ghost: false },
                  { mark: 'WAITING', label: '还在等', ghost: true },
                ]
            ).map((b) => (
              <button
                key={b.mark}
                type="button"
                disabled={marking}
                onClick={() => void mark(b.mark)}
                className={
                  b.ghost
                    ? 'inline-flex h-8 items-center rounded-md px-2.5 text-xs hover:bg-accent disabled:opacity-50'
                    : 'inline-flex h-8 items-center rounded-md border px-2.5 text-xs hover:bg-accent disabled:opacity-50'
                }
              >
                {b.label}
              </button>
            ))}
          </div>
        </section>
      )}

      {checkinDue && (
        <section className="rounded-2xl border border-border bg-card p-4 shadow-sm">
          <div className="flex items-start gap-2">
            <CalendarCheck className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <h2 className="text-[14px] font-semibold leading-snug text-foreground">
                已经完成 {completedCount} 场笔试和面试了，目前拿到几个 offer / OC？
              </h2>
              <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                只记个数，用来把面试和笔试的回答做得更好。不想填可以跳过。
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="w-28 space-y-1">
              <span className="text-[11px] text-muted-foreground">offer</span>
              <input
                type="number"
                min={0}
                max={99}
                inputMode="numeric"
                value={offerInput}
                onChange={(e) => setOfferInput(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
              />
            </label>
            <label className="w-28 space-y-1">
              <span className="text-[11px] text-muted-foreground">OC</span>
              <input
                type="number"
                min={0}
                max={99}
                inputMode="numeric"
                value={ocInput}
                onChange={(e) => setOcInput(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/50"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className="inline-flex h-9 items-center rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                disabled={marking || (clampCount(offerInput) === undefined && clampCount(ocInput) === undefined)}
                onClick={() => submitCheckin(false)}
              >
                记下
              </button>
              <button
                type="button"
                className="inline-flex h-9 items-center rounded-md px-3 text-[13px] hover:bg-accent disabled:opacity-50"
                disabled={marking}
                onClick={() => submitCheckin(true)}
              >
                跳过
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
