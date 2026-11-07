/*
 * 主窗口（对齐原版 SW/dW/fW）：自定义标题栏（Win）、侧边栏（品牌/导航/
 * 额度卡/设置/反馈/账号）、内容区 8 个 section、使用须知弹窗、首次引导。
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  ArrowUpRight,
  BookOpen,
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
import { Card, ToastViewport, showToast } from '@/ui/primitives';
import { BRAND, isMac } from '@/lib/env';
import { t } from '@/lib/i18n';
import { getSetting, setSetting, useSetting } from '@/lib/store';
import { readData, useDataError } from '@/lib/backend';
import { setPanicHotkey, setActionHotkeys, onEvent, hideOverlay, showMain, showOverlay, setSessionActive } from '@/lib/bridge';
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
    catch(error){showToast({type:'error',title:t('应急隐藏快捷键未生效'),description:t(String((error as Error).message||error))});}
    const scheme=getSetting<HotkeyScheme>('overlay.hotkeyScheme','simple');
    const effective=effectiveHotkeys(scheme,getSetting('overlay.actionHotkeys',{}) as Partial<Record<ActionKey,string>>);
    try {await setActionHotkeys(Object.entries(effective).map(([action,accelerator])=>({action,accelerator})));}
    catch(error){showToast({type:'error',title:t('部分浮窗快捷键未生效'),description:t(String((error as Error).message||error))});}
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

  // 启动副作用：注册 panic + 动作热键、浮窗异常事件
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return;
    void initializeStartupHotkeys();
    const offDead = onEvent('overlay-webview-dead', () => {
      // 主窗口在面试时是隐藏的；先把用户带回工作台，再提示，否则 toast 看不见。
      void (async () => {
        try {
          const bridge = await import('@/lib/bridge');
          await bridge.setSessionActive(false).catch(() => {});
          await bridge.showMain().catch(() => {});
        } finally {
          const { showToast } = await import('@/ui/primitives');
          showToast({ type: 'error', title: t('悬浮窗出现异常已自动收起，重新开始面试即可继续。') });
        }
      })();
    });
    const offIdle = onEvent('panic-hotkey-idle', () => {
      import('@/ui/primitives').then(({ showToast }) =>
        showToast({
          type: 'info',
          title: t('已收到这个快捷键 —— 浮窗当前没有显示，所以不做任何动作。'),
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
      {dataError&&<div role="alert" className="border-b border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">{t('本地数据读取失败，已阻止覆盖。请在「设置 → 关于」恢复手动备份。')}{dataError}</div>}
      <UsageNotice />
      {changelogOpen && <ChangelogDialog onClose={() => setChangelogOpen(false)} />}
      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar
          section={section}
          onNavigate={setSection}
          onFeedback={() => setFeedbackOpen(true)}
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
                      <h1 className="text-lg font-semibold">{t(PAGE_TITLES[section].h1)}</h1>
                      <p className="mt-1 text-sm text-muted-foreground">{t(PAGE_TITLES[section].sub)}</p>
                    </header>
                  )}
                  {section === 'interview' && <InterviewWorkbench onNavigate={(s) => setSection(s as Section)} />}
                  {section === 'exam' && <ExamWorkbench onNavigate={(s) => setSection(s as Section)} />}
                  {section === 'mock' && <MockPage />}
                  {section === 'chat' && <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">{t('正在打开对话…')}</div>}><FreeChatPage /></Suspense>}
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
        aria-label={t('最小化')}
        onClick={() => void getCurrentWindow().minimize()}
      >
        <Minus size={14} />
      </button>
      <button
        type="button"
        className={btn}
        aria-label={maximized ? t('还原') : t('最大化')}
        onClick={() => void getCurrentWindow().toggleMaximize()}
      >
        {maximized ? <Copy size={12} /> : <Square size={11} />}
      </button>
      <button
        type="button"
        className={`${btn} hover:bg-red-500/90 hover:text-white`}
        aria-label={t('关闭')}
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

const PROJECT_REPO = 'https://github.com/alvinluo-tech/interview-assistant';

/** 用系统浏览器打开项目仓库；打不开时给出提示，不让点击看起来没反应。 */
function openProjectRepo() {
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(PROJECT_REPO))
    .catch(reason => showToast({ type: 'error', title: t('链接暂时无法打开'), description: String(reason) }));
}

/** GitHub 标志（lucide 已移除品牌图标，这里内联一份） */
function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.1c-3.2.7-3.88-1.54-3.88-1.54-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.19-1.49 3.15-1.18 3.15-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
    </svg>
  );
}

function Sidebar({
  section,
  onNavigate,
  onFeedback,
}: {
  section: Section;
  onNavigate: (s: Section) => void;
  onFeedback: () => void;
}) {
  return (
    <aside className="flex min-h-0 w-56 shrink-0 flex-col overflow-y-auto border-r bg-muted/35">
      <div className="flex items-center gap-2.5 px-4 pb-2 pt-4">
        <BrandMark />
        <div>
          <div className="text-sm font-semibold">{BRAND}</div>
          <div className="text-[11px] text-muted-foreground">{t('AI 面试助手')}</div>
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
              <span className="block text-[13px] font-medium">{t(n.label)}</span>
              <span className="block text-[11px] text-muted-foreground">{t(n.desc)}</span>
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
            {t(n.label)}
          </button>
        ))}
      </div>

      <div className="flex-1" />

      {/* GitHub 卡片：跳转到项目仓库 */}
      <button
        type="button"
        onClick={openProjectRepo}
        className="group mx-3 mb-2 flex items-start gap-2.5 rounded-lg border bg-card p-3 text-left transition-colors hover:border-foreground/20 hover:bg-accent/60"
      >
        <span className="mt-px text-muted-foreground transition-colors group-hover:text-foreground">
          <GitHubMark size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 text-[13px] font-medium">
            {t('GitHub 仓库')}
            <ArrowUpRight size={12} className="text-muted-foreground" />
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {t('查看源码、更新日志与问题反馈')}
          </span>
        </span>
      </button>

      <div className="mx-3 mb-2 flex flex-col gap-0.5">
        <button
          type="button"
          onClick={() => onNavigate('settings')}
          className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
            section === 'settings' ? 'bg-primary/10 text-primary' : 'hover:bg-accent'
          }`}
        >
          <SettingsIcon size={15} className="text-muted-foreground" />
          {t('设置')}
        </button>
        <button
          type="button"
          onClick={onFeedback}
          className="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-accent"
        >
          <MessageSquareText size={15} className="text-muted-foreground" />
          {t('反馈')}
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
  // 先亮主窗口再收浮窗：主窗口没起来时，用户至少还有浮窗可用。
  await showMain().catch(() => {});
  await hideOverlay();
}

void Card;
void readData;
