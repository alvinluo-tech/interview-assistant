/*
 * 历史记录：面试问答记录 + 笔试题目答案，支持展开、
 * 重命名、删除、导出 markdown；模拟面试附复盘报告（查看/重新生成）。
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileSearch, Pencil, Trash2 } from 'lucide-react';
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
import { generateMockReport, mockMeta } from '@/lib/mock';
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
      <div className="flex gap-1.5">
        {[
          { key: 'interview', label: t('面试记录') },
          { key: 'exam', label: t('笔试记录') },
          { key: 'mock', label: t('模拟面试') },
        ].map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key as 'interview' | 'mock' | 'exam')}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              tab === item.key ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'
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
      await updateSession(s.id, {
        metadata: { ...(s.metadata ?? {}), report, reportStatus: 'ready', reportError: undefined },
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

  return (
    <div className="flex flex-col gap-2">
      {(emptyCount > 0 || showEmpty) && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <span>{t('共 {count} 场，其中 {empty} 场没有问答记录。', { count: sessions.length, empty: emptyCount })}</span>
          <button type="button" className="text-primary hover:underline" onClick={() => setShowEmpty(!showEmpty)}>
            {showEmpty ? t('隐藏空记录') : t('显示空记录')}
          </button>
          {emptyCount > 0 && (
            <button
              type="button"
              className="text-destructive hover:underline"
              onClick={() => setSessions(prev => prev.filter(session => session.messages.length > 0))}
            >
              {t('清理 {count} 场空记录', { count: emptyCount })}
            </button>
          )}
        </div>
      )}
      {visible.length === 0 && (
        <Card className="p-8 text-center text-sm text-muted-foreground">{t('没有可显示的记录。')}</Card>
      )}
      {grouped.map((group) => (
        <div key={group.key} className="flex flex-col gap-2">
          <div className="mt-1 px-1 text-[11px] font-medium text-muted-foreground">{dayLabel(group.key)}</div>
          {group.rows.map((s) => {
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
                    <span className="truncate" title={s.title}>{cleanTitle(s.title)}</span>
                    {s.status === 'ACTIVE' && <Badge variant="default">{t('进行中')}</Badge>}
                  </div>
                  <div className="text-[11px] tabular-nums text-muted-foreground">
                    {clockOf(s.createdAt)} · {t('{count} 条', { count: s.messages.length })} ·{' '}
                    {s.type === 'MOCK_INTERVIEW' ? t('模拟面试') : t('真实面试')}
                  </div>
                </div>
              </button>
              {s.type === 'MOCK_INTERVIEW' && reportReady && (
                <Button size="sm" variant="secondary" onClick={() => setReportViewingId(s.id)}>
                  <FileSearch size={13} />
                  {t('复盘报告')}
                </Button>
              )}
              {reportPending && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">{t('复盘报告生成中…')}</span>
              )}
              {canRegenerate && !regeneratingId && (
                <Button size="sm" variant="ghost" onClick={() => void regenerate(s)} title={t('生成复盘报告')}>
                  <FileSearch size={13} />
                  {reportFailed ? t('重新生成报告') : t('生成复盘报告')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => exportMd(s)} title={t('导出 markdown')}>
                <Download size={13} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRenaming({ id: s.id, title: s.title })}
                title={t('重命名')}
              >
                <Pencil size={13} />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(s)} title={t('删除')}>
                <Trash2 size={13} />
              </Button>
            </div>
            {open && (
              <div className="border-t bg-muted/30 p-3">
                {s.messages.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('这场没有问答记录。')}</p>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    {s.messages.map((m) => (
                      <div key={m.id}>
                        <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">
                          {m.role === 'INTERVIEWER' ? t('面试官') : s.type === 'MOCK_INTERVIEW' ? t('我') : t('AI 回答')}
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
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t('复盘报告')}</div>
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
        </div>
      ))}

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
      <MockReportDialog session={reportViewing} onClose={() => setReportViewingId(null)} />
    </div>
  );
}

function ExamRecords() {
  const [records, setRecords] = useData<ExamSessionRecord[]>('examSessions', []);
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ExamSessionRecord | null>(null);
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
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setOpenId(open ? null : r.id)}
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
              <select
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
              </select>
              <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                <Trash2 size={13} />
              </Button>
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

function ExamImageViewer({references, onClose}: {references: string[] | null; onClose: () => void}) {
  const [index, setIndex] = useState(0), [url, setUrl] = useState(''), [error, setError] = useState('');
  const [zoom, setZoom] = useState(false);
  useEffect(() => {setIndex(0); setZoom(false);}, [references]);
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
      <Button size="sm" variant="ghost" onClick={() => setZoom(!zoom)}>{zoom ? t('适应窗口') : t('放大查看')}</Button>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : !url ? <p className="text-sm">{t('读取截图中…')}</p> :
      <div className="max-h-[72vh] overflow-auto rounded border bg-neutral-900 p-2"><img alt={t('原题截图 {index}', { index: index + 1 })} src={url} className={zoom ? 'max-w-none' : 'mx-auto max-h-[68vh] max-w-full object-contain'} /></div>}
  </Dialog>;
}
