/*
 * 历史记录：面试问答记录 + 笔试题目答案，支持展开、
 * 重命名、删除、导出 markdown；模拟面试附复盘报告（查看/重新生成）。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocus } from '@/ui/useModalFocus';
import { ChevronDown, ChevronRight, Download, FileSearch, Pencil, Trash2, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogTitle,
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
import { generateMockReport, generateWeakPoints, mockMeta } from '@/lib/mock';
import {currentMockKnowledge} from '@/lib/sessionKnowledge';
import { useAiReady } from '@/lib/aiSettings';
import { mdToPlain, Md } from '@/overlay/Md';
import { MockReportDialog } from './MockReportDialog';
import { cmd } from '@/lib/bridge';
import { t } from '@/lib/i18n';
import { useSetting } from '@/lib/store';

const DAY_ORDER = ['today', 'yesterday', 'earlier'] as const;
type DayBucket = (typeof DAY_ORDER)[number];

function dayLabel(key: DayBucket): string {
  return key === 'today' ? t('今天') : key === 'yesterday' ? t('昨天') : t('更早');
}

/** 历史列表按天分组：只显示时分，完整日期留在导出里。 */
function dayBucket(at: number): DayBucket {
  const day = new Date(at);
  const today = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((start(today) - start(day)) / 86400000);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  return 'earlier';
}

/** 会话标题在创建时拼了「 · 11/9 18:22」，分组头与副行已经显示时间，这里去掉重复段。 */
function cleanTitle(title: string): string {
  return title.replace(/\s*·\s*\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*$/, '').trim() || title;
}

function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function RecordsPage() {
  const [tab, setTab] = useState<'interview' | 'mock' | 'exam'>('interview');
  return (
    <div className="flex flex-col gap-4">
      <div className="inline-flex w-fit rounded-lg border border-line bg-surface-sunken p-0.5">
        {[
          { key: 'interview', label: t('面试记录') },
          { key: 'exam', label: t('笔试记录') },
          { key: 'mock', label: t('模拟面试') },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key as 'interview' | 'mock' | 'exam')}
            aria-pressed={tab === item.key}
            className={`rounded-md px-3 py-1 text-[13px] transition-colors ${
              tab === item.key ? 'bg-surface-raised font-medium shadow-card' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'exam' ? <ExamRecords /> : <InterviewRecords key={tab} kind={tab} />}
    </div>
  );
}

function InterviewRecords({kind}: {kind: 'interview' | 'mock'}) {
  const [allSessions, setSessions] = useData<InterviewSession[]>('interviewSessions', []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<InterviewSession | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deletingMany, setDeletingMany] = useState(false);
  const toggleSelect = (id: string) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const leaveSelect = () => { setSelecting(false); setSelected([]); };
  const [reportViewingId, setReportViewingId] = useState<string | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  // 重命名遮罩是手写的，补上 Esc 关闭：键盘用户不该被困在里面。
  useEffect(() => {
    if (!renaming) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRenaming(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [renaming]);
  const sessions = allSessions.filter(s => kind === 'mock' ? s.type === 'MOCK_INTERVIEW' : s.type !== 'MOCK_INTERVIEW');
  const [showEmpty, setShowEmpty] = useSetting<boolean>('history.showEmpty', false);
  const emptyCount = sessions.filter(s => s.messages.length === 0).length;
  const visible = useMemo(() => (showEmpty ? sessions : sessions.filter(s => s.messages.length > 0)), [sessions, showEmpty]);
  const grouped = useMemo(() => {
    const buckets = new Map<DayBucket, InterviewSession[]>();
    for (const session of visible) {
      const key = dayBucket(session.createdAt);
      const list = buckets.get(key) ?? [];
      list.push(session);
      buckets.set(key, list);
    }
    return DAY_ORDER.flatMap(key => (buckets.has(key) ? [{ key, rows: buckets.get(key) as InterviewSession[] }] : []));
  }, [visible]);
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
        `**${m.role === 'INTERVIEWER' ? '面试官' : s.type === 'MOCK_INTERVIEW' ? '我' : 'AI 回答'}**\n\n${mdToPlain(m.text)}\n`,
      ),
      ...(meta?.report ? [`## 复盘报告\n\n${meta.report}\n`] : []),
    ].join('\n');
    void navigator.clipboard.writeText(md).then(
      () => showToast({ type: 'success', title: t('已复制到剪贴板') }),
      () => showToast({ type: 'error', title: t('复制失败') }),
    );
  };

  const regenerate = async (s: InterviewSession) => {
    setRegeneratingId(s.id);
    try {
      await updateSession(s.id, {
        metadata: { ...(s.metadata ?? {}), reportStatus: 'pending', reportError: undefined },
      });
      const config=mockMeta(s)?.config;
      const report = await generateMockReport(s.messages,undefined,config?currentMockKnowledge(config):undefined);
      let weakPoints: string[] = [];
      try {
        weakPoints = await generateWeakPoints(s.messages,undefined,config?currentMockKnowledge(config):undefined);
      } catch {
        // Optional follow-up; the report stands on its own.
      }
      await updateSession(s.id, {
        metadata: { ...(s.metadata ?? {}), report, reportStatus: 'ready', reportError: undefined, weakPoints, weakPointsStatus: 'ready' },
      });
      showToast({ type: 'success', title: t('复盘报告已生成') });
    } catch (e) {
      await updateSession(s.id, {
        metadata: {
          ...(s.metadata ?? {}),
          reportStatus: 'error',
          reportError: String((e as Error).message ?? e),
        },
      });
      showToast({ type: 'error', title: t('报告生成失败'), description: String((e as Error).message ?? e) });
    } finally {
      setRegeneratingId(null);
    }
  };

  if (sessions.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        {kind === 'mock' ? t('还没有模拟面试记录。完成练习后可在这里查看对话与复盘。') : t('还没有面试记录。用面试助手聊过的每一场都会出现在这里。')}
      </Card>
    );
  }

  const [detailTab, setDetailTab] = useState<'timeline' | 'report'>('timeline');
  const detail = visible.find((s) => s.id === openId) ?? visible[0] ?? null;
  const detailMeta = detail ? mockMeta(detail) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {(emptyCount > 0 || showEmpty) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-raised px-3 py-2 text-[11px] text-ink-muted">
          <span>{t('共 {count} 场，其中 {empty} 场没有问答记录。', { count: sessions.length, empty: emptyCount })}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setShowEmpty(!showEmpty)}>
            {showEmpty ? t('隐藏空记录') : t('显示空记录')}
          </button>
          {emptyCount > 0 && (
            <button
              type="button"
              className="text-[var(--mx-status-error-text)] hover:underline"
              onClick={() => setSessions(prev => prev.filter(session => session.messages.length > 0))}
            >
              {t('清理 {count} 场空记录', { count: emptyCount })}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-[11px] text-ink-muted">
          {selecting ? (
            <>
              <span>{t('已选择 {count} 项', { count: selected.length })}</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected(visible.map(s => s.id))}>{t('全选')}</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setSelected([])}>{t('清空选择')}</button>
              <button type="button" className="text-[var(--mx-status-error-text)] hover:underline disabled:opacity-40" disabled={selected.length === 0} onClick={() => setDeletingMany(true)}>{t('删除所选')}</button>
              <button type="button" className="hover:underline" onClick={leaveSelect}>{t('取消选择')}</button>
            </>
          ) : (
            <span>{t('共 {count} 条记录', { count: visible.length })}</span>
          )}
        </div>
        {!selecting && (
          <Button size="sm" variant="outline" onClick={() => setSelecting(true)}>{t('批量管理')}</Button>
        )}
      </div>

      {visible.length === 0 && (
        <Card className="p-8 text-center text-sm text-ink-muted">{t('没有可显示的记录。')}</Card>
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-[248px_minmax(0,1fr)] items-start gap-6">
          <div className="flex flex-col gap-4">
            {grouped.map((group) => (
              <div key={group.key} className="flex flex-col gap-1.5">
                <div className="px-1 text-[11px] font-medium text-ink-muted">{dayLabel(group.key)}</div>
                {group.rows.map((s) => {
                  const active = detail?.id === s.id;
                  return (
                    <div key={s.id} className="relative">
                      {selecting && (
                        <input
                          type="checkbox"
                          className="absolute left-2 top-3 z-10 size-4 accent-[hsl(var(--primary))]"
                          aria-label={t('选择「{name}」', { name: cleanTitle(s.title) })}
                          checked={selected.includes(s.id)}
                          onChange={() => toggleSelect(s.id)}
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => (selecting ? toggleSelect(s.id) : setOpenId(s.id))}
                        className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                          active && !selecting
                            ? 'border-line bg-surface-raised shadow-card'
                            : 'border-transparent hover:bg-[var(--mx-action-secondary-hover)]'
                        } ${selecting ? 'pl-8' : ''}`}
                      >
                        <div className="flex items-center gap-1.5 text-[13px] font-medium">
                          <span className="truncate" title={s.title}>{cleanTitle(s.title)}</span>
                          {s.status === 'ACTIVE' && <Badge variant="default">{t('进行中')}</Badge>}
                        </div>
                        <div className="mt-0.5 text-[11px] tabular-nums text-ink-muted">
                          {clockOf(s.createdAt)} · {t('{count} 条', { count: s.messages.length })} ·{' '}
                          {s.type === 'MOCK_INTERVIEW' ? t('模拟面试') : t('真实面试')}
                        </div>
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {detail && (
            <div className="rounded-xl border border-line bg-surface-raised p-6 shadow-card">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-[18px] font-semibold leading-[26px]">{cleanTitle(detail.title)}</h3>
                  <div className="mt-1 text-[11px] tabular-nums text-ink-muted">
                    {clockOf(detail.createdAt)} · {t('{count} 条', { count: detail.messages.length })} · {detail.type === 'MOCK_INTERVIEW' ? t('模拟面试') : t('真实面试')}
                  </div>
                </div>
                <div className="flex gap-1">
                  {detail.type === 'MOCK_INTERVIEW' && detailMeta?.report && (
                    <Button size="sm" variant="outline" onClick={() => setReportViewingId(detail.id)}>
                      <FileSearch size={13} />
                      {t('复盘报告')}
                    </Button>
                  )}
                  {!selecting && detailMeta?.reportStatus === 'pending' && !detailMeta.report && (
                    <span className="self-center text-[11px] text-ink-muted">{t('复盘报告生成中…')}</span>
                  )}
                  {!selecting && detail.type === 'MOCK_INTERVIEW' && detail.status === 'COMPLETED' && detail.messages.some((m) => m.role === 'ASSISTANT') && !detailMeta?.report && aiReady && !regeneratingId && (
                    <Button size="sm" variant="ghost" onClick={() => void regenerate(detail)} title={t('生成复盘报告')}>
                      <FileSearch size={13} />
                      {detailMeta?.reportStatus === 'error' ? t('重新生成报告') : t('生成复盘报告')}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => exportMd(detail)} title={t('导出 markdown')}>
                    <Download size={13} />
                    {t('导出')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRenaming({ id: detail.id, title: detail.title })} title={t('重命名')}>
                    <Pencil size={13} />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(detail)} title={t('删除')}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>

              <div className="mt-4 inline-flex w-fit rounded-lg border border-line bg-surface-sunken p-0.5">
                {[
                  { key: 'timeline' as const, label: t('问答时间线') },
                  ...(detailMeta?.report ? [{ key: 'report' as const, label: t('复盘摘要') }] : []),
                ].map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setDetailTab(item.key)}
                    aria-pressed={detailTab === item.key}
                    className={`rounded-md px-3 py-1 text-[12px] transition-colors ${detailTab === item.key ? 'bg-surface-raised font-medium shadow-card' : 'text-ink-muted hover:text-ink'}`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex flex-col gap-3">
                {detailTab === 'report' && detailMeta?.report ? (
                  <div className="records-md"><Md text={detailMeta.report} /></div>
                ) : detail.messages.length === 0 ? (
                  <p className="text-[12px] text-ink-muted">{t('这场没有问答记录。')}</p>
                ) : (
                  detail.messages.map((m) => (
                    <div key={m.id}>
                      <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-ink-muted">
                        <span>{clockOf(m.createdAt)}</span>
                        <span>{m.role === 'INTERVIEWER' ? t('面试官') : detail.type === 'MOCK_INTERVIEW' ? t('我') : t('AI 回答')}</span>
                      </div>
                      <div className={`whitespace-pre-wrap text-[13px] leading-[22px] ${m.role === 'INTERVIEWER' ? 'text-ink' : 'rounded-lg border border-line bg-surface-sunken px-3 py-2'}`}>
                        {mdToPlain(m.text)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {renaming && (
        <div role="dialog" aria-modal="true" aria-label={t('重命名')} className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
          <div className="w-full max-w-sm rounded-lg border bg-card p-4">
            <div className="mb-2 text-sm font-semibold">{t('重命名')}</div>
            <Input
              maxLength={60}
              value={renaming.title}
              onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setRenaming(null)}>
                {t('取消')}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setSessions((prev) =>
                    prev.map((x) => (x.id === renaming.id ? { ...x, title: renaming.title.trim() } : x)),
                  );
                  setRenaming(null);
                }}
              >
                {t('保存')}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleting != null}
        title={t('删除记录')}
        body={t('删除后无法恢复，确定删除「{name}」吗？', { name: deleting?.title ?? '' })}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) setSessions((prev) => prev.filter((x) => x.id !== deleting.id));
          setDeleting(null);
        }}
      />
      <ConfirmDialog
        open={deletingMany}
        title={t('删除 {count} 条记录', { count: selected.length })}
        body={t('删除后无法恢复。')}
        onCancel={() => setDeletingMany(false)}
        onConfirm={() => {
          const ids = new Set(selected);
          setSessions(prev => prev.filter(session => !ids.has(session.id)));
          setDeletingMany(false);
          leaveSelect();
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
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deletingMany, setDeletingMany] = useState(false);
  const toggleSelect = (id: string) => setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const leaveSelect = () => { setSelecting(false); setSelected([]); };
  const [images, setImages] = useState<string[] | null>(null);
  const [showEmpty, setShowEmpty] = useSetting<boolean>('history.showEmpty', false);
  const emptyCount = records.filter(r => r.questions.length === 0).length;
  const visible = useMemo(() => (showEmpty ? records : records.filter(r => r.questions.length > 0)), [records, showEmpty]);
  const grouped = useMemo(() => {
    const buckets = new Map<DayBucket, ExamSessionRecord[]>();
    for (const record of visible) {
      const key = dayBucket(record.createdAt);
      const list = buckets.get(key) ?? [];
      list.push(record);
      buckets.set(key, list);
    }
    return DAY_ORDER.flatMap(key => (buckets.has(key) ? [{ key, rows: buckets.get(key) as ExamSessionRecord[] }] : []));
  }, [visible]);

  if (records.length === 0) {
    return (
      <Card className="p-8 text-center text-sm text-muted-foreground">
        {t('还没有笔试记录。用笔试助手解过的题会出现在这里。')}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {(emptyCount > 0 || showEmpty) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t('共 {count} 场，其中 {empty} 场没有问答记录。', { count: records.length, empty: emptyCount })}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setShowEmpty(!showEmpty)}>
            {showEmpty ? t('隐藏空记录') : t('显示空记录')}
          </button>
          {emptyCount > 0 && (
            <button
              type="button"
              className="text-destructive hover:underline"
              onClick={() => setRecords(prev => prev.filter(record => record.questions.length > 0))}
            >
              {t('清理 {count} 场空记录', { count: emptyCount })}
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
        {selecting ? (
          <>
            <span>{t('已选择 {count} 项', { count: selected.length })}</span>
            <button type="button" className="text-primary hover:underline" onClick={() => setSelected(visible.map(r => r.id))}>{t('全选')}</button>
            <button type="button" className="text-primary hover:underline" onClick={() => setSelected([])}>{t('清空选择')}</button>
            <button type="button" className="text-destructive hover:underline disabled:opacity-40" disabled={selected.length === 0} onClick={() => setDeletingMany(true)}>{t('删除所选')}</button>
            <button type="button" className="hover:underline" onClick={leaveSelect}>{t('取消选择')}</button>
          </>
        ) : (
          <>
            <span>{t('共 {count} 条记录', { count: visible.length })}</span>
            <button type="button" className="text-primary hover:underline" onClick={() => setSelecting(true)}>{t('批量选择')}</button>
          </>
        )}
      </div>
      {visible.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('没有可显示的记录。')}</Card>
      )}
      {grouped.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <div className="mt-1 px-1 text-[11px] font-medium text-muted-foreground">{dayLabel(group.key)}</div>
          {group.rows.map((r) => {
        const open = openId === r.id;
        return (
          <Card key={r.id} className="overflow-hidden">
            <div className="flex items-center gap-2 p-3">
              {selecting && (
                <input
                  type="checkbox"
                  className="size-4 shrink-0 accent-[hsl(var(--primary))]"
                  aria-label={t('选择「{name}」', { name: cleanTitle(r.title) })}
                  checked={selected.includes(r.id)}
                  onChange={() => toggleSelect(r.id)}
                />
              )}
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => (selecting ? toggleSelect(r.id) : setOpenId(open ? null : r.id))}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <span className="truncate" title={r.title}>{cleanTitle(r.title)}</span>
                    {r.status === 'ACTIVE' && <Badge variant="default">{t('进行中')}</Badge>}
                  </div>
                  <div className="text-[11px] tabular-nums text-muted-foreground">
                    {clockOf(r.createdAt)} · {t('{count} 题', { count: r.questions.length })}
                    {r.mode ? ` · ${r.mode}` : ''}
                  </div>
                </div>
              </button>
              {!selecting && <select
                className="h-7 rounded border bg-background px-1 text-[11px]"
                value={r.outcome ?? ''}
                onChange={(e) =>
                  setRecords((prev) =>
                    prev.map((x) =>
                      x.id === r.id ? { ...x, outcome: (e.target.value || null) as ExamSessionRecord['outcome'] } : x,
                    ),
                  )
                }
              >
                <option value="">{t('结果未标')}</option>
                <option value="PASSED">{t('过了')}</option>
                <option value="FAILED">{t('没过')}</option>
                <option value="WAITING">{t('还在等')}</option>
              </select>}
              {!selecting && (
                <Button size="sm" variant="ghost" onClick={() => setDeleting(r)} aria-label={t('删除')} title={t('删除')}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
            {open && (
              <div className="border-t bg-muted/30 p-3">
                {r.questions.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('这场笔试没有题目记录。')}</p>
                ) : (
                  <div className="flex flex-col gap-3">
                    {r.questions.map((q, i) => (
                      <div key={q.id}>
                        <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                          {q.parentTurnId ? t('追问') : t('第 {n} 题', { n: i + 1 })} · {new Date(q.createdAt).toLocaleTimeString('zh-CN')}
                          {!!q.screenshotRefs?.length && <Button size="sm" variant="ghost" className="ml-2" onClick={() => setImages(q.screenshotRefs!)}>{t('查看原图 · {count} 张', { count: q.screenshotRefs.length })}</Button>}
                        </div>
                        <div className="records-md whitespace-pre-wrap rounded-md border bg-background px-2.5 py-2">
                          <div className="mb-2 border-b pb-2"><p className="mb-1 text-xs text-muted-foreground">{t('原题')}</p>{q.questionText && !/^第\s*\d+\s*题$/.test(q.questionText) ? <Md text={q.questionText} /> : t('旧记录未保存题干。')}</div>
                          <p className="mb-1 text-xs text-muted-foreground">{t('答案')}</p>
                          {q.answer ? <Md text={q.answer} /> : t('这道题没有答案记录。')}
                          {q.imageSaveError && <p role="alert" className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('截图未能保存：{message}', { message: q.imageSaveError })}</p>}
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
        </div>
      ))}
      <ExamImageViewer references={images} onClose={() => setImages(null)} />
      <ConfirmDialog
        open={deletingMany}
        title={t('删除 {count} 条记录', { count: selected.length })}
        body={t('删除后无法恢复。')}
        onCancel={() => setDeletingMany(false)}
        onConfirm={() => {
          const ids = new Set(selected);
          setRecords(prev => prev.filter(record => !ids.has(record.id)));
          for (const id of selected) void cmd('cmd_exam_delete_images', { sessionId: id }).catch(() => {});
          setDeletingMany(false);
          leaveSelect();
        }}
      />
      <ConfirmDialog
        open={deleting != null}
        title={t('删除记录')}
        body={t('删除后无法恢复，确定删除「{name}」吗？', { name: deleting?.title ?? '' })}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            const id = deleting.id;
            setRecords((prev) => prev.filter((x) => x.id !== id));
            // 记录删除后同步回收截图附件，避免只写不删。
            void cmd('cmd_exam_delete_images', { sessionId: id }).catch(() => {});
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

void SectionHeader;

const MAX_ZOOM = 6;

/** 图片缩放：滚轮以光标为锚点缩放，按住拖动平移，双击在适应与 2.5 倍之间切换。 */
function ZoomableImage({src, alt}: {src: string; alt: string}) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [natural, setNatural] = useState({w: 0, h: 0}), [box, setBox] = useState({w: 0, h: 0});
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({x: 0, y: 0}), [dragging, setDragging] = useState(false);
  const state = useRef({zoom: 1, pan: {x: 0, y: 0}, box: {w: 0, h: 0}});
  state.current = {zoom, pan, box};
  const drag = useRef<{x: number; y: number; panX: number; panY: number} | null>(null);

  useEffect(() => {
    if (!natural.w) return;
    const fit = () => {
      const maxW = Math.max(240, window.innerWidth * 0.92 - 40), maxH = Math.max(200, window.innerHeight * 0.74);
      const scale = Math.min(1, maxW / natural.w, maxH / natural.h);
      setBox({w: Math.round(natural.w * scale), h: Math.round(natural.h * scale)});
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [natural]);

  const clamp = (next: {x: number; y: number}, value: number) => {
    const maxX = Math.max(0, (box.w * value - box.w) / 2), maxY = Math.max(0, (box.h * value - box.h) / 2);
    return {x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y))};
  };
  /** 以容器内某点为锚点缩放，锚点下的像素保持不动。 */
  const zoomAt = (factor: number, anchor?: {x: number; y: number}) => {
    const {zoom: current, pan: offset} = state.current;
    const value = Math.min(MAX_ZOOM, Math.max(1, current * factor));
    if (value === current) return;
    const point = anchor ?? {x: 0, y: 0};
    const ratio = value / current;
    const next = {x: point.x - (point.x - offset.x) * ratio, y: point.y - (point.y - offset.y) * ratio};
    setZoom(value);
    setPan(value === 1 ? {x: 0, y: 0} : clamp(next, value));
  };
  const reset = () => {setZoom(1); setPan({x: 0, y: 0});};
  const actualSize = () => {
    if (!natural.w || !box.w) return;
    const value = Math.min(MAX_ZOOM, Math.max(1, natural.w / box.w));
    setZoom(value);
    // 100% 时从左上角开始看，而不是停在图片正中间。
    setPan({x: (box.w * value - box.w) / 2, y: (box.h * value - box.h) / 2});
  };

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) < 1) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, {x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2});
    };
    element.addEventListener('wheel', onWheel, {passive: false});
    return () => element.removeEventListener('wheel', onWheel);
  });

  const percent = natural.w && box.w ? Math.round((zoom * box.w) / natural.w * 100) : 100;
  return <div className="flex flex-col items-center gap-2">
    <div className="flex items-center gap-2 text-[11px] text-white/70">
      <button type="button" onClick={() => zoomAt(1 / 1.25)} disabled={zoom <= 1} className="rounded-md border border-white/15 px-2 py-1 disabled:opacity-40 hover:bg-white/10" aria-label={t('缩小')} title={t('缩小')}>−</button>
      <span className="w-12 text-center tabular-nums">{percent}%</span>
      <button type="button" onClick={() => zoomAt(1.25)} disabled={zoom >= MAX_ZOOM} className="rounded-md border border-white/15 px-2 py-1 disabled:opacity-40 hover:bg-white/10" aria-label={t('放大')} title={t('放大')}>+</button>
      <button type="button" onClick={reset} className="rounded-md border border-white/15 px-2 py-1 hover:bg-white/10">{t('适应窗口')}</button>
      <button type="button" onClick={actualSize} className="rounded-md border border-white/15 px-2 py-1 hover:bg-white/10">{t('实际大小')}</button>
    </div>
    <div
      ref={frame}
      style={{width: box.w || undefined, height: box.h || undefined}}
      className={`relative overflow-hidden rounded-md bg-black/40 ${dragging ? 'cursor-grabbing' : zoom > 1 ? 'cursor-grab' : 'cursor-zoom-in'}`}
      onDoubleClick={event => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (zoom > 1) return reset();
        const anchor = {x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2};
        const value = 2.5;
        const next = {x: anchor.x - anchor.x * value, y: anchor.y - anchor.y * value};
        setZoom(value); setPan(clamp(next, value));
      }}
      onPointerDown={event => {
        if (zoom <= 1) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y};
        setDragging(true);
      }}
      onPointerMove={event => {
        const start = drag.current;
        if (!start) return;
        setPan(clamp({x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y}, zoom));
      }}
      onPointerUp={event => {
        if (!drag.current) return;
        drag.current = null; setDragging(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {drag.current = null; setDragging(false);}}
    >
      <img
        alt={alt}
        src={src}
        draggable={false}
        onLoad={event => setNatural({w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight})}
        style={{transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: 'center', width: box.w || '100%', height: box.h || 'auto'}}
        className="max-w-none select-none"
      />
    </div>
  </div>;
}

function ExamImageViewer({references, onClose}: {references: string[] | null; onClose: () => void}) {
  const [index, setIndex] = useState(0), [url, setUrl] = useState(''), [error, setError] = useState('');
  const [full, setFull] = useState(false);
  const fullRoot = useRef<HTMLDivElement | null>(null), fullClose = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {setIndex(0); setFull(false);}, [references]);
  // 走同一个模态栈：Escape 只关最上面这层，详情对话框留在后面。
  useModalFocus(fullRoot, full, () => setFull(false), fullClose);
  useEffect(() => {
    let disposed = false; setUrl(''); setError('');
    if (references?.[index]) void cmd<string>('cmd_exam_read_image', {reference: references[index]})
      .then(value => {if (!disposed) setUrl(value);}).catch(error => {if (!disposed) setError(String(error));});
    return () => {disposed = true;};
  }, [references, index]);
  return <Dialog open={!!references} onClose={onClose} className="max-w-[92vw]">
    <DialogTitle>{t('原题截图')}</DialogTitle>
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{t('第 {index} / {total} 张 · 已压缩保存', { index: index + 1, total: references?.length || 0 })}</span>
      <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setIndex(index - 1)}>{t('上一张')}</Button>
      <Button size="sm" variant="outline" disabled={index >= (references?.length || 0) - 1} onClick={() => setIndex(index + 1)}>{t('下一张')}</Button>
      <Button size="sm" variant="ghost" disabled={!url} onClick={() => setFull(true)}>{t('放大查看')}</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !url ? <p className="text-sm">{t('读取截图中…')}</p> :
      <div className="max-h-[72vh] overflow-auto rounded border bg-neutral-900 p-2"><img alt={t('原题截图 {index}', { index: index + 1 })} src={url} className="mx-auto max-h-[68vh] max-w-full object-contain" /></div>}
    {full && url && createPortal(
      <div ref={fullRoot} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={t('原题截图')} tabIndex={-1} onClick={() => setFull(false)}>
        <div className="flex max-h-[92vh] w-fit min-w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-white/10 bg-neutral-950 shadow-2xl" onClick={event => event.stopPropagation()}>
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3 text-xs text-white/80">
          <span>{t('第 {index} / {total} 张 · 已压缩保存', { index: index + 1, total: references?.length || 0 })}</span>
          <Button size="sm" variant="outline" disabled={index === 0} onClick={() => setIndex(index - 1)}>{t('上一张')}</Button>
          <Button size="sm" variant="outline" disabled={index >= (references?.length || 0) - 1} onClick={() => setIndex(index + 1)}>{t('下一张')}</Button>
          <span className="ml-auto text-[11px] text-white/55">{t('滚轮缩放 · 拖动平移 · 双击切换')}</span>
          <button ref={fullClose} type="button" aria-label={t('关闭预览')} title={t('关闭预览')} onClick={() => setFull(false)} className="ml-1 rounded-md p-1.5 text-white/70 hover:bg-white/10 hover:text-white"><X size={16} /></button>
        </div>
        <div className="min-h-0 flex-1 p-3">
          <ZoomableImage key={url} src={url} alt={t('原题截图 {index}', { index: index + 1 })} />
        </div>
        </div>
      </div>,
      document.body,
    )}
  </Dialog>;
}
