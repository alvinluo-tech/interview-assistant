/*
 * 双机位（dualCamera）：第二个摄像头拍你和屏幕时，浮窗换「几乎全透明」外观。
 * 行为：
 * 开启 → 当前模式的透明度三件套存入 overlay.parkedLooks{mode}，浮窗切 PARKED_LOOK；
 * 关闭 → 从 parkedLooks 还原；一键配色在双机位下选更淡配色（这里实现为保持极低底色）。
 */
import { Switch } from '@/ui/primitives';
import { t } from './i18n';
import { DEFAULT_LOOK, PARKED_LOOK } from './overlayStyle';
import { DEFAULT_OVERLAY_STYLE, getSetting, setSetting, useSetting, type OverlayStyle } from './store';

export type OverlayScope = 'exam' | 'interview';

export interface ParkedLook {
  bgOpacity: number;
  textOpacity: number;
  borderOpacity: number;
}

const scopeKey = (scope: OverlayScope) => (scope === 'exam' ? 'exam.dualCamera' : 'interview.dualCamera');

function fieldsOf(scope: OverlayScope) {
  return scope === 'exam'
    ? { bg: 'examBgOpacity', text: 'examTextOpacity', border: 'examBorderOpacity' }
    : { bg: 'interviewBgOpacity', text: 'interviewTextOpacity', border: 'interviewBorderOpacity' };
}

export function isDualCameraOn(scope: OverlayScope): boolean {
  return getSetting<boolean>(scopeKey(scope), false) === true;
}

/** 开/关双机位：停放或还原当前模式外观。 */
export async function setDualCamera(scope: OverlayScope, on: boolean): Promise<void> {
  const style = getSetting<OverlayStyle>('overlay.style', DEFAULT_OVERLAY_STYLE);
  const parked = { ...getSetting<Record<string, ParkedLook>>('overlay.parkedLooks', {}) };
  const f = fieldsOf(scope);
  if (on) {
    if (!parked[scope]) {
      parked[scope] = {
        bgOpacity: Number((style as unknown as Record<string, number>)[f.bg] ?? DEFAULT_LOOK.bgOpacity),
        textOpacity: Number((style as unknown as Record<string, number>)[f.text] ?? DEFAULT_LOOK.textOpacity),
        borderOpacity: Number((style as unknown as Record<string, number>)[f.border] ?? DEFAULT_LOOK.borderOpacity),
      };
    }
    const next = {
      ...style,
      [f.bg]: PARKED_LOOK.bgOpacity,
      [f.text]: PARKED_LOOK.textOpacity,
      [f.border]: PARKED_LOOK.borderOpacity,
    } as OverlayStyle;
    // 先存还原信息再改外观：中途失败时外观还没变，下次关闭仍然还原得回去。
    await setSetting('overlay.parkedLooks', parked);
    await setSetting('overlay.style', next);
  } else {
    const saved = parked[scope] ?? DEFAULT_LOOK;
    const next = {
      ...style,
      [f.bg]: saved.bgOpacity,
      [f.text]: saved.textOpacity,
      [f.border]: saved.borderOpacity,
    } as OverlayStyle;
    delete parked[scope];
    await setSetting('overlay.style', next);
    await setSetting('overlay.parkedLooks', parked);
  }
  await setSetting(scopeKey(scope), on);
}

/** 配色结果落到 overlay.style；双机位开启时保持「几乎全透明」浓度 */
export async function applyPaletteLook(
  scope: OverlayScope,
  palette: { bg: string; fg: string; theme: 'light' | 'dark' },
): Promise<void> {
  const style = getSetting<OverlayStyle>('overlay.style', DEFAULT_OVERLAY_STYLE);
  const dual = isDualCameraOn(scope);
  const f = fieldsOf(scope);
  const patch: Record<string, unknown> = {
    paletteBg: palette.bg,
    paletteFg: palette.fg,
    theme: palette.theme,
  };
  if (dual) {
    patch[f.bg] = PARKED_LOOK.bgOpacity;
    patch[f.text] = PARKED_LOOK.textOpacity;
    patch[f.border] = PARKED_LOOK.borderOpacity;
  }
  await setSetting('overlay.style', { ...style, ...patch } as OverlayStyle);
}

/** 工作台里的双机位开关（本地状态由 store 订阅自动回填） */
export function DualCameraSwitch({ scope }: { scope: OverlayScope }) {
  const [on] = useSetting<boolean>(scope === 'exam' ? 'exam.dualCamera' : 'interview.dualCamera', false);
  return <Switch ariaLabel={t('双机位')} checked={on} onCheckedChange={(v: boolean) => void setDualCamera(scope, v)} />;
}
