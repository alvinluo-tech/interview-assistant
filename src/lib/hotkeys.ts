/*
 * 浮窗快捷键：18 个动作、simple / conflict-free 双方案全表、退役键迁移、
 * 键位捕获与徽标格式化。全部表格对齐原版（BS:25516-25638）。
 */

export const ACTIONS = [
  'scroll-up',
  'scroll-down',
  'answer',
  'capture',
  'voice-ask',
  'move-left',
  'move-right',
  'move-up',
  'move-down',
  'copy-code',
  'size-up',
  'size-down',
  'opacity-down',
  'opacity-up',
  'text-opacity-down',
  'text-opacity-up',
  'auto-palette',
  'restore-palette',
] as const;

export type ActionKey = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<ActionKey, { label: string; desc: string }> = {
  'scroll-up': { label: '向上滚动', desc: '回看上面的内容' },
  'scroll-down': { label: '向下滚动', desc: '看新生成的内容' },
  answer: { label: '答题 / 回答', desc: '笔试：解题；面试：立即回答，笔试答题里为截屏答题 / 接住追问' },
  capture: { label: '截屏 / 笔试答题', desc: '重新截屏 / 加页' },
  'voice-ask': { label: '语音提问', desc: '按一下开始说话，再按一下结束，AI 回答你说的问题' },
  'move-left': { label: '浮窗左移', desc: '按住不放持续往左挪，松开停下' },
  'move-right': { label: '浮窗右移', desc: '同上' },
  'move-up': { label: '浮窗上移', desc: '同上' },
  'move-down': { label: '浮窗下移', desc: '同上' },
  'copy-code': { label: '复制答案', desc: '笔试：答案里有代码就复制代码，没有代码就复制答案文字' },
  'size-up': { label: '浮窗放大', desc: '按一下宽高各放大一档，面试和笔试浮窗各记各的' },
  'size-down': { label: '浮窗缩小', desc: '同上' },
  'opacity-down': { label: '底色更透明', desc: '每档多少在「浮窗样式」里设置，默认 10%，一直按到 0% 只剩文字' },
  'opacity-up': { label: '底色更不透明', desc: '最高到 100%' },
  'text-opacity-down': { label: '文字更透明', desc: '同上' },
  'text-opacity-up': { label: '文字更不透明', desc: '最高到 100%' },
  'auto-palette': { label: '一键配色', desc: 'AI 看浮窗后面的画面，换一身最不显眼的底色、字色和透明度' },
  'restore-palette': { label: '恢复配色', desc: '换回按「一键配色」之前的底色、字色和透明度' },
};

export type HotkeyScheme = 'simple' | 'conflict-free';

/** 默认键位表（simple 与 conflict-free） */
export const SCHEME_DEFAULTS: Record<HotkeyScheme, Record<ActionKey, string>> = {
  simple: {
    'scroll-up': 'CmdOrCtrl+Up',
    'scroll-down': 'CmdOrCtrl+Down',
    answer: 'CmdOrCtrl+Enter',
    capture: 'CmdOrCtrl+H',
    'voice-ask': 'CmdOrCtrl+T',
    'move-left': 'CmdOrCtrl+Left',
    'move-right': 'CmdOrCtrl+Right',
    'move-up': 'CmdOrCtrl+PageUp',
    'move-down': 'CmdOrCtrl+PageDown',
    'copy-code': 'CmdOrCtrl+K',
    'size-up': 'CmdOrCtrl+Equal',
    'size-down': 'CmdOrCtrl+Minus',
    'opacity-down': 'CmdOrCtrl+[',
    'opacity-up': 'CmdOrCtrl+]',
    'text-opacity-down': 'CmdOrCtrl+;',
    'text-opacity-up': "CmdOrCtrl+'",
    'auto-palette': 'CmdOrCtrl+\\',
    'restore-palette': 'CmdOrCtrl+Shift+\\',
  },
  'conflict-free': {
    'scroll-up': 'CmdOrCtrl+Alt+Shift+Up',
    'scroll-down': 'CmdOrCtrl+Alt+Shift+Down',
    answer: 'CmdOrCtrl+Alt+Shift+Enter',
    capture: 'CmdOrCtrl+Alt+Shift+S',
    'voice-ask': 'CmdOrCtrl+Alt+Shift+T',
    'move-left': 'CmdOrCtrl+Alt+Shift+Left',
    'move-right': 'CmdOrCtrl+Alt+Shift+Right',
    'move-up': 'CmdOrCtrl+Alt+Shift+PageUp',
    'move-down': 'CmdOrCtrl+Alt+Shift+PageDown',
    'copy-code': 'CmdOrCtrl+Alt+Shift+C',
    'size-up': 'CmdOrCtrl+Alt+Shift+Equal',
    'size-down': 'CmdOrCtrl+Alt+Shift+Minus',
    'opacity-down': 'CmdOrCtrl+Alt+Shift+[',
    'opacity-up': 'CmdOrCtrl+Alt+Shift+]',
    'text-opacity-down': 'CmdOrCtrl+Alt+Shift+;',
    'text-opacity-up': "CmdOrCtrl+Alt+Shift+'",
    'auto-palette': 'CmdOrCtrl+Alt+Shift+\\',
    'restore-palette': 'CmdOrCtrl+Alt+Shift+/',
  },
};

export const DEFAULT_PANIC_HOTKEY = 'CommandOrControl+Shift+X';

/** 2026-10-17 之后注册的新用户默认 simple（原版分界日） */
const SCHEME_SWITCH_DATE = new Date('2026-10-17T00:00:00+08:00').getTime();

export function defaultSchemeForUser(createdAt?: number | null): HotkeyScheme {
  const t = createdAt ?? Date.now();
  return t >= SCHEME_SWITCH_DATE ? 'simple' : 'conflict-free';
}

/** 退役默认键迁移（原版 SE） */
const RETIRED_DEFAULTS: Partial<Record<ActionKey, string>> = {
  'scroll-up': 'CmdOrCtrl+Shift+Up',
  'scroll-down': 'CmdOrCtrl+Shift+Down',
  answer: 'CmdOrCtrl+Shift+Enter',
  capture: 'CmdOrCtrl+Shift+S',
  'voice-ask': 'CmdOrCtrl+Shift+M',
};

export function migrateRetired(
  custom: Partial<Record<ActionKey, string>>,
  scheme: HotkeyScheme,
): { migrated: boolean; next: Partial<Record<ActionKey, string>> } {
  let migrated = false;
  const next = { ...custom };
  for (const [action, retired] of Object.entries(RETIRED_DEFAULTS)) {
    const a = action as ActionKey;
    if (next[a] === retired) {
      next[a] = SCHEME_DEFAULTS[scheme][a];
      migrated = true;
    }
  }
  return { migrated, next };
}

/** 当前生效键位（自定义覆盖方案默认） */
export function effectiveHotkeys(
  scheme: HotkeyScheme,
  custom: Partial<Record<ActionKey, string>>,
): Record<ActionKey, string> {
  const base = { ...SCHEME_DEFAULTS[scheme] };
  for (const [k, v] of Object.entries(custom)) {
    if (typeof v === 'string') {
      (base as Record<ActionKey, string>)[k as ActionKey] = v;
    }
  }
  return base;
}

/** accelerator → 徽标显示（mac 用符号，win 用文字） */
export function hotkeyBadge(accelerator: string | undefined, isMac = false): string {
  if (!accelerator) return '';
  let s = accelerator.replace(/CommandOrControl|CmdOrCtrl/gi, isMac ? 'Cmd' : 'Ctrl');
  s = s.replace(/Command/g, 'Cmd').replace(/Control/g, 'Ctrl');
  if (isMac) {
    return s
      .replace(/Shift/g, '⇧')
      .replace(/Alt/g, '⌥')
      .replace(/Cmd/g, '⌘')
      .replace(/Ctrl/g, '⌃')
      .replace(/Enter/g, '⏎')
      .replace(/PageUp/g, '⇞')
      .replace(/PageDown/g, '⇟')
      .replace(/Up/g, '↑')
      .replace(/Down/g, '↓')
      .replace(/Left/g, '←')
      .replace(/Right/g, '→');
  }
  return s
    .replace(/PageUp/g, 'PgUp')
    .replace(/PageDown/g, 'PgDn')
    .replace(/Enter/g, '↵')
    .replace(/Up/g, '↑')
    .replace(/Down/g, '↓')
    .replace(/Left/g, '←')
    .replace(/Right/g, '→');
}

export interface CapturedKey {
  accelerator: string;
  error?: string;
}

/** keydown 事件 → Tauri accelerator（设置页录键用） */
export function keyEventToAccelerator(e: KeyboardEvent): CapturedKey {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Control');
  if (e.metaKey) parts.push('Super');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let key = e.code;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (/^Digit\d$/.test(key)) key = key.slice(5);
  else if (/^Numpad\d$/.test(key)) key = 'num' + key.slice(6);
  else if (/^F\d{1,2}$/.test(key)) {
    // 保留 F1-F24
  } else {
    const map: Record<string, string> = {
      Enter: 'Enter', Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete',
      Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
      Tab: 'Tab', Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left',
      ArrowRight: 'Right', Equal: '=', Minus: '-', BracketLeft: '[', BracketRight: ']',
      Semicolon: ';', Quote: "'", Backslash: '\\', Comma: ',', Period: '.', Slash: '/',
      Backquote: '`', CapsLock: 'CapsLock', PrintScreen: 'PrintScreen', ScrollLock: 'ScrollLock',
      Pause: 'Pause', ContextMenu: 'Menu', NumpadAdd: 'numadd', NumpadSubtract: 'numsub',
      NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
    };
    key = map[key] ?? key;
  }
  if (['Control', 'Alt', 'Shift', 'Super'].includes(key)) {
    return { accelerator: '', error: '修饰键需与其他键组合' };
  }
  parts.push(key);
  return { accelerator: parts.join('+') };
}
