/*
 * 浮窗皮肤计算：精确移植原版公式（TC:24976-25218 的 ly/uy/iy/ay/ny 全链）。
 * 输入 overlay.style + 模式，输出壳层 inline style 与 CSS 变量表。
 */
import type { OverlayStyle } from './store';

export type OverlayMode = 'exam' | 'interview';

/** 样式归一化（原版 kb） */
export function normalizeStyle(style: Partial<OverlayStyle>): OverlayStyle {
  const clamp = (v: number, min: number, max: number, d: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d;
  const s = style;
  return {
    theme: s.theme === 'dark' ? 'dark' : 'light',
    examBgOpacity: clamp(Number(s.examBgOpacity ?? 0.85), 0, 1, 0.85),
    examBorderOpacity: clamp(Number(s.examBorderOpacity ?? 0), 0, 1, 0),
    examHeight: clamp(Number(s.examHeight ?? 520), 80, 2560, 520),
    examTextOpacity: clamp(Number(s.examTextOpacity ?? 1), 0, 1, 1),
    examWidth: clamp(Number(s.examWidth ?? 420), 120, 2560, 420),
    fontScale: clamp(Number(s.fontScale ?? 1), 0.3, 4, 1),
    hotkeyOpacityStep: clamp(Number(s.hotkeyOpacityStep ?? 0.1), 0.01, 1, 0.1),
    interviewBgOpacity: clamp(Number(s.interviewBgOpacity ?? 0.85), 0, 1, 0.85),
    interviewBorderOpacity: clamp(Number(s.interviewBorderOpacity ?? 0), 0, 1, 0),
    interviewHeight: clamp(Number(s.interviewHeight ?? 620), 80, 2560, 620),
    interviewTextOpacity: clamp(Number(s.interviewTextOpacity ?? 1), 0, 1, 1),
    interviewWidth: clamp(Number(s.interviewWidth ?? 400), 120, 2560, 400),
    paletteBg: typeof s.paletteBg === 'string' ? s.paletteBg : '',
    paletteFg: typeof s.paletteFg === 'string' ? s.paletteFg : '',
    scrollSpeed: clamp(Number(s.scrollSpeed ?? 1), 0.05, 5, 1),
    textBold: Boolean(s.textBold),
    textHalo: s.textHalo !== false,
  };
}

const LIGHT_SURFACE = '#ffffff';
const LIGHT_INK = '#0f172a';
const DARK_SURFACE = '#0f172a';
const DARK_INK = '#f8fafc';

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export interface Skin {
  theme: 'light' | 'dark';
  shellBg: string;
  surfaceBg: string;
  pillBg: string;
  borderColor: string;
  outerBorderColor: string;
  textColor: string;
  shellShadow: string;
  vars: Record<string, string>;
}

/** 文字光晕（原版 ny） */
function haloCss(
  textHalo: boolean,
  bgOpacity: number,
  textOpacity: number,
  haloColor: string,
): string {
  if (!textHalo) return 'none';
  const ty = Math.max(0, Math.min(0.9, 1.15 - bgOpacity * 1.25));
  const i = ty * textOpacity;
  if (i <= 0.02) return 'none';
  const c = haloColor;
  return [
    `1px 0 0 rgba(${c},${i})`,
    `-1px 0 0 rgba(${c},${i})`,
    `0 1px 0 rgba(${c},${i})`,
    `0 -1px 0 rgba(${c},${i})`,
    `0 0 4px rgba(${c},${Math.min(0.95, i + 0.05)})`,
  ].join(', ');
}

/** 皮肤（原版 dy → ly/uy） */
export function computeSkin(style: OverlayStyle, mode: OverlayMode): Skin {
  const isDark = style.theme === 'dark';
  const bgOpacity = mode === 'exam' ? style.examBgOpacity : style.interviewBgOpacity;
  const textOpacity = mode === 'exam' ? style.examTextOpacity : style.interviewTextOpacity;
  const borderOpacity = mode === 'exam' ? style.examBorderOpacity : style.interviewBorderOpacity;

  // palette 覆盖
  let surface = isDark ? DARK_SURFACE : LIGHT_SURFACE;
  let ink = isDark ? DARK_INK : LIGHT_INK;
  let haloColor = isDark ? '2,6,23' : '255,255,255';
  const paletteValid = /^#[0-9a-fA-F]{6}$/.test(style.paletteBg) && /^#[0-9a-fA-F]{6}$/.test(style.paletteFg);
  let theme: 'light' | 'dark' = isDark ? 'dark' : 'light';
  if (paletteValid) {
    surface = style.paletteBg;
    ink = style.paletteFg;
    theme = relativeLuminance(style.paletteBg) > 0.4 ? 'light' : 'dark';
    haloColor = hexToRgb(style.paletteBg).join(',');
  }

  const ey = Math.min(1, bgOpacity / 0.2); // 底色 ≤20% 后控件浓度线性趋零

  const shellBg = `rgba(${cssRgb(surface)}, ${bgOpacity.toFixed(3)})`;
  const surfaceT = Math.min(0.95, bgOpacity * 0.75 + 0.02) * ey;
  const surfaceBg = `rgba(${cssRgb(surface)}, ${surfaceT.toFixed(3)})`;
  const pillBg = `rgba(${cssRgb(surface)}, ${(0.9 * ey).toFixed(3)})`;
  const borderColor = `rgba(${cssRgb(ink)}, ${((isDark ? 0.1 : 0.08) * ey).toFixed(3)})`;

  let outerBorderColor: string;
  let shellShadow: string;
  if (bgOpacity < 0.04) {
    outerBorderColor =
      borderOpacity > 0 ? `rgba(${cssRgb(ink)}, ${borderOpacity.toFixed(3)})` : 'transparent';
    shellShadow = borderOpacity > 0 ? `0 0 0 1px rgba(${cssRgb(ink)}, ${borderOpacity.toFixed(3)})` : 'none';
  } else {
    const ow = Math.max(borderOpacity, (isDark ? 0.2 : 0.14) * ey);
    outerBorderColor = `rgba(${cssRgb(ink)}, ${ow.toFixed(3)})`;
    shellShadow = `0 2px 10px rgba(15,23,42,${(0.06 * ey).toFixed(3)}), 0 0 0 1px rgba(${cssRgb(ink)}, ${ow.toFixed(3)})`;
  }

  const ink2 = paletteValid ? mix(style.paletteFg, style.paletteBg, 0.15) : isDark ? '#cbd5e1' : '#334155';
  const ink3 = paletteValid ? mix(style.paletteFg, style.paletteBg, 0.25) : isDark ? '#94a3b8' : '#64748b';

  const chipT = theme === 'dark' ? Math.min(0.75, bgOpacity * 1.2 + 0.3) : Math.min(0.9, bgOpacity * 1.7 + 0.14);
  const chipActiveT = theme === 'dark'
    ? Math.min(0.98, bgOpacity * 1.7 + 0.42)
    : Math.min(0.98, bgOpacity * 1.7 + 0.42);

  const vars: Record<string, string> = {
    '--ov-font-scale': String(style.fontScale),
    '--ov-fg': cssRgba(ink, textOpacity),
    '--ov-fg-2': cssRgba(ink2, textOpacity),
    '--ov-fg-3': cssRgba(ink3, textOpacity),
    '--ov-halo': haloCss(style.textHalo, bgOpacity, textOpacity, haloColor),
    '--ov-line': `rgba(${cssRgb(ink)}, ${((isDark ? 0.16 : 0.12) * ey).toFixed(3)})`,
    '--ov-line-strong': `rgba(${cssRgb(ink)}, ${((isDark ? 0.34 : 0.28) * ey).toFixed(3)})`,
    '--ov-chip-bg': `rgba(${cssRgb(surface)}, ${(chipT * ey).toFixed(3)})`,
    '--ov-chip-border': `rgba(${cssRgb(ink)}, ${(0.18 * ey).toFixed(3)})`,
    '--ov-chip-active-bg': `rgba(${cssRgb(surface)}, ${(chipActiveT * ey).toFixed(3)})`,
    '--ov-chip-active-border': `rgba(${cssRgb(ink)}, ${(0.36 * ey).toFixed(3)})`,
    '--ov-bar': `rgba(${cssRgb(ink)}, ${(0.45 * textOpacity).toFixed(3)})`,
    '--ov-pill-bg': `rgba(${cssRgb(surface)}, ${(0.92 * ey).toFixed(3)})`,
    '--ov-dot': `rgba(${cssRgb(ink)}, ${(0.72 * textOpacity).toFixed(3)})`,
    '--ov-md-quote': `rgba(${cssRgb(ink)}, ${(0.3 * ey).toFixed(3)})`,
    '--ov-md-hr': `rgba(${cssRgb(ink)}, ${(0.14 * ey).toFixed(3)})`,
    '--ov-md-table-line': `rgba(${cssRgb(ink)}, ${(0.16 * ey).toFixed(3)})`,
    '--ov-md-surface': `rgba(${cssRgb(ink)}, ${(0.06 * ey).toFixed(3)})`,
    '--ov-md-code-line': `rgba(${cssRgb(ink)}, ${(0.1 * ey).toFixed(3)})`,
    '--ov-md-inline-bg': `rgba(${cssRgb(ink)}, ${(0.1 * ey).toFixed(3)})`,
  };
  if (style.textBold) {
    vars['--ov-fw'] = '700';
  }

  return {
    theme,
    shellBg,
    surfaceBg,
    pillBg,
    borderColor,
    outerBorderColor,
    textColor: `rgba(${cssRgb(ink)}, ${textOpacity.toFixed(3)})`,
    shellShadow,
    vars,
  };
}

function cssRgb(hexOrRgb: string): string {
  if (hexOrRgb.startsWith('rgb')) return hexOrRgb.replace(/^rgb\(|\)$/g, '');
  const [r, g, b] = hexToRgb(hexOrRgb);
  return `${r},${g},${b}`;
}

function cssRgba(color: string, alpha: number): string {
  return `rgba(${cssRgb(color)}, ${alpha.toFixed(3)})`;
}

/** 一键配色 undo 记录 */
export interface PaletteUndo {
  before: Partial<OverlayStyle>;
}

/** 双机位外观（原版 Nb） */
export const PARKED_LOOK = { bgOpacity: 0.03, textOpacity: 1, borderOpacity: 0.12 };
/** 默认 look（原版 Mb） */
export const DEFAULT_LOOK = { bgOpacity: 0.85, textOpacity: 1, borderOpacity: 0 };
