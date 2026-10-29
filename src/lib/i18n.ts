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


// ---- 简体 → 繁体（zh-tw 用；词组优先、单字兜底，translate 时实时转换） ----

const ZH_TW_PHRASES: [RegExp, string][] = [
  // 词组必须排在会抢先匹配的短词前面（数据库→資料庫 先于 数据→資料）
  [/任务管理器/g, '工作管理員'],
  [/打印机/g, '印表機'],
  [/面试官/g, '面試官'],
  [/数据库/g, '資料庫'],
  [/复制/g, '複製'],
  [/粘贴/g, '貼上'],
  [/剪切/g, '剪下'],
  [/鼠标/g, '滑鼠'],
  [/软件/g, '軟體'],
  [/视频/g, '影片'],
  [/音频/g, '音訊'],
  [/网络/g, '網路'],
  [/联网/g, '連網'],
  [/信息/g, '資訊'],
  [/消息/g, '訊息'],
  [/智能/g, '智慧'],
  [/内存/g, '記憶體'],
  [/默认/g, '預設'],
  [/设置/g, '設定'],
  [/宽带/g, '寬頻'],
  [/数据/g, '資料'],
  [/文档/g, '文件'],
  [/上传/g, '上傳'],
  [/下载/g, '下載'],
  [/屏幕/g, '螢幕'],
  [/界面/g, '介面'],
  [/点击/g, '點擊'],
  [/单击/g, '單擊'],
  [/双击/g, '雙擊'],
  [/悬停/g, '懸停'],
  [/桌面端/g, '桌面版'],
  [/回访/g, '回訪'],
  [/简历/g, '履歷'],
  [/岗位/g, '職缺'],
  [/职位/g, '職位'],
  [/进程/g, '處理程序'],
  [/录屏/g, '錄屏'],
  [/截图/g, '截圖'],
  [/充值/g, '儲值'],
];

const ZH_TW_CHARS: Record<string, string> = {
  设: '設', 证: '證', 认: '認', 确: '確', 语: '語', 简: '簡', 体: '體', 请: '請',
  输: '輸', 检: '檢', 联: '聯', 络: '絡', 试: '試', 笔: '筆', 记: '記', 录: '錄',
  题: '題', 库: '庫', 资: '資', 历: '歷', 网: '網', 样: '樣', 预: '預', 显: '顯',
  隐: '隱', 键: '鍵', 盘: '盤', 复: '複', 触: '觸', 发: '發', 页: '頁', 钟: '鐘',
  暂: '暫', 继: '繼', 续: '續', 开: '開', 结: '結', 问: '問', 识: '識', 别: '別',
  误: '誤', 让: '讓', 转: '轉', 写: '寫', 译: '譯', 连: '連', 断: '斷', 会: '會',
  话: '話', 听: '聽', 静: '靜', 门: '門', 稳: '穩', 灵: '靈', 适: '適', 众: '眾',
  观: '觀', 备: '備', 选: '選', 种: '種', 随: '隨', 机: '機', 号: '號', 碼: '碼',
  单: '單', 纯: '純', 这: '這', 里: '裡', 边: '邊', 还: '還', 么: '麼', 术: '術',
  词: '詞', 汇: '匯', 应: '應', 现: '現', 实: '實', 无: '無', 顶: '頂', 抢: '搶',
  点: '點', 击: '擊', 弹: '彈', 层: '層', 级: '級', 关: '關', 闭: '閉', 缩: '縮',
  扩: '擴', 动: '動', 态: '態', 场: '場', 职: '職', 业: '業', 练: '練', 习: '習',
  报: '報', 对: '對', 风: '風', 满: '滿', 览: '覽', 锁: '鎖', 钉: '釘', 标: '標',
  签: '簽', 删: '刪', 际: '際', 执: '執', 优: '優', 测: '測', 验: '驗', 仪: '儀',
  监: '監', 调: '調', 节: '節', 浓: '濃', 颜: '顏', 线: '線', 宽: '寬', 滚: '滾',
  换: '換', 肤: '膚', 几: '幾', 驻: '駐', 进: '進', 迟: '遲', 释: '釋', 归: '歸',
  员: '員', 额: '額', 账: '賬', 户: '戶', 维: '維', 护: '護', 导: '導', 卫: '衛',
  书: '書', 为: '為', 乐: '樂', 买: '買', 卖: '賣', 价: '價', 钱: '錢', 银: '銀',
  质: '質', 师: '師', 块: '塊', 环: '環', 境: '境', 链: '鏈', 险: '險', 压: '壓',
  档: '檔', 启: '啟', 欢: '歡', 务: '務', 时: '時', 间: '間', 终: '終', 于: '於',
  该: '該', 当: '當', 没: '沒', 办: '辦', 临: '臨', 栏: '欄', 兰: '蘭', 义: '義',
  议: '議', 订: '訂', 阅: '閱', 读: '讀', 张: '張', 贴: '貼', 图: '圖', 视: '視',
  频: '頻', 长: '長', 细: '細', 详: '詳', 树: '樹', 构: '構', 错: '錯', 变: '變',
  载: '載', 软: '軟', 驱: '驅', 讯: '訊', 讲: '講', 谈: '談', 论: '論', 忆: '憶',
  询: '詢', 声: '聲', 称: '稱', 权: '權', 钥: '鑰', 顺: '順', 择: '擇', 冲: '衝',
  覆: '覆', 盖: '蓋', 统: '統', 计: '計', 处: '處', 亿: '億', 征: '徵', 属: '屬',
  区: '區', 围: '圍', 梦: '夢', 镇: '鎮', 队: '隊', 访: '訪', 码: '碼',
};

function toTraditional(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ZH_TW_PHRASES) out = out.replace(pattern, replacement);
  let result = '';
  for (const ch of out) result += ZH_TW_CHARS[ch] ?? ch;
  return result;
}

const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
  en,
};

export function translate(key: string, params?: Record<string, string | number>): string {
  const locale = currentLocale();
  let text = key;
  if (locale === 'zh-tw') {
    // 繁体：词组/单字实时转换（未翻译词条也兜底转换，不再显示简体）
    text = toTraditional(key);
  } else if (locale !== 'zh-cn') {
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
