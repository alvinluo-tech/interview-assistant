import { useAiReady } from '@/lib/aiSettings';
/*
 * 笔试工作台：模式三选卡、岗位、答题偏好折叠、
 * 双机位/快捷键提示/复制按钮开关、开始笔试。
 */
import { useEffect, useState } from 'react';
import { getPlatformCapabilities, isTauri, type PlatformCapabilities } from '@/lib/bridge';
import { Check, Copy, FolderPlus, Keyboard, Laptop, Layers, Monitor, MonitorSmartphone, Play, SlidersHorizontal, Sparkles, Target, Video, Zap } from 'lucide-react';
import { Badge, Button, Input, Select, Switch, Textarea, showToast } from '@/ui/primitives';
import { DisclosureLine, SettingLine } from './SettingLine';
import { useData, saveGoal, readData, updateExamSession, type Goal, type ExamSessionRecord } from '@/lib/backend';
import { useSetting, setSetting } from '@/lib/store';
import { t } from '@/lib/i18n';

import {
  EXAM_MODES,
  EXAM_MODE_ORDER,
  customizationSummary,
  type ExamModeKey,
} from '@/lib/examEngine';
import { startOverlayFlow } from '../MainWindow';
import {CodeVerificationPanel} from '../CodeVerificationPanel';
import { DualCameraSwitch } from '@/lib/dualCamera';
import { DualScreenCard } from './DualScreenCard';

export function ExamWorkbench(_props: { onNavigate: (s: string) => void }) {
  const goals = useData<Goal[]>('goals', [])[0];
  const examSessions = useData<ExamSessionRecord[]>('examSessions', [])[0];
  const interrupted = examSessions.find(session => (session.interrupted || session.status==='ACTIVE') && !session.interviewSessionId);
  const [mode, setMode] = useSetting<ExamModeKey>('exam.mode', 'quick');
  const [goalId, setGoalId] = useSetting<string | null>('exam.goalId', goals[0]?.id ?? null);
  const [showCopyCode, setShowCopyCode] = useSetting('exam.showCopyCodeButton', false);
  const [showHints, setShowHints] = useSetting('interview.showHotkeyHints', true);
  const [compatibility,setCompatibility]=useSetting('capture.compatibilityMode',false);
  const [captureMode,setCaptureMode]=useSetting('capture.mode','screen');
  const [customization, setCustomization] = useSetting<Record<string, unknown>>('exam.customization', {});
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [newGoal, setNewGoal] = useState('');
  const [newCompany, setNewCompany] = useState('');
  const aiReady = useAiReady('vision');
  const [platform, setPlatform] = useState<PlatformCapabilities | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    void getPlatformCapabilities().then(value => { if (active) setPlatform(value); }).catch(() => {});
    return () => { active = false; };
  }, []);

  const start = async (resume?: ExamSessionRecord) => {
    if (starting) return;
    setStarting(true);
    let reactivated = false;
    try {
      // 上一场如果还挂着（崩溃/强退留下的），先收尾再开新场
      const stale = readData<{ id: string; status: string }[]>('examSessions', []).filter(
        (s) => s.status === 'ACTIVE',
      );
      if (stale.length > 0) {
        const { closeStaleActiveSessions } = await import('@/lib/backend');
        await closeStaleActiveSessions();
      }
      const selectedGoal = resume ? (resume.goalId ?? null) : goalId;
      await setSetting('exam.mode', resume?.mode ?? mode);
      if (resume) { await updateExamSession(resume.id, {status:'ACTIVE',endedAt:null,interrupted:false}); reactivated = true; }
      await setSetting('exam.pendingConfig', {runId:crypto.randomUUID(),goalId:selectedGoal,...(resume ? {resumeSessionId:resume.id} : {})});
      await startOverlayFlow('exam', selectedGoal);
      showToast({ type: 'success', title: t('笔试浮窗已启动'), description: t('把题目放到屏幕上，悬停「解题」即可。') });
    } catch (e) {
      if (resume && reactivated) await updateExamSession(resume.id, {status:'COMPLETED',endedAt:Date.now(),interrupted:true}).catch(() => {});
      showToast({ type: 'error', title: t('启动失败'), description: t(String((e as Error).message ?? e)) });
    } finally {
      setStarting(false);
    }
  };

  const addGoal = async () => {
    if (!newGoal.trim()) return;
    const g = await saveGoal({ name: newGoal.trim(), companyName: newCompany.trim() });
    setGoalId(g.id);
    setNewGoal('');
    setNewCompany('');
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_240px] items-start gap-6">
      <div className="flex min-w-0 flex-col gap-8">
        {interrupted && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-selection px-4 py-3 text-[12px]">
            <span className="flex-1 text-selection-fg">
              {t('上次笔试尚未完成：{title}。恢复后可继续作答或重试保存；如提示有未保存内容，请勿退出应用。', { title: interrupted.title })}
            </span>
            <Button size="sm" variant="outline" disabled={starting} onClick={() => void start(interrupted)}>
              {t('恢复上次笔试')}
            </Button>
          </div>
        )}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('回答方式')}</h2>
          <div className="grid grid-cols-3 gap-3">
            {EXAM_MODE_ORDER.map((key) => {
              const m = EXAM_MODES[key];
              const icons = { instant: <Zap size={16} />, quick: <Laptop size={16} />, programming: <Sparkles size={16} /> };
              const on = mode === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={on}
                  className={`rounded-xl border p-4 text-left transition-colors duration-[120ms] ${
                    on ? 'border-primary bg-selection' : 'border-line bg-surface-raised hover:bg-[var(--mx-action-secondary-hover)]'
                  }`}
                >
                  <span className={on ? 'text-primary' : 'text-ink-muted'}>{icons[key]}</span>
                  <span className="mt-2 flex items-center gap-1.5 text-[13px] font-medium">
                    {t(m.label)}
                    {on && <Check size={13} className="text-primary" />}
                  </span>
                  <span className="mt-1 block text-[11px] leading-[18px] text-ink-muted">{t(m.description)}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('截图与显示')}</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-raised">
            <SettingLine
              icon={Monitor}
              title={t('截图范围')}
              desc={platform?.platform === 'macos' ? t('屏幕模式截取鼠标所在显示器，并排除本应用窗口；前台窗口模式只截取最靠前的其他应用窗口。') : t('默认截取屏幕；前台窗口模式只捕获当前题目窗口。空白图片会阻止发送。')}
              align="center"
            >
              <div className="w-[132px] [&>select]:h-9 [&>select]:w-full [&>select]:border-line [&>select]:text-[13px]">
                <Select value={captureMode} disabled={platform?.screenCapture === false} title={platform?.screenCapture === false ? t('当前系统或权限不支持截图，无法选择截图范围') : undefined} onChange={e=>setCaptureMode(e.target.value)}>
                  <option value="screen">{t('当前屏幕')}</option>
                  <option value="window">{t('前台窗口')}</option>
                </Select>
              </div>
            </SettingLine>
            <SettingLine icon={Layers} title={t('多页输入')} desc={t('随时加页，发送前确认')} align="center">
              <Badge variant="outline">{t('最多 {n} 页', { n: EXAM_MODES[mode].maxScreenshotPages })}</Badge>
            </SettingLine>
            <DisclosureLine
              icon={SlidersHorizontal}
              title={t('答题与显示偏好')}
              desc={customizationSummary()}
              open={prefsOpen}
              onToggle={() => setPrefsOpen((v) => !v)}
            />
            {prefsOpen && (
              <div className="space-y-4 px-4 pb-4 pt-2">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-[11px] text-ink-muted">
                    {t('编程题语言')}
                    <Select
                      className="mt-1 h-9 border-line text-[13px]"
                      value={String(customization.programmingLanguage ?? 'auto')}
                      onChange={(e) => setCustomization({ ...customization, programmingLanguage: e.target.value })}
                    >
                      {['auto', 'Python 3', 'Java', 'C++', 'C', 'Go', 'JavaScript', 'TypeScript', 'C#', 'Rust', 'SQL'].map(
                        (l) => (<option key={l} value={l}>{l === 'auto' ? t('跟随题目') : l}</option>),
                      )}
                    </Select>
                  </label>
                  <label className="text-[11px] text-ink-muted">
                    {t('代码模式')}
                    <Select
                      className="mt-1 h-9 border-line text-[13px]"
                      value={String(customization.codeMode ?? 'auto')}
                      onChange={(e) => setCustomization({ ...customization, codeMode: e.target.value })}
                    >
                      <option value="auto">{t('跟随题目')}</option>
                      <option value="acm">{t('ACM 模式（完整程序）')}</option>
                      <option value="core">{t('核心代码模式（只写函数）')}</option>
                    </Select>
                  </label>
                  <label className="text-[11px] text-ink-muted">
                    {t('编程题取向')}
                    <Select
                      className="mt-1 h-9 border-line text-[13px]"
                      value={String(customization.codeQuality ?? 'standard')}
                      onChange={(e) => setCustomization({ ...customization, codeQuality: e.target.value })}
                    >
                      <option value="standard">{t('标准可提交')}</option>
                      <option value="readable">{t('清晰易读')}</option>
                      <option value="concise">{t('简洁直接')}</option>
                      <option value="performance">{t('优先性能')}</option>
                    </Select>
                  </label>
                  <label className="text-[11px] text-ink-muted">
                    {t('回答语言')}
                    <Select
                      className="mt-1 h-9 border-line text-[13px]"
                      value={String(customization.answerLanguage ?? 'auto')}
                      onChange={(e) => setCustomization({ ...customization, answerLanguage: e.target.value })}
                    >
                      <option value="auto">{t('跟随界面语言')}</option>
                      {['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].map((l) => (<option key={l} value={l}>{l}</option>))}
                    </Select>
                  </label>
                </div>
                <Textarea
                  rows={3}
                  maxLength={2000}
                  placeholder={t('补充要求：希望答案更短 / 多给步骤 / 按考试格式输出…')}
                  value={String(customization.customRequirements ?? '')}
                  onChange={(e) => setCustomization({ ...customization, customRequirements: e.target.value })}
                />
                <div className="divide-y divide-line rounded-lg border border-line">
                <SettingLine icon={Copy} title={t('显示复制按钮')} desc={t('答案里有代码就复制代码，没有就复制文字。部分考试平台会记录粘贴内容，也有平台禁止粘贴。')} align="center">
                  <Switch ariaLabel={t('显示复制按钮')} checked={showCopyCode} onCheckedChange={setShowCopyCode} />
                </SettingLine>
                    <SettingLine icon={Keyboard} title={t('快捷键提示')} desc={t('在浮窗按钮上显示对应键位。')} align="center">
                  <Switch ariaLabel={t('快捷键提示')} checked={showHints} onCheckedChange={setShowHints} />
                </SettingLine>
                    <SettingLine icon={Video} title={t('双机位笔试')} desc={t('有第二个摄像头拍你和屏幕时打开。笔试浮窗会换成几乎全透明、只留一圈淡边框，镜头里基本看不出来。')} align="center">
                  <DualCameraSwitch scope="exam" />
                </SettingLine>
                    <SettingLine icon={MonitorSmartphone} title={t('截图兼容模式（Windows）')} desc={t('优先读取前台窗口，失败后回退屏幕截图。默认模式会在屏幕黑屏时尝试窗口读取。')} align="center">
                  <Switch ariaLabel={t('截图兼容模式（Windows）')} checked={platform?.platform === 'windows' && compatibility} disabled={platform?.platform !== 'windows'} onCheckedChange={setCompatibility} />
                </SettingLine>
                </div>
              </div>
            )}
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('这一场的背景')}</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-raised">
            <SettingLine icon={Target} title={t('目标岗位')} align="center">
              <div className="w-[188px] [&>select]:h-9 [&>select]:w-full [&>select]:border-line [&>select]:text-[13px]">
                <Select value={goalId ?? ''} onChange={(e) => setGoalId(e.target.value || null)}>
                  {goals.length === 0 && <option value="">{t('不关联岗位')}</option>}
                  {goals.map((g) => (<option key={g.id} value={g.id}>{g.companyName ? `${g.companyName} · ${g.name}` : g.name}</option>))}
                </Select>
              </div>
            </SettingLine>
            <DisclosureLine icon={FolderPlus} title={t('新建岗位')} desc={t('没有合适的岗位时，在这里直接建一个')} open={goalOpen} onToggle={() => setGoalOpen((v) => !v)} />
            {goalOpen && (
              <div className="flex flex-wrap items-end gap-2 px-4 pb-4 pt-2">
                <Input className="h-9 w-[180px] text-[13px]" placeholder={t('岗位名称')} value={newGoal} onChange={(e) => setNewGoal(e.target.value)} />
                <Input className="h-9 w-[180px] text-[13px]" placeholder={t('公司（选填）')} value={newCompany} onChange={(e) => setNewCompany(e.target.value)} />
                <Button size="sm" variant="outline" onClick={() => void addGoal()} disabled={!newGoal.trim()}>{t('创建')}</Button>
              </div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-ink-muted">{t('岗位与资料只影响回答的上下文，不会上传到别处。')}</p>
        </section>

        <CodeVerificationPanel />
        <DualScreenCard />
      </div>

      <aside className="sticky top-4 flex flex-col gap-4">
        <div className="rounded-xl border border-line bg-surface-raised p-5 shadow-card">
          <div className="mb-4 flex size-9 items-center justify-center rounded-lg bg-selection text-primary">
            <Check size={16} />
          </div>
          <h3 className="text-[15px] font-semibold">{t('这一场，准备好了。')}</h3>
          <p className="mt-1 text-[11px] leading-[18px] text-ink-muted">{t('选项会记住，下次打开可以直接继续。')}</p>
          <ul className="mt-4 space-y-2.5 text-[12px]">
            <li className="flex items-center gap-2">
              <Check size={13} className={aiReady ? 'text-[var(--mx-status-success-text)]' : 'text-ink-muted'} />
              <span className={aiReady ? '' : 'text-ink-muted'}>{aiReady ? t('模型已配置') : t('还需要配置 AI 服务')}</span>
            </li>
            <li className="flex items-center gap-2">
              <Check size={13} className={platform?.screenCapture === false ? 'text-ink-muted' : 'text-[var(--mx-status-success-text)]'} />
              <span className={platform?.screenCapture === false ? 'text-ink-muted' : ''}>{platform?.screenCapture === false ? t('截图权限受限') : t('截图权限可用')}</span>
            </li>
            <li className="flex items-center gap-2">
              <Check size={13} className={goalId ? 'text-[var(--mx-status-success-text)]' : 'text-ink-muted'} />
              <span className={goalId ? '' : 'text-ink-muted'}>{goalId ? t('岗位已选') : t('未选择岗位（可选）')}</span>
            </li>
          </ul>
          <Button
            className="mt-5 w-full"
            onClick={() => void start()}
            disabled={starting || !aiReady}
            title={aiReady ? undefined : t('请先在「设置 → AI 服务」配置截图识别或支持图片输入的对话模型')}
          >
            <Play size={14} />
            {starting ? t('启动中…') : t('开始笔试')}
          </Button>
          <p className="mt-2 text-center text-[11px] text-ink-muted">{t('Ctrl 全局动作沿用现有配置')}</p>
        </div>
        <p className="px-1 text-[11px] leading-[18px] text-ink-muted">{t('截图与本地样例验证的结果在浮窗展示。')}</p>
      </aside>
    </div>
  );
}
