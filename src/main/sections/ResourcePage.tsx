/*
 * 资料管理：简历 / 岗位 / 面试资料三区块，
 * 含新建岗位弹窗、资料编辑器（自由资料 + 预设问答 + AI 生成）。
 */
import { useRef, useState } from 'react';
import { Briefcase, Check, FileText, Layers, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogDesc,
  DialogTitle,
  Input,
  Select,
  Textarea,
  showToast,
} from '@/ui/primitives';
import { useConfirm } from '@/ui/confirm';
import {
  deleteEntry,
  deleteGoal,
  deleteMaterial,
  deleteResume,
  saveEntry,
  saveGoal,
  saveMaterial,
  saveResume,
  useData,
  type Goal,
  type Material,
  type Resume,
} from '@/lib/backend';
import {generatePreparation} from '@/lib/preparation';
import { companyFromJd } from '@/lib/goalImport';
import { DocumentImportDialog } from '../DocumentImportDialog';
import { DOCUMENT_ACCEPT } from '@/lib/documentIngest';
import { useSetting } from '@/lib/store';
import { t } from '@/lib/i18n';

export function ResourcePage({ onNavigate }: { onNavigate?: (section: 'interview') => void } = {}) {
  const [resumes] = useData<Resume[]>('resumes', []);
  const [goals] = useData<Goal[]>('goals', []);
  const [materials] = useData<Material[]>('materials', []);

  const [goalDialog, setGoalDialog] = useState<{ open: boolean; goal?: Goal }>({ open: false });
  const [editorId, setEditorId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'resume' | 'goal' | 'material'; id: string; name: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewResume, setPreviewResume] = useState<Resume | null>(null);
  const [importKind, setImportKind] = useState<'resume' | 'material' | 'goal'>('resume');
  const [typeFilter, setTypeFilter] = useState<'all' | 'resume' | 'goal' | 'material'>('all');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [importChoice, setImportChoice] = useState(false);
  const [, setPendingResumeId] = useSetting<string>('interview.pendingResumeId', '');
  const [, setPendingGoalId] = useSetting<string>('interview.pendingGoalId', '');
  const [pendingMaterialIds, setPendingMaterialIds] = useSetting<string[]>('interview.pendingMaterialIds', []);

  const items = [
    ...resumes.map((r) => ({
      key: `resume:${r.id}`,
      kind: 'resume' as const,
      title: r.title,
      meta: t('上传于 {date}', { date: new Date(r.createdAt).toLocaleDateString('zh-CN') }),
      at: r.createdAt,
      resume: r,
    })),
    ...goals.map((g) => ({
      key: `goal:${g.id}`,
      kind: 'goal' as const,
      title: g.name,
      meta: g.companyName ? t('公司：{company}', { company: g.companyName }) : t('未填写公司'),
      at: g.createdAt,
      goal: g,
    })),
    ...materials.map((m) => ({
      key: `material:${m.id}`,
      kind: 'material' as const,
      title: m.name,
      meta: m.entries.length > 0 ? t('{count} 条预设问答', { count: m.entries.length }) : t('自由资料 {count} 字', { count: m.content.length }),
      at: m.updatedAt,
      material: m,
    })),
  ]
    .filter((item) => typeFilter === 'all' || item.kind === typeFilter)
    .filter((item) => item.title.toLowerCase().includes(search.trim().toLowerCase()))
    .sort((a, b) => b.at - a.at);
  const detail = items.find((item) => item.key === selectedKey) ?? items[0] ?? null;
  const kindLabel = (kind: 'resume' | 'goal' | 'material') =>
    kind === 'resume' ? t('简历') : kind === 'goal' ? t('岗位') : t('面试资料');
  const filters = [
    { key: 'all' as const, label: t('全部') },
    { key: 'resume' as const, label: t('简历') },
    { key: 'goal' as const, label: t('岗位') },
    { key: 'material' as const, label: t('面试资料') },
  ];
  const useHere = (item: NonNullable<typeof detail>) => {
    if ('resume' in item) setPendingResumeId(item.resume.id);
    else if ('goal' in item) setPendingGoalId(item.goal.id);
    else if (!pendingMaterialIds.includes(item.material.id)) setPendingMaterialIds([...pendingMaterialIds, item.material.id]);
    showToast({ type: 'success', title: t('已用于这一场面试') });
    onNavigate?.('interview');
  };

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-line bg-surface-sunken p-0.5">
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTypeFilter(item.key)}
              aria-pressed={typeFilter === item.key}
              className={`rounded-md px-3 py-1 text-[12px] transition-colors ${typeFilter === item.key ? 'bg-surface-raised font-medium shadow-card' : 'text-ink-muted hover:text-ink'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-[var(--mx-selection-bg)] px-2 py-1 text-[11px] text-[var(--mx-selection-text)]">{t('本机存储')}</span>
          <Button size="sm" variant="outline" onClick={() => setGoalDialog({ open: true })}>
            <Plus size={13} />
            {t('新建岗位')}
          </Button>
          <Button
            size="sm"
            disabled={uploading}
            onClick={() => {
              // 在「岗位」筛选下，导入的对象很明确，直接选文件，省掉一次选择。
              if (typeFilter === 'goal') {
                setImportKind('goal');
                fileRef.current?.click();
                return;
              }
              setImportChoice(true);
            }}
          >
            <Upload size={13} />
            {typeFilter === 'goal' ? t('导入岗位') : t('导入资料')}
          </Button>
        </div>
      </div>

      <div className="grid h-[calc(100vh-268px)] min-h-[360px] grid-cols-[230px_minmax(0,1fr)] items-stretch gap-6">
        <div className="flex h-full min-h-0 flex-col gap-1 overflow-y-auto pr-1">
          <label className="mb-2 flex items-center gap-2 rounded-lg border border-line bg-surface-raised px-3">
            <Search size={14} className="shrink-0 text-ink-muted" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('搜索资料')}
              aria-label={t('搜索资料')}
              className="h-10 w-full min-w-0 bg-transparent text-[12px] outline-none"
            />
          </label>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setSelectedKey(item.key)}
              aria-pressed={detail?.key === item.key}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${detail?.key === item.key ? 'border-line bg-surface-raised shadow-card' : 'border-transparent hover:bg-[var(--mx-action-secondary-hover)]'}`}
            >
              <div className="truncate text-[13px] font-medium leading-5" title={item.title}>{item.title}</div>
              <div className="mt-0.5 text-[11px] leading-[18px] text-ink-muted">{kindLabel(item.kind)}<br />{item.meta}</div>
            </button>
          ))}
          {items.length === 0 && <p className="px-1 text-[11px] text-ink-muted">{t('没有匹配的资料。')}</p>}
        </div>

        <div className="h-full min-h-0 overflow-y-auto">
          {detail ? (
            <article className="rounded-xl border border-line bg-surface-raised p-6 shadow-card">
              <div className="flex items-start justify-between gap-3 border-b border-line pb-4">
                <div className="min-w-0">
                  <span className="inline-flex rounded-md bg-[var(--mx-selection-bg)] px-2 py-1 text-[11px] text-[var(--mx-selection-text)]">{kindLabel(detail.kind)}</span>
                  <h3 className="mt-3 text-[18px] font-semibold leading-[26px]">{detail.title}</h3>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    if ('resume' in detail) setPreviewResume(detail.resume);
                    else if ('goal' in detail) setGoalDialog({ open: true, goal: detail.goal });
                    else setEditorId(detail.material.id);
                  }}
                >
                  <Pencil size={13} />
                  {t('编辑')}
                </Button>
              </div>

              {'resume' in detail && (
                <>
                  <p className="mt-4 text-[12px] leading-[22px] text-ink-muted">{detail.meta}</p>
                  <p className="mt-4 whitespace-pre-wrap text-[12px] leading-[22px] text-ink">
                    {(detail.resume.summary || detail.resume.content || '').slice(0, 1200) || t('这份简历还没有正文。')}
                  </p>
                </>
              )}
              {'goal' in detail && (
                <>
                  <p className="mt-4 text-[12px] leading-[22px] text-ink-muted">
                    {t('公司：{company} · 创建于 {date}', { company: detail.goal.companyName || t('未填写'), date: new Date(detail.goal.createdAt).toLocaleDateString('zh-CN') })}
                  </p>
                  <p className="mt-4 whitespace-pre-wrap text-[12px] leading-[22px] text-ink">
                    {detail.goal.description || t('这个岗位还没有填写 JD。')}
                  </p>
                </>
              )}
              {'material' in detail && (
                <>
                  <p className="mt-4 text-[12px] leading-[22px] text-ink-muted">
                    {detail.meta}{' · '}{t('更新于 {date}', { date: new Date(detail.material.updatedAt).toLocaleDateString('zh-CN') })}
                  </p>
                  <p className="mt-4 whitespace-pre-wrap text-[12px] leading-[22px] text-ink">
                    {(detail.material.content || detail.material.entries.map((entry: { answer: string }) => entry.answer).join('\n\n') || '').slice(0, 1600) || t('这份资料还没有内容。')}
                  </p>
                </>
              )}

              <div className="mt-6 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => useHere(detail)}>
                  <Check size={13} />
                  {t('用于这一场')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if ('resume' in detail) setDeleting({ kind: 'resume', id: detail.resume.id, name: detail.resume.title });
                    else if ('goal' in detail) setDeleting({ kind: 'goal', id: detail.goal.id, name: detail.goal.name });
                    else setDeleting({ kind: 'material', id: detail.material.id, name: detail.material.name });
                  }}
                >
                  <Trash2 size={13} />
                  {t('删除')}
                </Button>
              </div>
            </article>
          ) : (
            <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-[12px] text-ink-muted">
              {t('还没有资料。导入简历或新建岗位，面试时就能直接选。')}
            </div>
          )}
        </div>
      </div>

      <Dialog open={importChoice} onClose={() => setImportChoice(false)} width={420}>
        <DialogTitle>{t('导入资料')}</DialogTitle>
        <DialogDesc>{t('选择这份文件的用途，导入后可以再改。')}</DialogDesc>
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="outline" onClick={() => { setImportChoice(false); setImportKind('resume'); fileRef.current?.click(); }}>
            <FileText size={13} />
            {t('导入为简历')}
          </Button>
          <Button variant="outline" onClick={() => { setImportChoice(false); setImportKind('material'); fileRef.current?.click(); }}>
            <Layers size={13} />
            {t('导入为面试资料')}
          </Button>
          <Button variant="outline" onClick={() => { setImportChoice(false); setImportKind('goal'); fileRef.current?.click(); }}>
            <Briefcase size={13} />
            {t('导入为岗位')}
          </Button>
        </div>
      </Dialog>

      <input
        ref={fileRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        className="hidden"
        aria-label={t('选择要导入的文件')}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          if (picked) {
            setImportFile(picked);
            setUploading(true);
          }
          event.target.value = '';
        }}
      />

      {(importFile || previewResume) && <DocumentImportDialog
        file={importFile || undefined}
        title={importKind === 'material' && importFile ? t('导入面试资料') : importKind === 'goal' && importFile ? t('导入岗位') : t('检查简历正文')}
        initial={previewResume ? { name: previewResume.document?.name || previewResume.title, text: previewResume.content || previewResume.summary || '',
          pages: previewResume.document?.pages || 1, method: previewResume.document?.method || 'text', importedAt: previewResume.document?.importedAt || previewResume.createdAt } : undefined}
        onClose={() => { setImportFile(null); setPreviewResume(null); setUploading(false); }}
        onSave={async document => {
          if (importKind === 'material' && importFile) {
            await saveMaterial({ name: document.name.replace(/\.[^.]+$/, ''), source: 'file', content: document.text });
          } else if (importKind === 'goal' && importFile) {
            const goal = await saveGoal({
              name: document.name.replace(/\.[^.]+$/, ''),
              companyName: companyFromJd(document.text),
              description: document.text,
            });
            setSelectedKey(`goal:${goal.id}`);
            setTypeFilter('goal');
            showToast({ type: 'success', title: t('岗位已导入'), description: t('名称与公司可以在右侧编辑修改。') });
          } else {
            const { text, ...metadata } = document;
            await saveResume({ id: previewResume?.id, title: previewResume?.title || document.name.replace(/\.[^.]+$/, ''),
              content: text, summary: text.slice(0, 6000), document: metadata });
          }
          showToast({ type: 'success', title: t('正文已保存') });
        }}
      />}
      {goalDialog.open && (
        <GoalDialog
          goal={goalDialog.goal}
          onClose={() => setGoalDialog({ open: false })}
        />
      )}
      {editorId && <MaterialEditor id={editorId} onClose={() => setEditorId(null)} />}
      <ConfirmDialog
        open={deleting != null}
        title={
          deleting?.kind === 'resume' ? t('删除简历') : deleting?.kind === 'goal' ? t('删除岗位') : t('删除面试资料')
        }
        body={t('删除后无法恢复，确定删除「{name}」吗？', { name: deleting?.name ?? '' })}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
          if (deleting.kind === 'resume') await deleteResume(deleting.id);
          else if (deleting.kind === 'goal') await deleteGoal(deleting.id);
          else await deleteMaterial(deleting.id);
          setDeleting(null);
          } catch(error) {showToast({type:'error',title:t('删除未完成，请重试'),description:String((error as Error).message||error)});}
        }}
      />
    </div>
  );
}

function GoalDialog({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const savingRef=useRef(false);
  const [name, setName] = useState(goal?.name ?? '');
  const [company, setCompany] = useState(goal?.companyName ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  return (
    <Dialog open onClose={onClose} dismissable={!saving} className="max-w-md">
      <DialogTitle>{goal ? t('编辑岗位') : t('新建岗位')}</DialogTitle>
      {error&&<p role="alert" className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          {t('岗位名称')}
          <Input disabled={saving} className="mt-1" placeholder={t('岗位名称')} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          {t('公司')}
          <Input disabled={saving} className="mt-1" placeholder={t('公司')} value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          {t('JD / 面试方向')}
          <Textarea
            className="mt-1"
            rows={6}
            disabled={saving}
            placeholder={t('把岗位 JD 粘进来，AI 会按这个方向组织回答')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>
          {t('取消')}
        </Button>
        <Button
          size="sm"
          disabled={saving||!name.trim()}
          onClick={async () => {
            if(savingRef.current)return;savingRef.current=true;setSaving(true);setError('');
            try {
            await saveGoal({ id: goal?.id, name: name.trim(), companyName: company.trim(), description });
            onClose();
            }catch(error){setError(t('保存失败，输入已保留：{message}', { message: String((error as Error).message||error) }));}
            finally{savingRef.current=false;setSaving(false);}
          }}
        >
          {saving?t('正在保存…'):t('保存')}
        </Button>
      </div>
    </Dialog>
  );
}

function MaterialEditor({ id, onClose }: { id: string; onClose: () => void }) {
  const [materials] = useData<Material[]>('materials', []);
  const material = materials.find((m) => m.id === id);
  const [name, setName] = useState(material?.name ?? '');
  const [content, setContent] = useState(material?.content ?? '');
  const [q, setQ] = useState('');
  const [a, setA] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [entrySaving, setEntrySaving] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [preparationResumes]=useData<Resume[]>('resumes',[]);
  const [preparationGoals]=useData<Goal[]>('goals',[]);
  const [preparationResumeId,setPreparationResumeId]=useState('');
  const [preparationGoalId,setPreparationGoalId]=useState('');
  const [generating, setGenerating] = useState(false);

  if (!material) return null;

  const dirty = name !== (material?.name ?? '') || content !== (material?.content ?? '');

  const save = async (): Promise<boolean> => {
    try {
    await saveMaterial({ id, name: name.trim() || t('未命名资料'), content });
    showToast({ type: 'success', title: t('已保存') });
    return true;
    }catch(error){showToast({type:'error',title:t('资料保存失败，输入已保留'),description:String((error as Error).message||error)});return false;}
  };
  // 「完成」= 保存并关闭：有未保存改动时先落盘，保存失败就留在编辑器里，不能静默丢弃。
  const finish = async () => { if (!dirty || await save()) onClose(); };
  // Esc 和点遮罩也走同一道门：有改动先问一句，别让输入静默消失。
  const [confirm, confirmDialog] = useConfirm();
  const requestClose = async () => {
    if (dirty && !(await confirm({ title: t('有未保存的改动，确定放弃？') }))) return;
    onClose();
  };

  return (
    <Dialog open onClose={requestClose} className="max-w-2xl">
      <DialogTitle>{t('编辑面试资料')}</DialogTitle>
      {confirmDialog}
      <div className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          {t('资料名称')}
          <Input className="mt-1" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          {t('自由资料（选填）')}
          <Textarea
            className="mt-1"
            rows={7}
            maxLength={90000}
            placeholder={t('项目经历 / 业务背景 / 专业资料')}
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('{count}/90000 字，改完点保存', { count: content.length })}
          </span>
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('预设问答（{count}）', { count: material.entries.length })}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setGenOpen(true)}>
                {t('AI 出题')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditId(null);
                  setQ('');
                  setA('');
                  setAddOpen(true);
                }}
              >
                <Plus size={12} />
                {t('添加')}
              </Button>
            </div>
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            {t('面试官问到相似问题时，AI 会优先照你预设的答案回答。')}
          </p>
          {material.entries.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              {t('还没有问答。可以让 AI 按简历生成，或粘贴已整理好的问答')}
            </p>
          ) : (
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {material.entries.map((e) => (
                <div key={e.id} className="rounded-md border p-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="line-clamp-2 text-xs font-medium">{e.question}</div>
                      <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{e.answer}</div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        type="button"
                        className="text-[11px] text-primary hover:underline"
                        onClick={() => {
                          setEditId(e.id);
                          setQ(e.question);
                          setA(e.answer);
                          setAddOpen(true);
                        }}
                      >
                        {t('编辑')}
                      </button>
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => void deleteEntry(id, e.id).catch(error=>showToast({type:'error',title:t('删除失败，请重试'),description:String(error)}))}
                      >
                        {t('删除')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 flex justify-between">
        <Button size="sm" variant="ghost" onClick={() => void finish()}>
          {t('完成')}
        </Button>
        <Button size="sm" onClick={() => void save()}>
          {t('保存')}
        </Button>
      </div>

      {/* 添加/编辑问答 */}
      {addOpen && (
        <Dialog open onClose={() => { if (!entrySaving) setAddOpen(false); }}>
          <DialogTitle>{editId ? t('编辑问答') : t('添加问答')}</DialogTitle>
          <DialogDesc>{t('面试官问到相似问题时，AI 会优先照你预设的答案回答。')}</DialogDesc>
          <div className="flex flex-col gap-3">
            <label className="text-xs font-medium text-muted-foreground">
              {t('问题')}
              <Textarea
                className="mt-1"
                rows={2}
                maxLength={2000}
                placeholder={t('例如：请做一个简短的自我介绍')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              {t('参考答案')}
              <Textarea
                className="mt-1"
                rows={8}
                maxLength={8000}
                placeholder={t('用你自己的真实经历和数据作答，越具体越好')}
                value={a}
                onChange={(e) => setA(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">{t('答案 {count}/8000 字', { count: a.length })}</span>
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" disabled={entrySaving} onClick={() => setAddOpen(false)}>
              {t('取消')}
            </Button>
            <Button
              size="sm"
              disabled={!q.trim() || !a.trim() || entrySaving}
              onClick={async () => {
                if (entrySaving) return;
                setEntrySaving(true);
                try {
                // 编辑必须带回原条目 id，否则会被当成新增，原文案重复一份。
                await saveEntry(id, { id: editId ?? undefined, question: q.trim(), answer: a.trim() });
                setQ('');
                setA('');
                setEditId(null);
                setAddOpen(false);
                }catch(error){showToast({type:'error',title:t('问答保存失败，输入已保留'),description:String((error as Error).message||error)});}
                finally{setEntrySaving(false);}
              }}
            >
              {entrySaving ? t('正在保存…') : t('保存')}
            </Button>
          </div>
        </Dialog>
      )}

      {/* AI 出题 */}
      {genOpen && (
        <Dialog open onClose={() => setGenOpen(false)}>
          <DialogTitle>{t('AI 生成问答')}</DialogTitle>
          <DialogDesc>{t('选择简历与岗位生成练习题。结果是 AI 准备建议，不代表真实题频或已确认个人经历。')}</DialogDesc>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <label className="text-xs">{t('参考简历')}<Select aria-label={t('出题参考简历')} value={preparationResumeId} onChange={e=>setPreparationResumeId(e.target.value)}><option value="">{t('不使用个人简历')}</option>{preparationResumes.map(resume=><option key={resume.id} value={resume.id}>{resume.title}</option>)}</Select></label>
            <label className="text-xs">{t('目标岗位')}<Select aria-label={t('出题目标岗位')} value={preparationGoalId} onChange={e=>setPreparationGoalId(e.target.value)}><option value="">{t('通用技术练习')}</option>{preparationGoals.map(goal=><option key={goal.id} value={goal.id}>{goal.name}</option>)}</Select></label>
          </div>
          <div className="flex gap-2">
            {[5, 8, 12].map((n) => (
              <Button
                key={n}
                size="sm"
                variant="outline"
                disabled={generating}
                onClick={async () => {
                  setGenerating(true);
                  try {
                    const parsed=await generatePreparation({count:n,
                      resume:preparationResumes.find(resume=>resume.id===preparationResumeId),
                      goal:preparationGoals.find(goal=>goal.id===preparationGoalId),materials:material?[material]:[]});
                    for (const item of parsed.slice(0, n)) {
                      await saveEntry(id, { question: item.question, answer: item.answer,origin:'model_generated' });
                    }
                    showToast({ type: 'success', title: t('已生成 {count} 条问答', { count: Math.min(parsed.length, n) }) });
                    setGenOpen(false);
                  } catch (e) {
                    showToast({ type: 'error', title: t('生成失败：{message}', { message: String((e as Error).message ?? e) }) });
                  } finally {
                    setGenerating(false);
                  }
                }}
              >
                {generating ? t('AI 生成中…') : t('{count} 条', { count: n })}
              </Button>
            ))}
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
