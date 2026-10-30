/*
 * 资料管理（对齐原版 pH）：简历 / 岗位 / 面试资料三区块，
 * 含新建岗位弹窗、资料编辑器（自由资料 + 预设问答 + AI 生成）。
 */
import { useRef, useState } from 'react';
import { FileText, Plus, Trash2, Upload } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  DialogDesc,
  DialogTitle,
  Input,
  SectionHeader,
  Select,
  Textarea,
  showToast,
} from '@/ui/primitives';
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
import { DocumentImportDialog } from '../DocumentImportDialog';
import { DOCUMENT_ACCEPT } from '@/lib/documentIngest';

export function ResourcePage() {
  const [resumes] = useData<Resume[]>('resumes', []);
  const [goals] = useData<Goal[]>('goals', []);
  const [materials] = useData<Material[]>('materials', []);

  const [goalDialog, setGoalDialog] = useState<{ open: boolean; goal?: Goal }>({ open: false });
  const [editorId, setEditorId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ kind: 'resume' | 'goal' | 'material'; id: string; name: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [previewResume, setPreviewResume] = useState<Resume | null>(null);
  const [importKind, setImportKind] = useState<'resume' | 'material'>('resume');

  return (
    <div className="flex flex-col gap-4">
      {/* 简历 */}
      <Card className="p-5">
        <SectionHeader
          title="简历"
          desc="上传 PDF / 图片 / 文本；AI 会照着你的经历组织回答。"
          right={
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => { setImportKind('resume'); fileRef.current?.click(); }}>
              <Upload size={13} />
              {uploading ? '上传中…' : '上传简历'}
            </Button>
          }
        />
        <input
          ref={fileRef}
          type="file"
          accept={DOCUMENT_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) { setImportFile(f); setUploading(true); }
            e.target.value = '';
          }}
        />
        {resumes.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有简历，先上传一份 PDF</p>
        ) : (
          <div className="divide-y">
            {resumes.map((r) => (
              <div key={r.id} className="flex items-center justify-between py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm">
                    <FileText size={13} className="text-muted-foreground" />
                    <button className="truncate text-left hover:underline" title="查看或编辑简历正文" onClick={() => setPreviewResume(r)}>{r.title}</button>
                    {r.isSample && <Badge variant="secondary">示例</Badge>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    上传于 {new Date(r.createdAt).toLocaleDateString('zh-CN')}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleting({ kind: 'resume', id: r.id, name: r.title })}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 岗位 */}
      <Card className="p-5">
        <SectionHeader
          title="岗位"
          desc="岗位决定 AI 往哪个方向答；可以填 JD。"
          right={
            <Button size="sm" variant="outline" onClick={() => setGoalDialog({ open: true })}>
              <Plus size={13} />
              新建岗位
            </Button>
          }
        />
        {goals.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有岗位，新建一个再开始面试</p>
        ) : (
          <div className="divide-y">
            {goals.map((g) => (
              <div key={g.id} className="flex items-start justify-between py-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {g.name}
                    {g.companyName && <span className="ml-1.5 text-xs text-muted-foreground">· {g.companyName}</span>}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    公司：{g.companyName || '未填写'} · 创建于{' '}
                    {new Date(g.createdAt).toLocaleDateString('zh-CN')}
                  </div>
                  {g.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{g.description}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setGoalDialog({ open: true, goal: g })}>
                    编辑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting({ kind: 'goal', id: g.id, name: g.name })}>
                    <Trash2 size={13} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* 面试资料 */}
      <Card className="p-5">
        <SectionHeader
          title="面试资料"
          desc="项目经历、标准问答、业务背景都可以放这里；面试时 AI 会优先参考。"
          right={
            <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={uploading} onClick={() => { setImportKind('material'); fileRef.current?.click(); }}><Upload size={13} />导入文件</Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const m = await saveMaterial({ name: '未命名资料', source: 'manual' });
                setEditorId(m.id);
              }}
            >
              <Plus size={13} />
              新建资料
            </Button>
            </div>
          }
        />
        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            还没有面试资料。项目经历、标准问答、业务背景都可以放这里
          </p>
        ) : (
          <div className="divide-y">
            {materials.map((m) => (
              <div key={m.id} className="flex items-center justify-between py-2">
                <button type="button" className="min-w-0 text-left" onClick={() => setEditorId(m.id)}>
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="truncate">{m.name}</span>
                    <Badge variant="secondary">
                      {m.source === 'official' ? '官方' : m.source === 'ai' ? 'AI 生成' : m.source === 'file' ? '文件导入' : '自建'}
                    </Badge>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {m.entries.length > 0 ? `${m.entries.length} 条预设问答` : `自由资料 ${m.content.length} 字`}
                    {' · '}更新于 {new Date(m.updatedAt).toLocaleDateString('zh-CN')}
                  </div>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDeleting({ kind: 'material', id: m.id, name: m.name })}
                >
                  <Trash2 size={13} />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {(importFile || previewResume) && <DocumentImportDialog
        file={importFile || undefined}
        title={importKind === 'material' && importFile ? '导入面试资料' : '检查简历正文'}
        initial={previewResume ? { name: previewResume.document?.name || previewResume.title, text: previewResume.content || previewResume.summary || '',
          pages: previewResume.document?.pages || 1, method: previewResume.document?.method || 'text', importedAt: previewResume.document?.importedAt || previewResume.createdAt } : undefined}
        onClose={() => { setImportFile(null); setPreviewResume(null); setUploading(false); }}
        onSave={async document => {
          if (importKind === 'material' && importFile) {
            await saveMaterial({ name: document.name.replace(/\.[^.]+$/, ''), source: 'file', content: document.text });
          } else {
            const { text, ...metadata } = document;
            await saveResume({ id: previewResume?.id, title: previewResume?.title || document.name.replace(/\.[^.]+$/, ''),
              content: text, summary: text.slice(0, 6000), document: metadata });
          }
          showToast({ type: 'success', title: '正文已保存' });
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
          deleting?.kind === 'resume' ? '删除简历' : deleting?.kind === 'goal' ? '删除岗位' : '删除面试资料'
        }
        body={`删除后无法恢复，确定删除「${deleting?.name ?? ''}」吗？`}
        onCancel={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          if (deleting.kind === 'resume') await deleteResume(deleting.id);
          else if (deleting.kind === 'goal') await deleteGoal(deleting.id);
          else await deleteMaterial(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}

function GoalDialog({ goal, onClose }: { goal?: Goal; onClose: () => void }) {
  const [name, setName] = useState(goal?.name ?? '');
  const [company, setCompany] = useState(goal?.companyName ?? '');
  const [description, setDescription] = useState(goal?.description ?? '');
  return (
    <Dialog open onClose={onClose} className="max-w-md">
      <DialogTitle>{goal ? '编辑岗位' : '新建岗位'}</DialogTitle>
      <div className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          岗位名称
          <Input className="mt-1" placeholder="岗位名称" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          公司
          <Input className="mt-1" placeholder="公司" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          JD / 面试方向
          <Textarea
            className="mt-1"
            rows={6}
            placeholder="把岗位 JD 粘进来，AI 会按这个方向组织回答"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          size="sm"
          disabled={!name.trim()}
          onClick={async () => {
            await saveGoal({ id: goal?.id, name: name.trim(), companyName: company.trim(), description });
            onClose();
          }}
        >
          保存
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
  const [genOpen, setGenOpen] = useState(false);
  const [preparationResumes]=useData<Resume[]>('resumes',[]);
  const [preparationGoals]=useData<Goal[]>('goals',[]);
  const [preparationResumeId,setPreparationResumeId]=useState('');
  const [preparationGoalId,setPreparationGoalId]=useState('');
  const [generating, setGenerating] = useState(false);

  if (!material) return null;

  const save = async () => {
    await saveMaterial({ id, name: name.trim() || '未命名资料', content });
    showToast({ type: 'success', title: '已保存' });
  };

  return (
    <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogTitle>编辑面试资料</DialogTitle>
      <div className="flex flex-col gap-3">
        <label className="text-xs font-medium text-muted-foreground">
          资料名称
          <Input className="mt-1" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          自由资料（选填）
          <Textarea
            className="mt-1"
            rows={7}
            maxLength={90000}
            placeholder="项目经历 / 业务背景 / 专业资料"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {content.length}/90000 字，改完点保存
          </span>
        </label>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              预设问答（{material.entries.length}）
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setGenOpen(true)}>
                AI 出题
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                <Plus size={12} />
                添加
              </Button>
            </div>
          </div>
          <p className="mb-2 text-[11px] text-muted-foreground">
            面试官问到相似问题时，AI 会优先照你预设的答案回答。
          </p>
          {material.entries.length === 0 ? (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              还没有问答。可以让 AI 按简历生成，或粘贴已整理好的问答
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
                          setQ(e.question);
                          setA(e.answer);
                          setAddOpen(true);
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="text-[11px] text-muted-foreground hover:text-destructive"
                        onClick={() => void deleteEntry(id, e.id)}
                      >
                        删除
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
        <Button size="sm" variant="ghost" onClick={onClose}>
          完成
        </Button>
        <Button size="sm" onClick={() => void save()}>
          保存
        </Button>
      </div>

      {/* 添加/编辑问答 */}
      {addOpen && (
        <Dialog open onClose={() => setAddOpen(false)}>
          <DialogTitle>{q ? '编辑问答' : '添加问答'}</DialogTitle>
          <DialogDesc>面试官问到相似问题时，AI 会优先照你预设的答案回答。</DialogDesc>
          <div className="flex flex-col gap-3">
            <label className="text-xs font-medium text-muted-foreground">
              问题
              <Textarea
                className="mt-1"
                rows={2}
                maxLength={2000}
                placeholder="例如：请做一个简短的自我介绍"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-muted-foreground">
              参考答案
              <Textarea
                className="mt-1"
                rows={8}
                maxLength={8000}
                placeholder="用你自己的真实经历和数据作答，越具体越好"
                value={a}
                onChange={(e) => setA(e.target.value)}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">答案 {a.length}/8000 字</span>
            </label>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setAddOpen(false)}>
              取消
            </Button>
            <Button
              size="sm"
              disabled={!q.trim() || !a.trim()}
              onClick={async () => {
                await saveEntry(id, { question: q.trim(), answer: a.trim() });
                setQ('');
                setA('');
                setAddOpen(false);
              }}
            >
              保存
            </Button>
          </div>
        </Dialog>
      )}

      {/* AI 出题 */}
      {genOpen && (
        <Dialog open onClose={() => setGenOpen(false)}>
          <DialogTitle>AI 生成问答</DialogTitle>
          <DialogDesc>选择简历与岗位生成练习题。结果是 AI 准备建议，不代表真实题频或已确认个人经历。</DialogDesc>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <label className="text-xs">参考简历<Select aria-label="出题参考简历" value={preparationResumeId} onChange={e=>setPreparationResumeId(e.target.value)}><option value="">不使用个人简历</option>{preparationResumes.map(resume=><option key={resume.id} value={resume.id}>{resume.title}</option>)}</Select></label>
            <label className="text-xs">目标岗位<Select aria-label="出题目标岗位" value={preparationGoalId} onChange={e=>setPreparationGoalId(e.target.value)}><option value="">通用技术练习</option>{preparationGoals.map(goal=><option key={goal.id} value={goal.id}>{goal.name}</option>)}</Select></label>
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
                    showToast({ type: 'success', title: `已生成 ${Math.min(parsed.length, n)} 条问答` });
                    setGenOpen(false);
                  } catch (e) {
                    showToast({ type: 'error', title: `生成失败：${String((e as Error).message ?? e)}` });
                  } finally {
                    setGenerating(false);
                  }
                }}
              >
                {generating ? 'AI 生成中…' : `${n} 条`}
              </Button>
            ))}
          </div>
        </Dialog>
      )}
    </Dialog>
  );
}
