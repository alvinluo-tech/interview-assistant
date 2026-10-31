/*
 * 主窗口（对齐原版 SW/dW/fW）：自定义标题栏（Win）、侧边栏（品牌/导航/
 * 额度卡/设置/反馈/账号）、内容区 8 个 section、使用须知弹窗、首次引导。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  BookOpen,
  ChevronsUpDown,
  Copy,
  FileText,
  History,
  Laptop,
  Minus,
  MessageSquareText,
  Mic,
  Settings as SettingsIcon,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import brandIcon from '../../src-tauri/icons/128x128@2x.png';
import { Badge, Card, ToastViewport } from '@/ui/primitives';
import { BRAND, isMac } from '@/lib/env';
import { getSetting, setSetting, useSetting } from '@/lib/store';
import { readData, useDataError } from '@/lib/backend';
import { setPanicHotkey, setActionHotkeys, onEvent, hideOverlay, showOverlay, setSessionActive } from '@/lib/bridge';
import { DEFAULT_PANIC_HOTKEY, effectiveHotkeys, type ActionKey, type HotkeyScheme } from '@/lib/hotkeys';
import { InterviewWorkbench } from './sections/InterviewWorkbench';
import { ExamWorkbench } from './sections/ExamWorkbench';
import { MockPage } from './sections/MockPage';
import { QuestionBankPage } from './sections/QuestionBankPage';
import { ResourcePage } from './sections/ResourcePage';
import { RecordsPage } from './sections/RecordsPage';
import { SettingsPage } from './sections/SettingsPage';
import { UsageNotice } from './UsageNotice';
import { Onboarding } from './Onboarding';
import { ChangelogDialog } from './ChangelogDialog';
import { FeedbackDialog } from './FeedbackDialog';
import { LocalProfileDialog } from './LocalProfileDialog';
import { UpdateNotice } from './UpdateNotice';
const FreeChatPage = lazy(() => import('./sections/FreeChatPage').then(module => ({default: module.FreeChatPage})));

type Section =
  | 'interview'
  | 'exam'
  | 'mock'
  | 'chat'
  | 'question-bank'
  | 'resource'
  | 'records'
  | 'settings';

const BIG_NAV: { key: Section; label: string; desc: string; icon: React.ReactNode }[] = [
  { key: 'interview', label: '面试助手', desc: '实时听译 · 自动答题', icon: <Mic size={17} /> },
  { key: 'exam', label: '笔试助手', desc: '真实笔试 · 截屏解题', icon: <Laptop size={17} /> },
  { key: 'mock', label: '模拟面试', desc: '面试前练手 · 复盘报告', icon: <Sparkles size={17} /> },
  { key: 'chat', label: '自由对话', desc: '文字 · 语音 · 资料查询', icon: <MessageSquareText size={17} /> },
];

const SMALL_NAV: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'question-bank', label: '面试题库', icon: <BookOpen size={15} /> },
  { key: 'resource', label: '资料管理', icon: <FileText size={15} /> },
  { key: 'records', label: '历史记录', icon: <History size={15} /> },
];

const PAGE_TITLES: Record<Exclude<Section, 'interview' | 'settings'>, { h1: string; sub: string }> = {
  exam: {
    h1: '笔试助手',
    sub: '在真实笔试环境中作答，配合透明浮窗，悬停「解题」即可让 AI 识别题型并给出答案。',
  },
  mock: {
    h1: '模拟面试',
    sub: 'AI 面试官按你的简历和岗位出题，你开口回答，结束后出一份复盘报告。',
  },
  chat: {h1:'自由对话',sub:'文字和语音对话。'},
  'question-bank': { h1: '面试题库', sub: '马上要面的这场，会考什么、你该怎么答。' },
  resource: {
    h1: '资料管理',
    sub: '简历、岗位和面试资料在这里统一维护。面试开始前只需要选，不用临时编辑。',
  },
  records: { h1: '历史记录', sub: '每场面试的问答记录、每次笔试的题目与答案。' },
};

let startupHotkeys: Promise<void> | undefined;
function initializeStartupHotkeys() {
  return startupHotkeys ??= (async () => {
    const {showToast}=await import('@/ui/primitives');
    try {await setPanicHotkey(getSetting('panic.hotkey',DEFAULT_PANIC_HOTKEY));}
    catch(error){showToast({type:'error',title:'应急隐藏快捷键未生效',description:String((error as Error).message||error)});}
    const scheme=getSetting<HotkeyScheme>('overlay.hotkeyScheme','simple');
    const effective=effectiveHotkeys(scheme,getSetting('overlay.actionHotkeys',{}) as Partial<Record<ActionKey,string>>);
    try {await setActionHotkeys(Object.entries(effective).map(([action,accelerator])=>({action,accelerator})));}
    catch(error){showToast({type:'error',title:'部分浮窗快捷键未生效',description:String((error as Error).message||error)});}
  })();
}
let staleCleanup: Promise<void> | undefined;

export function MainWindow() {
  const dataError=useDataError();
  const [section, setSection] = useState<Section>('interview');
  const usageAcked = useSetting('notice.usageAcknowledged.v2', false)[0];
  const onboardingSkipped = useSetting('onboarding.skipped', false)[0];
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  // 启动副作用：注册 panic + 动作热键、浮窗异常事件
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void initializeStartupHotkeys();
    const offDead = onEvent('overlay-webview-dead', () => {
      import('@/ui/primitives').then(({ showToast }) =>
        showToast({ type: 'error', title: '悬浮窗出现异常已自动收起，重新开始面试即可继续。' }),
      );
    });
    const offIdle = onEvent('panic-hotkey-idle', () => {
      import('@/ui/primitives').then(({ showToast }) =>
        showToast({
          type: 'info',
          title: '已收到这个快捷键 —— 浮窗当前没有显示，所以不做任何动作。',
        }),
      );
    });
    // 会话进行中标记同步（本地模式无 overlay-shown 原生事件也能恢复浮窗）
    const offShown = onEvent('overlay-shown', () => {
      setMainHidden(true);
    });
    return () => {
      offDead();
      offIdle();
      offShown();
    };
  }, []);

  const [mainHidden, setMainHidden] = useState(false);

  // 启动时清理陈旧的活动会话（浮窗没在跑，上一场不可能还活着）
  useEffect(() => {
    void (staleCleanup ??= (async () => {
      const { overlayShowSeq } = await import('@/lib/bridge');
      const seq = await overlayShowSeq().catch(() => 0);
      if (!seq) {
        const { closeStaleActiveSessions } = await import('@/lib/backend');
        await closeStaleActiveSessions();
      }
    })().catch(error => console.warn('[sessions] stale cleanup failed',error)));
  }, []);

  // 面试/笔试会话进行中时主窗口自动隐藏（由 workbench 调 startFlow）
  useEffect(() => {
    if (mainHidden) {
      getCurrentWindow().hide().catch(() => {});
    }
  }, [mainHidden]);

  // 引导完成回调
  const finishOnboarding = async (ownData: boolean) => {
    await setSetting('onboarding.skipped', true);
    if (ownData) {
      const { cleanupDefaultData } = await import('@/lib/backend');
      await cleanupDefaultData();
    }
  };

  const showOnboarding = !onboardingSkipped && usageAcked;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar />
      <UpdateNotice />
      {dataError&&<div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">本地数据读取失败，已阻止覆盖。请在「设置 → 关于」恢复手动备份。{dataError}</div>}
      <UsageNotice />
      {changelogOpen && <ChangelogDialog onClose={() => setChangelogOpen(false)} />}
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <LocalProfileDialog open={profileOpen} onClose={() => setProfileOpen(false)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          section={section}
          onNavigate={setSection}
          onFeedback={() => setFeedbackOpen(true)}
          onProfile={() => setProfileOpen(true)}
        />
        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            <div className={`mx-auto w-full ${section==='chat'?'max-w-none':'max-w-3xl'} px-7 py-7`}>
              {showOnboarding ? (
                <Onboarding onFinish={finishOnboarding} />
              ) : (
                <>
                  {section !== 'interview' && section !== 'settings' && section !== 'chat' && (
                    <header className="mb-5">
                      <h1 className="text-lg font-semibold">{PAGE_TITLES[section].h1}</h1>
                      <p className="mt-1 text-sm text-muted-foreground">{PAGE_TITLES[section].sub}</p>
                    </header>
                  )}
                  {section === 'interview' && <InterviewWorkbench onNavigate={(s) => setSection(s as Section)} />}
                  {section === 'exam' && <ExamWorkbench onNavigate={(s) => setSection(s as Section)} />}
                  {section === 'mock' && <MockPage />}
                  {section === 'chat' && <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">正在打开对话…</div>}><FreeChatPage /></Suspense>}
                  {section === 'question-bank' && <QuestionBankPage />}
                  {section === 'resource' && <ResourcePage />}
                  {section === 'records' && <RecordsPage />}
                  {section === 'settings' && <SettingsPage />}
                </>
              )}
            </div>
          </div>
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}

function TitleBar() {
  const [disguised] = useSetting('disguise.enabled', false);
  const [windowTitle] = useSetting('disguise.windowTitle', 'Desktop Helper');
  if (isMac()) return null;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onResized(async () => {
      setMaximized(await win.isMaximized());
    });
    return () => {
      void un.then((f) => f());
    };
  }, []);
  const btn =
    'flex h-8 w-[46px] items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground';
  return (
    <div data-tauri-drag-region className="flex h-8 shrink-0 items-center border-b bg-muted/40 pl-3">
      <img src="/tauri.svg" alt="" className="hidden" />
      {!disguised && <BrandMark size={16} />}
      <span data-tauri-drag-region className="ml-2 text-[12px] font-medium">
        {disguised ? windowTitle : BRAND}
      </span>
      <div className="flex-1" data-tauri-drag-region />
      <button
        type="button"
        className={btn}
        aria-label="最小化"
        onClick={() => void getCurrentWindow().minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className={btn}
        aria-label={maximized ? '还原' : '最大化'}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <Copy size={12} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        className={`${btn} hover:bg-red-500/90 hover:text-white`}
        aria-label="关闭"
        onClick={() => {
          // 关闭 = 退出进程（对齐原版）：销毁主窗口后应用退出
          void getCurrentWindow().destroy();
          void import('@tauri-apps/api/core').then(({ invoke }) => invoke('cmd_exit_app'));
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <img src={brandIcon} alt="" aria-hidden="true" draggable={false}
      className="shrink-0 object-contain" style={{ width: size, height: size }} />
  );
}

function Sidebar({
  section,
  onNavigate,
  onFeedback,
  onProfile,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  onFeedback: () => void;
  onProfile: () => void;
}) {
  const [user] = useSetting('local.user', { name: '本地用户', email: '' });
  return (
    <aside className="flex min-h-0 w-56 shrink-0 flex-col overflow-y-auto border-r bg-muted/35">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <BrandMark />
        <div>
          <div className="text-sm font-semibold">{BRAND}</div>
          <div className="text-[11px] text-muted-foreground">AI 面试助手</div>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-3 pt-2">
        {BIG_NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => onNavigate(n.key)}
            className={`flex items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
              section === n.key ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
            }`}
          >
            <span className={section === n.key ? 'text-primary' : 'text-muted-foreground'}>{n.icon}</span>
            <span>
              <span className="block text-[13px] font-medium">{n.label}</span>
              <span className="block text-[11px] text-muted-foreground">{n.desc}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mx-4 my-3 border-t" />

      <div className="flex flex-col gap-0.5 px-3">
        {SMALL_NAV.map((n) => (
          <button
            key={n.key}
            type="button"
            onClick={() => onNavigate(n.key)}
            className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
              section === n.key ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'
            }`}
          >
            <span className={section === n.key ? 'text-primary' : 'text-muted-foreground'}>{n.icon}</span>
            {n.label}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* 剩余额度卡（本地模式：不限制） */}
      <div className="mx-3 mb-2 rounded-lg border bg-card p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">剩余额度</span>
          <Badge variant="amber">本地版</Badge>
        </div>
        <div className="mt-1 text-lg font-semibold">无限</div>
        <div className="text-[11px] text-muted-foreground">使用自己的 AI 接口 · 不限量</div>
      </div>

      <div className="mx-3 mb-2 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
            section === 'settings' ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
          }`}
        >
          <SettingsIcon size={15} className="text-muted-foreground" />
          设置
        </button>
        <button
          type="button"
          onClick={onFeedback}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-accent"
        >
          <MessageSquareText size={15} className="text-muted-foreground" />
          反馈
        </button>
      </div>

      <div className="border-t px-3 py-2.5">
        <button
          type="button"
          onClick={onProfile}
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
            {user.name.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{user.name}</span>
            {user.email && <span className="block truncate text-[11px] text-muted-foreground">{user.email}</span>}
          </span>
          <ChevronsUpDown size={13} className="text-muted-foreground" />
        </button>
      </div>
    </aside>
  );
}

/** 启动面试/笔试的公共流程（对齐原版 he）：setSessionActive → showOverlay → hideMain */
export async function startOverlayFlow(mode: 'exam' | 'interview', goalId: string | null): Promise<void> {
  const { setSetting } = await import('@/lib/store');
  await setSetting('overlay.mode', mode);
  if (goalId !== undefined) await setSetting('exam.goalId', goalId);
  await setSessionActive(true);
  await showOverlay();
  // 400ms 后隐藏主窗口（对齐原版时序）
  window.setTimeout(() => {
    getCurrentWindow().hide().catch(() => {});
  }, 400);
}

/** 浮窗退出后恢复工作台（panic/退出共用） */
export async function recallWorkbench() {
  await setSessionActive(false);
  await hideOverlay();
  await getCurrentWindow().show();
  await getCurrentWindow().setFocus();
}

void Card;
void readData;
