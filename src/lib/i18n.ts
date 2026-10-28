/*
 * i18n：与原应用相同的 9 语言基础设施（zh-cn 为源语言、key 即中文原文；
 * 目标语缺失时回退英语；切换语言广播事件并整窗刷新）。
 * 翻译资源采用按需补充策略：en 提供主要 chrome 文案，其余语言回退 en。
 */
export const LOCALES = [
  'zh-cn',
  'en',
  'pt-br',
  'es-419',
  'vi',
  'tr',
  'ko',
  'ja',
  'zh-tw',
] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-cn': '简体中文',
  en: 'English',
  'pt-br': 'Português (Brasil)',
  'es-419': 'Español (Latinoamérica)',
  vi: 'Tiếng Việt',
  tr: 'Türkçe',
  ko: '한국어',
  ja: '日本語',
  'zh-tw': '繁體中文',
};

const LOCALE_STORAGE_KEY = 'desktop.locale';
const LOCALE_EVENT = 'desktop-locale-changed';

/** locale → html lang 值 */
export function htmlLangOf(locale: Locale): string {
  return locale;
}

export function normalizeLocale(input: string | null | undefined): Locale {
  const s = (input || '').toLowerCase();
  if (!s) return 'zh-cn';
  if (LOCALES.includes(s as Locale)) return s as Locale;
  if (s.startsWith('zh')) {
    if (s.includes('hk') || s.includes('hant') || s.includes('tw')) return 'zh-tw';
    return 'zh-cn';
  }
  if (s.startsWith('pt')) return 'pt-br';
  if (s.startsWith('es')) return 'es-419';
  if (s.startsWith('en')) return 'en';
  for (const l of LOCALES) {
    if (s.startsWith(l)) return l;
  }
  return 'en';
}

export function systemLocale(): Locale {
  try {
    return normalizeLocale(navigator.language);
  } catch {
    return 'zh-cn';
  }
}

export function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(LOCALE_STORAGE_KEY);
    return v ? normalizeLocale(v) : null;
  } catch {
    return null;
  }
}

export function currentLocale(): Locale {
  return storedLocale() ?? systemLocale();
}

/** 切换语言：持久化 + 广播（主窗口收到后整窗 reload） */
export async function switchLocale(locale: Locale) {
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit(LOCALE_EVENT, { locale });
  } catch {
    // 非浮窗场景下直接刷新
    if (windowScene() !== 'overlay') window.location.reload();
  }
  if (windowScene() !== 'overlay') {
    window.location.reload();
  } else {
    applyDocumentLang();
  }
}

export function windowScene(): 'overlay' | 'mock' | 'main' {
  const h = window.location.hash.replace(/^#/, '').split('?')[0];
  if (h === 'overlay') return 'overlay';
  if (h === 'mock') return 'mock';
  return 'main';
}

export function applyDocumentLang() {
  document.documentElement.lang = htmlLangOf(currentLocale());
}

// ---- 英语字典（key = 中文原文）----
const en: Record<string, string> = {
  "骆耀升老公酱面试助手": "Interview Assistant",
  "AI 面试助手": "AI Interview Assistant",
  "面试助手": "Interview",
  "实时听译 · 自动答题": "Live transcription · Auto answers",
  "笔试助手": "Exam Copilot",
  "真实笔试 · 截屏解题": "Real exams · Screenshot solving",
  "模拟面试": "Mock Interview",
  "面试前练手 · 复盘报告": "Practice before · Debrief report",
  "面试题库": "Question Bank",
  "资料管理": "Resources",
  "历史记录": "History",
  "网申助手": "Job Apply",
  "设置": "Settings",
  "反馈": "Feedback",
  "剩余额度": "Remaining Credit",
  "去充值": "Top up",
  "退出登录": "Sign out",
  "重新加载": "Reload",
  "出了点问题": "Something went wrong",
  "点击下方按钮重新加载即可继续使用，你的登录状态会保留。": "Click reload below to continue. Your login state is kept.",
  "启动中": "Starting",
  "使用须知": "Terms of Use",
  "我已阅读并同意": "I have read and agree",
  "知道了": "Got it",
  "稍后": "Later",
  "今天不再提示": "Don't show today",
  "查看完整更新日志": "View full changelog",
  "已更新到新版本": "Updated to a new version",
  "暂无更新记录": "No changelog yet.",
  "语言与外观，应用到所有窗口。": "Language & appearance, applied to all windows.",
  "界面语言": "Interface language",
  "切换语言会刷新窗口让翻译生效。": "Switching language reloads the window.",
  "跟随系统": "Follow system",
  "外观主题": "Appearance",
  "只影响主窗口；浮窗的明暗在「浮窗样式」里单独选。": "Main window only; overlay has its own theme in \"Overlay Style\".",
  "浅色": "Light",
  "深色": "Dark",
  "界面大小": "UI scale",
  "展开全部语言": "Show all languages",
  "收起": "Collapse",
  "快捷键": "Shortcuts",
  "浮窗样式": "Overlay Style",
  "通用": "General",
  "隐蔽": "Stealth",
  "更新日志": "Changelog",
  "关于": "About",
  "决定客户端在任务管理器和录屏画面里是什么样子。": "Controls how the app appears in Task Manager and recordings.",
  "面试和笔试浮窗共用这几组热键，全局生效。": "Shared by interview & exam overlays, works globally.",
  "应急隐藏快捷键": "Panic hotkey",
  "客户端版本": "Client version",
  "界面版本": "UI version",
  "系统版本": "System version",
  "检查更新": "Check for updates",
  "已经是最新版本。": "Already up to date.",
  "正在检查更新…": "Checking for updates…",
  "版本信息。联系我们反馈问题时，把这里的内容一并带上。": "Version info. Include this when contacting support.",
  "这个客户端版本里的全部改动。": "All changes in this client version.",
  "正在聆听面试官": "Listening to the interviewer",
  "点下方「开始」进入聆听": "Hover \"Start\" below to begin listening",
  "正在连接面试会话…": "Connecting to interview session…",
  "面试官的问题和 AI 答案会出现在这里": "Interviewer's questions and AI answers appear here",
  "聆听中": "Listening",
  "已暂停": "Paused",
  "待开始": "Ready",
  "连接中": "Connecting",
  "生成回答": "Answering",
  "接语音": "Voice",
  "只读": "Read-only",
  "连接已断开": "Disconnected",
  "会话已结束": "Session ended",
  "时长已用尽": "Time used up",
  "开始": "Start",
  "暂停": "Pause",
  "继续": "Resume",
  "立即回答": "Answer now",
  "笔试答题": "Exam solve",
  "语音提问": "Voice ask",
  "结束并提问": "End & ask",
  "回到答题": "Back to solving",
  "结束面试": "End interview",
  "识别有误？一键让 AI 按正确题意重答": "Misheard? One click to re-answer",
  "已连接": "Connected",
  "重试中": "Retrying",
  "解题": "Solve",
  "直接答": "Answer now",
  "加页": "Add page",
  "重置": "Reset",
  "退出": "Exit",
  "发送": "Send",
  "取消": "Cancel",
  "秒答": "Instant",
  "快速": "Quick",
  "编程": "Programming",
  "已复制代码": "Code copied",
  "已复制答案文字": "Answer text copied",
  "上一题": "Previous",
  "下一题": "Next",
  "悬停回看": "Hover to go back",
  "悬停看新": "Hover for latest",
  "悬停看上一题": "Hover for previous card",
  "悬停看下一题": "Hover for next card",
  "窗口模式": "Window mode",
  "一键配色": "Auto palette",
  "换配色": "Apply palette",
};


const zhTw: Record<string, string> = Object.fromEntries(
  Object.keys(en).map((k) => [k, k]), // 占位：源语言即中文，繁体走开源转换时再补
);

const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
  en,
  'zh-tw': zhTw,
};

export function translate(key: string, params?: Record<string, string | number>): string {
  const locale = currentLocale();
  let text = key;
  if (locale !== 'zh-cn') {
    const dict = dictionaries[locale];
    text = dict?.[key] ?? dictionaries.en?.[key] ?? key;
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/** i18n 翻译函数（组件里用 t） */
export const t = translate;
