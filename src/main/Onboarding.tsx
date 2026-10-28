/*
 * 首次引导向导（对齐原版 kB）：简历 → 岗位 → 开始体验，三步。
 */
import { useRef, useState } from 'react';
import { Button, Card, Input } from '@/ui/primitives';
import { saveGoal, saveResume, useData, type Goal, type Resume } from '@/lib/backend';
import { useAiReady } from '@/lib/aiSettings';
import { DocumentImportDialog } from './DocumentImportDialog';
import { DOCUMENT_ACCEPT } from '@/lib/documentIngest';

const STEPS = ['简历', '岗位', '开始体验'] as const;

export function Onboarding({ onFinish }: { onFinish: (ownData: boolean) => void | Promise<void> }) {
  const aiReady = useAiReady();
  const [step, setStep] = useState(0);
  const [ownData, setOwnData] = useState(false);
  const resumes = useData<Resume[]>('resumes', [])[0];
  const goals = useData<Goal[]>('goals', [])[0];
  const [goalName, setGoalName] = useState('');
  const [company, setCompany] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);

  const realResume = resumes.find((r) => !r.isSample);

  const saveJob = async () => {
    if (!goalName.trim()) return;
    await saveGoal({ name: goalName.trim(), companyName: company.trim() });
    setOwnData(true);
    setStep(2);
  };

  return (
    <div className="mx-auto max-w-xl py-8">
      {/* 进度条 */}
      <div className="mb-6 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ${
                i <= step ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
              }`}
            >
              {i + 1}
            </span>
            <span className={`text-sm ${i === step ? 'font-medium' : 'text-muted-foreground'}`}>{s}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-10 bg-border" />}
          </div>
        ))}
        <div className="flex-1" />
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void onFinish(ownData)}
        >
          跳过引导
        </button>
      </div>

      <h1 className="text-xl font-semibold">你好</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        花一两分钟跟着做完，第一场面试就不会手忙脚乱。
      </p>

      {step === 0 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">先传一份你的简历</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 会照着你的项目和技术栈来答，还能顺手认出你要面的岗位。
          </p>
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
          <div className="mt-4 flex flex-col gap-2">
            <Button
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? '正在读取简历…' : '点击选择简历文件'}
            </Button>
            <div className="text-center text-[11px] text-muted-foreground">支持 PDF、照片和扫描件</div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep(1)}
            >
              {realResume ? '暂不上传' : '暂不上传，先用示例简历'}
            </Button>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">你要面的是什么岗位？</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 按岗位判断面试官在问什么、该往哪个方向答。
          </p>
          <div className="mt-4 flex flex-col gap-3">
            <Input
              placeholder="岗位名称，例如 后端工程师"
              value={goalName}
              onChange={(e) => setGoalName(e.target.value)}
            />
            <Input placeholder="公司（选填）" value={company} onChange={(e) => setCompany(e.target.value)} />
            <div className="flex justify-between">
              <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                暂不填写，先用「{goals[0]?.name ?? '默认岗位'}」
              </Button>
              <Button disabled={!goalName.trim()} onClick={() => void saveJob()}>
                下一步
              </Button>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card className="p-5">
          <h2 className="text-base font-semibold">想先体验哪一个？</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            挑一个马上开一场，跟着浮窗里的提示用演示内容跑一遍，就知道怎么用了。
          </p>
          {!aiReady && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
              开始前先到「设置 → AI 服务」配置你的接口地址与密钥，浮窗才能出答案。
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3">
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
              onClick={() => {
                void onFinish(ownData);
                window.dispatchEvent(new CustomEvent('ml-nav', { detail: 'interview' }));
              }}
            >
              <div className="text-sm font-semibold">实时面试</div>
              <div className="mt-1 text-xs text-muted-foreground">面试官一说话，浮窗里就出参考回答</div>
              <div className="mt-2 text-[11px] text-muted-foreground">同时打开一个演示页，放一段面试官提问试试</div>
            </button>
            <button
              type="button"
              className="rounded-lg border p-4 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
              onClick={() => {
                void onFinish(ownData);
                window.dispatchEvent(new CustomEvent('ml-nav', { detail: 'exam' }));
              }}
            >
              <div className="text-sm font-semibold">笔试答题</div>
              <div className="mt-1 text-xs text-muted-foreground">题目在屏幕上，截一下就出答案</div>
              <div className="mt-2 text-[11px] text-muted-foreground">同时打开一个模拟笔试，对着题目截一张试试</div>
            </button>
          </div>
        </Card>
      )}

      <div className="mt-4 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {

            void onFinish(ownData);
          }}
        >
          完成引导
        </Button>
      </div>
      {importFile && <DocumentImportDialog file={importFile} title="检查简历正文"
        onClose={() => { setImportFile(null); setUploading(false); }}
        onSave={async document => {
          const { text, ...metadata } = document;
          await saveResume({ title: document.name.replace(/\.[^.]+$/, ''), summary: text.slice(0, 6000), content: text, document: metadata });
          setOwnData(true); setStep(1);
        }} />}
    </div>
  );
}
