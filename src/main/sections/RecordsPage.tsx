/*
 * 历史记录（对齐原版 TV）：面试问答记录 + 笔试题目答案，支持展开、
 * 重命名、删除、导出 markdown；模拟面试附复盘报告（查看/重新生成）。
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileSearch, Pencil, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  SectionHeader,
  showToast,
} from '@/ui/primitives';
import {
  updateSession,
  useData,
  type ExamSessionRecord,
  type InterviewSession,
} from '@/lib/backend';
import { generateMockReport, mockMeta } from '@/lib/mock';
import { useAiReady } from '@/lib/aiSettings';
import { mdToPlain, Md } from '@/overlay/Md';
import { MockReportDialog } from './MockReportDialog';

export function RecordsPage() {
  const [tab, setTab] = useState<'interview' | 'exam'>('interview');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1.5">
        {[
          { key: 'interview', label: '面试记录' },
          { key: 'exam', label: '笔试记录' },
        ].map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key as 'interview' | 'exam')}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === t.key ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'interview' ? <InterviewRecords /> : <ExamRecords />}
    </div>
  );
}

function InterviewRecords() {
  const [sessions, setSessions] = useData<InterviewSession[]>('interviewSessions', []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<InterviewSession | null>(null);
  const [reportViewingId, setReportViewingId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const aiReady = useAiReady('chat');
  const reportViewing = sessions.find((s) => s.id === reportViewingId) ?? null;

  const exportMd = (s: InterviewSession) => {
    const meta = mockMeta(s);
    const md = [
      `# ${s.title}`,
      '',
      `- 时间：${new Date(s.createdAt).toLocaleString('zh-CN')}`,
      `- 消息数：${s.messages.length}`,
      '',
      ...s.messages.map((m) =>
        `**${m.role === 'INTERVIEWER' ? '面试官' : 'AI 回答'}**\n\n${mdToPlain(m.text)}\n`,
      ),
      ...(meta?.report ? [`## 复盘报告\n\n${meta.report}\n`] : []),
    ].join('\n');
    void navigator.clipboard.writeText(md).then(
      () => showToast({ type: 'success', title: '已复制到剪贴板' }),
      () => showToast({ type: 'error', title: '复制失败' }),
    );
  };

  const regenerate = async (s: InterviewSession) => {
    setRegeneratingId(s.id);
    try {
      await updateSession(s.id, {
        metadata: { ...(s.metadata ?? {}), reportStatus: 'pending', reportError: undefined },
      });
      const report = await generateMockReport(s.messages);
      await updateSession(s.id, {
        metadata: { ...(s.metadata ?? {}), report, reportStatus: 'ready', reportError: undefined },
      });
      showToast({ type: 'success', title: '复盘报告已生成' });
    } catch (e) {
      await updateSession(s.id, {
        metadata: {
          ...(s.metadata ?? {}),
          reportStatus: 'error',
          reportError: String((e as Error).message ?? e),
        },
      });
      showToast({ type: 'error', title: '报告生成失败', description: String((e as Error).message ?? e) });
    } finally {
      setRegeneratingId(null);
    }
  };

  if (sessions.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        还没有面试记录。用面试助手聊过的每一场都会出现在这里。
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sessions.map((s) => {
        const meta = mockMeta(s);
        const open = openId === s.id;
        const reportReady = Boolean(meta?.report);
        const reportPending = meta?.reportStatus === 'pending' && !reportReady;
        const reportFailed = meta?.reportStatus === 'error' && !reportReady;
        const canRegenerate =
          s.type === 'MOCK_INTERVIEW' &&
          s.status === 'COMPLETED' &&
          s.messages.some((m) => m.role === 'ASSISTANT') &&
          !reportReady &&
          aiReady;
        return (
          <Card key={s.id} className="overflow-hidden">
            <div className="flex items-center gap-2 p-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(open ? null : s.id)}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{s.title}</span>
                    {s.status === 'ACTIVE' && <Badge variant="default">进行中</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(s.createdAt).toLocaleString('zh-CN')} · {s.messages.length} 条 ·{' '}
                    {s.type === 'MOCK_INTERVIEW' ? '模拟面试' : '真实面试'}
                  </div>
                </div>
              </button>
              {s.type === 'MOCK_INTERVIEW' && reportReady && (
                <Button size="sm" variant="secondary" onClick={() => setReportViewingId(s.id)}>
                  <FileSearch size={13} />
                  复盘报告
                </Button>
              )}
              {reportPending && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">复盘报告生成中…</span>
              )}
              {canRegenerate && !regeneratingId && (
                <Button size="sm" variant="ghost" onClick={() => void regenerate(s)} title="生成复盘报告">
                  <FileSearch size={13} />
                  {reportFailed ? '重新生成报告' : '生成复盘报告'}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => exportMd(s)} title="导出 markdown">
                <Download size={13} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRenaming({ id: s.id, title: s.title })}
                title="重命名"
              >
                <Pencil size={13} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(s)} title="删除">
                <Trash2 size={13} />
              </Button>
            </div>
            {open && (
              <div className="border-t bg-muted/30 p-3">
                {s.messages.length === 0 ? (
                  <p className="text-xs text-muted-foreground">这场没有问答记录。</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {s.messages.map((m) => (
                      <div key={m.id}>
                        <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                          {m.role === 'INTERVIEWER' ? '面试官' : 'AI 回答'}
                        </div>
                        <div
                          className={`records-md whitespace-pre-wrap rounded-md border px-2.5 py-2 ${
                            m.role === 'INTERVIEWER' ? 'bg-background' : 'border-emerald-500/20 bg-emerald-500/5'
                          }`}
                        >
                          {mdToPlain(m.text)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {meta?.report && (
                  <div className="mt-3 border-t pt-3">
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">复盘报告</div>
                    <div className="records-md whitespace-pre-wrap rounded-md border border-primary/20 bg-primary/5 px-2.5 py-2">
                      <Md text={meta.report} />
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}

      {renaming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-card p-4">
            <div className="mb-2 text-sm font-semibold">重命名</div>
            <Input
              maxLength={60}
              value={renaming.title}
              onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRenaming(null)}>
                取消
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSessions(
                    sessions.map((x) => (x.id === renaming.id ? { ...x, title: renaming.title.trim() } : x)),
                  );
                  setRenaming(null);
                }}
              >
                保存
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting != null}
        title="删除记录"
        body={`删除后无法恢复，确定删除「${deleting?.title ?? ''}」吗？`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) setSessions(sessions.filter((x) => x.id !== deleting.id));
          setDeleting(null);
        }}
      />
      <MockReportDialog session={reportViewing} onClose={() => setReportViewingId(null)} />
    </div>
  );
}

function ExamRecords() {
  const [records, setRecords] = useData<ExamSessionRecord[]>('examSessions', []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ExamSessionRecord | null>(null);

  if (records.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        还没有笔试记录。用笔试助手解过的题会出现在这里。
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {records.map((r) => {
        const open = openId === r.id;
        return (
          <Card key={r.id} className="overflow-hidden">
            <div className="flex items-center gap-2 p-3">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(open ? null : r.id)}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate">{r.title}</span>
                    {r.status === 'ACTIVE' && <Badge variant="default">进行中</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(r.createdAt).toLocaleString('zh-CN')} · {r.questions.length} 题
                    {r.mode ? ` · ${r.mode}` : ''}
                  </div>
                </div>
              </button>
              <select
                className="h-7 rounded border bg-background px-1 text-[11px]"
                value={r.outcome ?? ''}
                onChange={(e) =>
                  setRecords(
                    records.map((x) =>
                      x.id === r.id ? { ...x, outcome: (e.target.value || null) as ExamSessionRecord['outcome'] } : x,
                    ),
                  )
                }
              >
                <option value="">结果未标</option>
                <option value="PASSED">过了</option>
                <option value="FAILED">没过</option>
                <option value="WAITING">还在等</option>
              </select>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                <Trash2 size={13} />
              </Button>
            </div>
            {open && (
              <div className="border-t bg-muted/30 p-3">
                {r.questions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">这场笔试没有题目记录。</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {r.questions.map((q, i) => (
                      <div key={q.id}>
                        <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                          第 {i + 1} 题 · {new Date(q.createdAt).toLocaleTimeString('zh-CN')}
                        </div>
                        <div className="records-md whitespace-pre-wrap rounded-md border bg-background px-2.5 py-2">
                          {q.answer ? mdToPlain(q.answer) : '这道题没有答案记录。'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Card>
        );
      })}
      <ConfirmDialog
        open={deleting != null}
        title="删除记录"
        body={`删除后无法恢复，确定删除「${deleting?.title ?? ''}」吗？`}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) setRecords(records.filter((x) => x.id !== deleting.id));
          setDeleting(null);
        }}
      />
    </div>
  );
}

void SectionHeader;
