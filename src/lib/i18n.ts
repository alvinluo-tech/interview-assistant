/*
 * i18n：9 语言基础设施（zh-cn 为源语言、key 即中文原文；切换语言广播事件
 * 并整窗刷新，因此 t() 无需订阅即可保持一致）。
 * 词典按 locale 拆分在 ./i18n/locales/；zh-tw 由简繁转换实时生成，
 * 其余语言缺失词条时回退 en（tests/i18n.test.mjs 校验各语言 key 对齐，
 * 防止切换语言后混入其他语言文案）。
 */
import { en } from './i18n/locales/en';
import { ptBr } from './i18n/locales/pt-br';
import { es419 } from './i18n/locales/es-419';
import { vi } from './i18n/locales/vi';
import { tr } from './i18n/locales/tr';
import { ko } from './i18n/locales/ko';
import { ja } from './i18n/locales/ja';
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
  [/注册/g, '註冊'],
  [/游戏/g, '遊戲'],
];

const ZH_TW_CHARS: Record<string, string> = {
  侧: '側', 针: '針',
  设: '設', 证: '證', 认: '認', 确: '確', 语: '語', 简: '簡', 体: '體', 请: '請',
  输: '輸', 检: '檢', 联: '聯', 络: '絡', 试: '試', 笔: '筆', 记: '記', 录: '錄',
  题: '題', 库: '庫', 仓: '倉', 资: '資', 历: '歷', 网: '網', 样: '樣', 预: '預', 显: '顯',
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
  // —— 全量文案审校补充（对照 OpenCC STCharacters 逐字核对，2026-11）——
  // 语义排除（简繁同形或台湾用法保留原字）：面(面試) 制(限制) 系(系統) 台(平台)
  // 只(只朗讀) 板 布(發布/佈局兩可) 注(注入；註冊走詞組) 干(干擾) 占 游(遊戲走詞組)
  万: '萬', 与: '與', 严: '嚴', 产: '產', 亲: '親', 仅: '僅', 从: '從', 们: '們',
  传: '傳', 内: '內', 决: '決', 况: '況', 准: '準', 减: '減', 划: '劃', 刚: '剛',
  创: '創', 够: '夠', 头: '頭', 学: '學', 将: '將', 岗: '崗', 帮: '幫', 广: '廣',
  庆: '慶', 强: '強', 径: '徑', 惯: '慣', 扫: '掃', 拟: '擬',
  拦: '攔', 挂: '掛', 据: '據', 摆: '擺', 数: '數', 约: '約', 纹: '紋',
  组: '組', 织: '織', 绍: '紹', 经: '經', 给: '給', 绝: '絕', 绪: '緒', 辑: '輯',
  缓: '緩', 编: '編', 举: '舉', 补: '補', 费: '費', 较: '較', 觉: '覺', 邮: '郵',
  温: '溫', 见: '見', 规: '規', 评: '評', 轨: '軌', 马: '馬', 骤: '驟', 浏: '瀏',
  东: '東', 志: '誌', 乱: '亂', 洁: '潔', 综: '綜', 栈: '棧', 说: '說', 麦: '麥',
  过: '過', 并: '並', 参: '參', 许: '許', 项: '項', 顿: '頓', 轮: '輪', 云: '雲',
  炼: '煉', 装: '裝', 采: '採', 着: '著', 粘: '黏', 范: '範', 独: '獨', 悬: '懸',
  弃: '棄', 达: '達', 钮: '鈕', 运: '運', 销: '銷', 专: '專', 伪: '偽', 离: '離',
  积: '積', 摄: '攝', 镜: '鏡', 须: '須', 储: '儲', 训: '訓', 热: '熱', 馈: '饋',
  状: '狀', 两: '兩', 异: '異', 画: '畫', 夹: '夾', 迁: '遷', 尽: '盡', 杂: '雜',
  双: '雙', 吗: '嗎', 后: '後', 响: '響', 唤: '喚', 筛: '篩', 条: '條',
  类: '類', 紧: '緊', 纠: '糾', 难: '難', 余: '餘', 础: '礎', 辅: '輔',
  获: '獲', 协: '協', 带: '帶', 来: '來', 电: '電',
};

/** 简体 → 繁体转换（zh-tw 字典由它实时生成；导出供测试校验转换完整性） */
export function toTraditional(text: string): string {
  let out = text;
  for (const [pattern, replacement] of ZH_TW_PHRASES) out = out.replace(pattern, replacement);
  let result = '';
  for (const ch of out) result += ZH_TW_CHARS[ch] ?? ch;
  return result;
}

const dictionaries: Partial<Record<Locale, Record<string, string>>> = {
  en,
  'pt-br': ptBr,
  'es-419': es419,
  vi,
  tr,
  ko,
  ja,
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
