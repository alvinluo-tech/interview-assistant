import { useAiReady } from '@/lib/aiSettings';
/*
 * 笔试工作台（对齐原版 hW）：模式三选卡、岗位、答题偏好折叠、
 * 双机位/快捷键提示/复制按钮开关、开始笔试。
 */
import { useEffect, useState } from 'react';
import { getPlatformCapabilities, isTauri, type PlatformCapabilities } from '@/lib/bridge';
import { ChevronDown, ChevronRight, Laptop, Play, Sparkles, Zap } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  SectionHeader,
  SettingRow,
  Select,
  Switch,
  Textarea,
  Input,
  showToast,
} from '@/ui/primitives';
import { useData, saveGoal, readData, type Goal } from '@/lib/backend';
import { useSetting, setSetting } from '@/lib/store';

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

export function ExamWorkbench({ onNavigate }: { onNavigate: (s: string) => void }) {
  const goals = useData<Goal[]>('goals', [])[0];
  const [mode, setMode] = useSetting<ExamModeKey>('exam.mode', 'quick');
  const [goalId, setGoalId] = useSetting<string | null>('exam.goalId', goals[0]?.id ?? null);
  const [showCopyCode, setShowCopyCode] = useSetting('exam.showCopyCodeButton', false);
  const [showHints, setShowHints] = useSetting('interview.showHotkeyHints', true);
  const [compatibility,setCompatibility]=useSetting('capture.compatibilityMode',false);
  const [captureMode,setCaptureMode]=useSetting('capture.mode','screen');
  const [customization, setCustomization] = useSetting<Record<string, unknown>>('exam.customization', {});
  const [prefsOpen, setPrefsOpen] = useState(false);
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

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      // 上一场如果还挂着（崩溃/强退留下的），先收尾再开新场
      const stale = readData<{ id: string; status: string }[]>('examSessions', []).filter(
        (s) => s.status === 'ACTIVE',
      );
      if (stale.length > 0) {
        const { closeStaleActiveSessions } = await import('@/lib/backend');
        await closeStaleActiveSessions();
      }
      await setSetting('exam.mode', mode);
      await setSetting('exam.pendingConfig', {runId:crypto.randomUUID(),goalId});
      await startOverlayFlow('exam', goalId);
      showToast({ type: 'success', title: '笔试浮窗已启动', description: '把题目放到屏幕上，悬停「解题」即可。' });
    } catch (e) {
      showToast({ type: 'error', title: '启动失败', description: String((e as Error).message ?? e) });
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
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader
          title="开始一场笔试"
          desc="先选答题模式，进入浮窗后也可以随时切换；浮窗无边框置顶，不抢焦点。"
          right={
            <Button onClick={() => void start()} disabled={starting}>
              <Play size={14} />
              {starting ? '启动中…' : '开始笔试'}
            </Button>
          }
        />

        {/* 模式三选卡 */}
        <div className="mb-4 grid grid-cols-3 gap-3">
          {EXAM_MODE_ORDER.map((key) => {
            const m = EXAM_MODES[key];
            const icons = { instant: <Zap size={15} />, quick: <Laptop size={15} />, programming: <Sparkles size={15} /> };
            return (
              <button
                key={key}
                type="button"
                onClick={() => setMode(key)}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  mode === key ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent'
                }`}
              >
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <span className={mode === key ? 'text-primary' : 'text-muted-foreground'}>{icons[key]}</span>
                  {m.label}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{m.description}</div>
                <div className="mt-1.5">
                  <Badge variant={mode === key ? 'default' : 'outline'}>
                    最多 {m.maxScreenshotPages} 页 · 使用你的视觉模型
                  </Badge>
                </div>
              </button>
            );
          })}
        </div>

        {/* 岗位 */}
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-muted-foreground">
            目标岗位
            <Select className="mt-1" value={goalId ?? ''} onChange={(e) => setGoalId(e.target.value || null)}>
              {goals.length === 0 && <option value="">不关联岗位</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-end gap-1.5">
            <div className="flex flex-1 flex-col gap-1.5">
              <Input className="h-8 text-xs" placeholder="岗位名称" value={newGoal} onChange={(e) => setNewGoal(e.target.value)} />
              <Input className="h-8 text-xs" placeholder="公司（选填）" value={newCompany} onChange={(e) => setNewCompany(e.target.value)} />
            </div>
            <Button size="sm" variant="outline" onClick={() => void addGoal()} disabled={!newGoal.trim()}>
              新建岗位
            </Button>
          </div>
        </div>

        {!aiReady && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
            请到「设置 → AI 服务」选择截图识别模型，或使用支持图片输入的对话模型。
          </div>
        )}
      </Card>

      <Card className="p-5">
        {/* 答题偏好折叠 */}
        <button
          type="button"
          className="flex w-full items-center justify-between"
          onClick={() => setPrefsOpen((v) => !v)}
        >
          <div className="text-left">
            <div className="text-sm font-semibold">答题偏好</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{customizationSummary()}</div>
          </div>
          {prefsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        {prefsOpen && (
          <div className="mt-3 flex flex-col gap-3 border-t pt-3">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs font-medium text-muted-foreground">
                编程题语言
                <Select
                  className="mt-1"
                  value={String(customization.programmingLanguage ?? 'auto')}
                  onChange={(e) => setCustomization({ ...customization, programmingLanguage: e.target.value })}
                >
                  {['auto', 'Python 3', 'Java', 'C++', 'C', 'Go', 'JavaScript', 'TypeScript', 'C#', 'Rust', 'SQL'].map(
                    (l) => (
                      <option key={l} value={l}>
                        {l === 'auto' ? '跟随题目' : l}
                      </option>
                    ),
                  )}
                </Select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                代码模式
                <Select
                  className="mt-1"
                  value={String(customization.codeMode ?? 'auto')}
                  onChange={(e) => setCustomization({ ...customization, codeMode: e.target.value })}
                >
                  <option value="auto">跟随题目</option>
                  <option value="acm">ACM 模式（完整程序）</option>
                  <option value="core">核心代码模式（只写函数）</option>
                </Select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                编程题取向
                <Select
                  className="mt-1"
                  value={String(customization.codeQuality ?? 'standard')}
                  onChange={(e) => setCustomization({ ...customization, codeQuality: e.target.value })}
                >
                  <option value="standard">标准可提交</option>
                  <option value="readable">清晰易读</option>
                  <option value="concise">简洁直接</option>
                  <option value="performance">优先性能</option>
                </Select>
              </label>
              <label className="text-xs font-medium text-muted-foreground">
                回答语言
                <Select
                  className="mt-1"
                  value={String(customization.answerLanguage ?? 'auto')}
                  onChange={(e) => setCustomization({ ...customization, answerLanguage: e.target.value })}
                >
                  <option value="auto">跟随界面语言</option>
                  {['zh-CN', 'en-US', 'ja-JP', 'ko-KR'].map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </Select>
              </label>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">补充要求</div>
              <Textarea
                rows={3}
                maxLength={20000}
                placeholder="补充要求：希望答案更短 / 多给步骤 / 按考试格式输出…"
                value={String(customization.customRequirements ?? '')}
                onChange={(e) => setCustomization({ ...customization, customRequirements: e.target.value })}
              />
            </div>
          </div>
        )}
      </Card>

      <Card className="px-5 py-1">
        <SettingRow title="显示复制按钮" desc="答案里有代码就复制代码，没有就复制文字。部分考试平台会记录粘贴内容，也有平台禁止粘贴。">
          <Switch checked={showCopyCode} onCheckedChange={setShowCopyCode} />
        </SettingRow>
        <SettingRow title="快捷键提示" desc="在浮窗按钮上显示对应键位。">
          <Switch checked={showHints} onCheckedChange={setShowHints} />
        </SettingRow>
        <SettingRow
          title="双机位笔试"
          desc="有第二个摄像头拍你和屏幕时打开。笔试浮窗会换成几乎全透明、只留一圈淡边框，镜头里基本看不出来。"
        >
          <DualCameraSwitch scope="exam" />
        </SettingRow>
        <SettingRow title="截图范围" desc={platform?.platform === 'macos' ? '屏幕模式截取鼠标所在显示器，并排除本应用窗口；前台窗口模式只截取最靠前的其他应用窗口。' : '默认截取屏幕；前台窗口模式只捕获当前题目窗口。空白图片会阻止发送。'}>
          <Select value={captureMode} disabled={platform?.screenCapture === false} onChange={e=>setCaptureMode(e.target.value)}><option value="screen">屏幕</option><option value="window">前台窗口</option></Select>
        </SettingRow>
        <SettingRow title="截图兼容模式（Windows）" desc="优先读取前台窗口，失败后回退屏幕截图。默认模式会在屏幕黑屏时尝试窗口读取。">
          <Switch checked={platform?.platform === 'windows' && compatibility} disabled={platform?.platform !== 'windows'} onCheckedChange={setCompatibility} />
        </SettingRow>
      </Card>

      <CodeVerificationPanel />

      <DualScreenCard />

      <div className="grid grid-cols-3 gap-3">
        {[
          { title: '智能答题', desc: 'AI 识别题型自动解答' },
          { title: '多页题目', desc: '一屏放不下可分页截取' },
          { title: '不抢焦点', desc: '鼠标键盘穿透到底层' },
        ].map((s) => (
          <Card key={s.title} className="p-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles size={13} className="text-primary" />
              {s.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{s.desc}</div>
          </Card>
        ))}
      </div>
      <button type="button" className="hidden" onClick={() => onNavigate('settings')} />
    </div>
  );
}
