/**
 * i18n 语言统一性守卫（语言统一 = 切换任何支持语言后不遗留其他语言文案）：
 * 1. 七个目标 locale 字典 key 完全对齐（缺失词条会回退英文，造成混排）。
 * 2. 非 CJK 语言的译文不得包含 CJK 字符（en/pt-br/es-419/vi/tr/ko/ja）。
 * 3. 占位符 {name} 必须在每个语言的译文中原样保留。
 * 4. translate() 端到端：注入 locale 后必须返回该语言译文而不是原文。
 * 5. zh-tw 由简繁转换实时生成：所有 key 转换后不得遗留简体特有字。
 * 6. 源码扫描：用户可见文案必须经过 t()（POLICY 白名单覆盖提示词/数据/词典本身）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { evaluateFixture, evaluateModuleFixture } from './compile-fixture.mjs';

const LOCALE_DIR = 'src/lib/i18n/locales';
const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const PLACEHOLDER = /\{([^{}]+)\}/; // 无 g：test() 不带状态
const placeholders = s => [...s.matchAll(/\{([^{}]+)\}/g)].map(m => m[1]); // 每次新建，无 lastIndex 污染
const NON_CJK_LOCALES = ['en', 'pt-br', 'es-419', 'vi', 'tr', 'ko', 'ja'];
// 日本新字体与简体中文同形的字（逐字审校冻结；如 声/画/内/学/体——转换器会映射它们，
// 但它们是 ja 的正字）。ja 检查时放行，其余被转换器映射的字符视为简体残留。
const JA_SHINJITAI = new Set('声画内志断参数区会体当状装号学点静万独条双触写余'.split(''));
const DICT_EXPORTS = { 'en.ts': 'en', 'pt-br.ts': 'ptBr', 'es-419.ts': 'es419', 'vi.ts': 'vi', 'tr.ts': 'tr', 'ko.ts': 'ko', 'ja.ts': 'ja' };

function loadDict(file) {
  return evaluateFixture(path.join(LOCALE_DIR, file), { exports: {} });
}

function loadDictionaries() {
  const dicts = {};
  for (const file of Object.keys(DICT_EXPORTS)) {
    const mod = loadDict(file);
    const exportName = DICT_EXPORTS[file];
    assert.ok(exportName in mod, `${file} must export ${exportName}`);
    dicts[file.replace('.ts', '')] = mod[exportName];
  }
  return dicts;
}

test('every supported locale dictionary covers exactly the same key set as en', () => {
  const dicts = loadDictionaries();
  const enKeys = Object.keys(dicts.en).sort();
  assert.ok(enKeys.length > 0, 'en dictionary must not be empty');
  for (const name of NON_CJK_LOCALES.slice(1)) {
    const keys = Object.keys(dicts[name]).sort();
    const missing = enKeys.filter(key => !keys.includes(key));
    const extra = keys.filter(key => !enKeys.includes(key));
    assert.deepEqual(missing, [], `${name} is missing translations (would fall back to English): ${missing.slice(0, 20).join(' | ')}`);
    assert.deepEqual(extra, [], `${name} has stale keys not present in en: ${extra.slice(0, 20).join(' | ')}`);
    for (const key of enKeys) {
      assert.ok(String(dicts[name][key]).trim(), `${name} has an empty translation for: ${key}`);
    }
  }
});

test('non-CJK locale translations never contain CJK characters', () => {
  const dicts = loadDictionaries();
  // ja 的值允许日本汉字；仅禁止简体特有字（zh-tw 转换器可识别的映射字符）。
  const i18n = evaluateModuleFixture('src/lib/i18n.ts', { exports: {} });
  for (const name of NON_CJK_LOCALES) {
    for (const [key, value] of Object.entries(dicts[name])) {
      if (name === 'ja') {
        const simplified = [...value].find(ch => CJK.test(ch) && i18n.toTraditional(ch) !== ch && !JA_SHINJITAI.has(ch));
        assert.ok(!simplified, `ja translation for "${key}" still contains simplified-only character "${simplified}": "${value}"`);
        continue;
      }
      const match = CJK.exec(value);
      assert.ok(!match, `${name} translation for "${key}" still contains CJK character "${match?.[0]}" (untranslated leftover): "${value}"`);
    }
  }
});

test('interpolation placeholders survive translation in every locale', () => {
  const dicts = loadDictionaries();
  for (const [name, dict] of Object.entries(dicts)) {
    for (const [key, value] of Object.entries(dict)) {
      const expected = placeholders(key).sort();
      const actual = placeholders(value).sort();
      assert.deepEqual(actual, expected, `${name} translation of "${key}" must keep placeholders {${expected.join(', ')}}`);
    }
  }
});

test('translate() serves each injected locale without falling back to the zh key', () => {
  const dicts = loadDictionaries();
  const keys = Object.keys(dicts.en);
  assert.ok(keys.length > 50, 'expected the full chrome dictionary, got very few keys');
  for (const locale of NON_CJK_LOCALES) {
    const i18n = evaluateModuleFixture('src/lib/i18n.ts', {
      exports: {},
      localStorage: { getItem: () => locale, setItem: () => {} },
      navigator: { language: locale },
    });
    const samples = [keys[0], keys[Math.floor(keys.length / 2)], keys[keys.length - 1]];
    for (const key of samples) {
      const out = i18n.t(key);
      if (locale === 'ja') {
        const simplified = [...out].find(ch => CJK.test(ch) && i18n.toTraditional(ch) !== ch && !JA_SHINJITAI.has(ch));
        assert.ok(!simplified, `ja.t() leaked simplified-only character "${simplified}" for key "${key}": "${out}"`);
      } else {
        assert.ok(!CJK.test(out), `${locale}.t() leaked CJK for key "${key}": "${out}"`);
      }
      assert.notEqual(out, key, `${locale}.t() returned the zh source key untranslated: "${key}"`);
    }
  }
});

test('translate() substitutes {placeholder} params', () => {
  const i18n = evaluateModuleFixture('src/lib/i18n.ts', {
    exports: {},
    localStorage: { getItem: () => 'en', setItem: () => {} },
    navigator: { language: 'en' },
  });
  const dicts = loadDictionaries();
  const paramKey = Object.keys(dicts.en).find(key => PLACEHOLDER.test(key) && dicts.en[key].includes('{'));
  if (!paramKey) return; // no parameterized keys yet
  const params = {};
  for (const name of placeholders(paramKey)) params[name] = '‡';
  const out = i18n.t(paramKey, params);
  assert.ok(!/\{[^{}]+\}/.test(out), `translate() left an unsubstituted placeholder: "${out}"`);
  assert.ok(out.includes('‡'), `translate() dropped the param value: "${out}"`);
});

test('zh-tw conversion leaves no simplified-only characters behind', () => {
  const i18n = evaluateModuleFixture('src/lib/i18n.ts', { exports: {} });
  const dicts = loadDictionaries();
  const keys = Object.keys(dicts.en);
  assert.ok(i18n.toTraditional, 'i18n must export toTraditional for verification');
  // 按完整 key 转换（词组优先、单字兜底，与运行时一致），检查转换结果是否残留简体字：
  // 1) 转换器还能继续映射的字（如 说→說）= 确凿的简体残留，直接失败；
  // 2) 转换器不映射的字若不在冻结快照内 = 新引入的未映射简体字，失败后扩充
  //    ZH_TW_PHRASES / ZH_TW_CHARS 并重新生成快照。快照含简繁同形字与繁体字
  // （面=面試、制=限制、系=系統、台=平台、只=只朗讀、注=注入、干=干擾、布=發布、
  // 占、板、抓为审校后台湾沿用原字；游=遊戲、注册=註冊走词组整词转换）。
  const SNAPSHOT = '一三上下不且並个中主之乎也亂了事二互些交享京人什今介仍他付代令以件任份似但位住何作你使來例供便保信修們候值偏做停偽備傳僅像價優儲允充先克免入內全兩八公共其具兼冊再军出函分切列则判別刪到制刷刻前剛剩剪副創劃力功加助動務勾勿包化北匹医區十半協南占即卸原去參及反取受口句另只可台史右司吃各合同名向否含告命和品員哪商問啟善喚單嗎器嚴四回因固国圈圍圖在地址均坡型域執基報場塊填境增壓外多夠大天太失夾套好如妥始姓子字存學宁它安完官定客家容密實寫寬射將專對導小少尚尝就尾局届屏展層履屬川工左己已布希師帶常幕干平年幾序底度倉庫建式引張強形影往待律後徑得從微心必忙快忽怎思急性恢息情想意態慢慧慶憶應懸成我或截戶所手才打托找承技把投担拆拍拒抓拓拖招括拿持指按挑挪捕捷掃授掉排掛採探接控描提換搜搶撞撤播擇擊操擎據擬擴擺攔攝支收改攻放效敏教整數文料新斷方於旁日旧早明易映是時普景晰智暗暫暴更書替最會有服朗望期未末本束東松板析果某查校核根格框案桌條梳棄棧業概構標模樣機檔檢欄權次止正此步歷歸段母每比求決沒河沿況法波注活流浅浮海消淡深混添清減測游源準溫滑滾滿演潔激濃瀏為無焦然煉照熱片版牌狀獨獲率現理環甘生產用由申界留略畫異當疗登發白百的盡盤目直相省看真瞬知短研碰確碼磁礎示禁私秒移程稍稱稿積穩究空穿突窄窗立站章端符第筆等答策算管箱節範篩簡簽米粗粤精系糾約紋純級索紹終組結絕給統經綜維網緒線編緩練縮繁織繼續缺置義習翻考者而聆聊聘聯聲職聽肃股育背能脑脚腾臨自至致與般色花若英萬落著蓋蔽藏虑處號螢行術衛衝表被補裝裡製複西要覆見規視親覺覽觀角解觸言訂計訊訓記訪設許註評詞詢試話該詳誌認語誤說調請論證識譯議護讀變讓象費貼資賬败走起超越足跑跟路跳身軌軟較載輔輪輯輸轉辨近返违追退送透逐途這通速連進遇運遍過道達適遴遷選避還邊那部郵都配釋重量鈕銷錄錯鍵鏈鏡鐘鑰長閉開間閱關闽防阻阿降限隆陕除隊隔際隨隱集雙雜離難雲電需靈靜非靠面音響頁頂項順須預頓頭頻題額類顯風飞餘饋首馬驗驟體高麥麼黏黑點鼠吧幫講楚附側針昨批';
  const approved = new Set([...SNAPSHOT]);
  const leftover = new Map();
  for (const key of keys) {
    const converted = i18n.toTraditional(key);
    assert.ok(converted && converted.trim(), `zh-tw conversion emptied key: ${key}`);
    for (const ch of converted) {
      if (!CJK.test(ch)) continue;
      if (i18n.toTraditional(ch) !== ch) {
        leftover.set(ch, (leftover.get(ch) || 0) + 1);
        continue;
      }
      if (!approved.has(ch)) leftover.set(ch, (leftover.get(ch) || 0) + 1);
    }
  }
  assert.deepEqual(
    [...leftover.keys()].sort(),
    [],
    `zh-tw conversion left simplified-only characters (extend ZH_TW_PHRASES/ZH_TW_CHARS or review the snapshot): ${[...leftover.entries()].sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${ch}×${n}`).join(' ')}`,
  );
});

// ---------------------------------------------------------------------------
// 源码扫描：用户可见的 CJK 文案必须经过 t()。
// POLICY：整文件豁免（提示词/词典/转换表）；行级豁免需写明理由。
// ---------------------------------------------------------------------------
const POLICY = {
  // 整文件豁免：key 即中文原文的词典与转换表 + 提示词/纯数据模块。
  // 提示词发送给模型不渲染到界面；数据表（标签/音色名/预置名/更新日志）一律在渲染点 t()
  // （各文件接线时已逐一核对），这些模块新增内容默认仍是提示词/数据。
  WHOLE_FILE: [
    'src/lib/i18n.ts',
    ...Object.keys(DICT_EXPORTS).map(f => `src/lib/i18n/locales/${f}`),
    // —— AI 提示词（发送给模型，不渲染）——
    'src/lib/ai.ts',
    'src/lib/aiContext.ts',
    'src/lib/freeChat.ts',
    'src/lib/mock.ts',
    'src/lib/taskPrompts.ts',
    'src/lib/knowledgeContext.ts',
    'src/lib/preparation.ts',
    'src/lib/examEngine.ts',
    // 题面解析：中文关键词是匹配「输入描述/示例/样例」等平台用词的正则，不渲染到界面。
    'src/lib/codeQuestion.ts',
    'src/lib/interviewEngine.ts',
    // —— 数据/专有名词（渲染点已 t()，此处为词表/持久化名）——
    'src/lib/aiConfig.ts',
    'src/lib/speechCatalog.ts',
    'src/lib/speechProfile.ts',
    'src/lib/speechProtocol.ts',
    'src/lib/speechTranslation.ts',
    'src/lib/ttsConfig.ts',
    'src/lib/hotkeys.ts',
    'src/lib/changelog.ts',
    'src/lib/updatePresentation.ts',
    'src/lib/backend.ts',
  ],
  // 行级豁免：file → [{ match: 正则（对去注释后的整行）, reason: 理由 }]
  LINE: {
    // 常量表定义（key 保留中文原文，渲染点 {t(n.label)} 等）
    'src/main/MainWindow.tsx': [
      { match: /label: '|desc: '|h1: '|sub: '|h1:'|sub:'/ , reason: '导航/页题常量表，渲染点 t()' },
    ],
    'src/main/Onboarding.tsx': [
      { match: /const STEPS = \[/, reason: '步骤名常量表，渲染点 t()' },
    ],
    'src/main/UsageNotice.tsx': [
      { match: /^\s*'/, reason: '禁考清单常量表，渲染点 t()' },
    ],
    'src/main/UpdateNotice.tsx': [
      { match: /'下载更新', '校验文件', '准备安装'/, reason: '安装步骤常量，渲染点 t(label)' },
    ],
    'src/main/sections/AiServicesTab.tsx': [
      { match: /^(chat|vision|stt|tts): '/, reason: '能力描述常量表，渲染点 t()' },
      { match: /Fun-ASR 实时识别/, reason: '预置模型显示名（持久化数据，同音色名豁免）' },
      { match: /voice\.speak\(/, reason: 'TTS 试音内容（发送给语音服务，非界面 chrome）' },
    ],
    'src/main/sections/InterviewWorkbench.tsx': [
      { match: /title: '|desc: '/, reason: '面试方式/特性卡常量表，渲染点 t()' },
    ],
    'src/main/sections/SettingsPage.tsx': [
      { match: /label:\s*'|desc: '|name: '默认样式|name: '几乎全透明/, reason: 'tab/主题/预设/热键方案常量表，渲染点 t()' },
      { match: /(label|title|desc)="[^"]*[\u4e00-\u9fff][^"]*"/, reason: 'SliderRow/SizeRow 的 key 实参，组件内 {t(label)} 渲染' },
    ],
    'src/main/sections/StorageSettings.tsx': [
      { match: /^\s*\['(data|attachments|backups|cache|logs)'/, reason: '存储分类常量表，渲染点 t()' },
    ],
    'src/main/sections/QuestionBankPage.tsx': [
      { match: /(resume_deep|job_skill|company|behavior|reverse): '|text: '优先准备|text: '建议准备|text: '拓展准备|EXPERIENCE_OPTIONS = \[/, reason: '分类/优先级/经验常量表，渲染点 t()' },
    ],
    'src/main/sections/JobProgressCards.tsx': [
      { match: /label: '/, reason: '进度标签常量表，渲染点 t()' },
    ],
    'src/main/sections/MockPage.tsx': [
      { match: /label: '/, reason: '难度常量表，渲染点 t()' },
      { match: /title: `模拟面试|difficultyLabel: /, reason: '持久化的会话标题/难度值（用户数据）' },
    ],
    'src/main/sections/RecordsPage.tsx': [
      { match: /toLocaleString\('zh-CN'\)|mdToPlain\(|复盘报告\\n|\/\^第|消息数/, reason: '导出 Markdown 文本（剪贴板文档内容，非界面）与题号正则' },
    ],
    'src/main/sections/SpeechProfilePanel.tsx': [
      { match: /技术面试问题/, reason: '传给 speechRenderSpec 的语言检测输入，非界面文案' },
    ],
    'src/overlay/GenerationDetails.tsx': [
      { match: /truncated: '/, reason: '状态→文案映射表，渲染点 t(label)' },
    ],
    'src/overlay/InterviewOverlay.tsx': [
      { match: /followUp\(\{ message: /, reason: '发给 AI 的追问指令（提示词）' },
    ],
    'src/overlay/Md.tsx': [
      { match: /行内格式|isLabel = /, reason: '注释与答案标签匹配正则（逻辑）' },
    ],
    'src/mock/MockApp.tsx': [
      { match: /const message = reportRequest/, reason: '持久化的 reportError 原文，渲染点 t()' },
    ],
    'src/lib/documentImport.ts': [
      { match: /system: '你是文档文字提取器|请逐字提取图片中的正文/, reason: 'OCR 提取提示词' },
    ],
    'src/lib/ttsProtocol.ts': [
      { match: /面试官语气朗读|语速约为正常速度的/, reason: 'TTS 朗读指令（发送给语音服务）' },
    ],
    'src/lib/documentIngest.ts': [
      { match: /【第 \$\{i \+ 1\} 页】/, reason: '导入文档正文中的分页标记（随内容持久化）' },
    ],
    'src/lib/dualScreen.ts': [
      { match: /brand: '面绪'/, reason: '品牌名' },
    ],
  },
};

function stripComments(source) {
  // 状态机：逐字符扫描，剥离 // 与 /* */，正确跳过字符串/模板字符串字面量
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (ch === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { state = `str-${ch}`; out += ch; i += 1; continue; }
      out += ch; i += 1; continue;
    }
    if (state === 'line') {
      if (ch === '\n') { state = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (ch === '\n') out += '\n';
      i += 1; continue;
    }
    // 字符串内部
    if (ch === '\\') { out += source.slice(i, i + 2); i += 2; continue; }
    if (ch === state.slice(4)) { state = 'code'; out += ch; i += 1; continue; }
    out += ch; i += 1;
  }
  return out;
}

function tSpans(stripped) {
  // 收集 t(...) 调用的整个括号跨度（含 t(cond ? '中文' : '中文', {...}) 这类表达式参数）
  const spans = [];
  const re = /(?<![\w$.])t\(/g;
  let m;
  while ((m = re.exec(stripped))) {
    let depth = 0;
    let i = m.index + 1;
    for (; i < stripped.length; i++) {
      const ch = stripped[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      else if (ch === '"' || ch === "'" || ch === '`') {
        // 跳过字符串字面量内部的括号
        const quote = ch;
        i++;
        while (i < stripped.length && stripped[i] !== quote) { if (stripped[i] === '\\') i++; i++; }
      }
    }
    spans.push([m.index, i]);
  }
  return spans;
}

test('source scan: user-visible CJK strings must go through t()', () => {
  const violations = [];
  const roots = ['src/main', 'src/overlay', 'src/mock', 'src/ui', 'src/lib'];
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fp);
      else if (/\.(tsx?|ts)$/.test(entry.name)) files.push(fp.replace(/\\/g, '/'));
    }
  };
  for (const root of roots) walk(root);

  for (const file of files) {
    if (POLICY.WHOLE_FILE.includes(file)) continue;
    const source = readFileSync(file, 'utf8');
    const stripped = stripComments(source);
    if (!CJK.test(stripped)) continue;
    const spans = tSpans(stripped);
    const inT = index => spans.some(([a, b]) => index >= a && index < b);
    const lines = stripped.split('\n');
    let offset = 0;
    for (const [lineNo, line] of lines.entries()) {
      offset += line.length + 1;
      const matches = [...line.matchAll(new RegExp(CJK, 'g'))];
      if (!matches.length) continue;
      // 行内 CJK 全部位于 t() 字符串内才通过（JSX 文本 {t('…')} 亦覆盖）
      const absolute = [...matches].map(m => offset - line.length - 1 + m.index);
      if (absolute.every(inT)) continue;
      const trimmed = line.trim();
      const allowed = (POLICY.LINE[file] || []).some(rule => rule.match.test(trimmed));
      if (allowed) continue;
      violations.push(`${file}:${lineNo + 1}: ${trimmed.slice(0, 160)}`);
    }
  }
  assert.deepEqual(violations, [], `Unlocalized user-visible strings found (wrap in t() or justify in POLICY):\n${violations.join('\n')}`);
});
