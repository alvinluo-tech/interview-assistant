/*
 * 浮窗一键配色：截屏采样背景色 → 推导底色/字色/主题；支持恢复到上一次配色。
 * 面试与笔试浮窗共用，按钮和热键走同一条路径。
 */
import { captureScreen } from './bridge';
import { DEFAULT_OVERLAY_STYLE, getSetting, setSetting, type OverlayStyle } from './store';
import { normalizeStyle } from './overlayStyle';
import { applyPaletteLook } from './dualCamera';

export type PaletteScope = 'interview' | 'exam';

function backupKey(scope: PaletteScope): 'overlay.paletteBackup.interview' | 'overlay.paletteBackup.exam' {
  return scope === 'interview' ? 'overlay.paletteBackup.interview' : 'overlay.paletteBackup.exam';
}

export async function applyOverlayPalette(scope: PaletteScope): Promise<void> {
  const doc = document.documentElement;
  try {
    doc.classList.add('ov-palette-capturing');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const shot = await captureScreen({ protectedOnTop: true });
    doc.classList.remove('ov-palette-capturing');
    doc.classList.add('ov-palette-fade');
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = shot;
    });
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 64 / Math.max(img.width, img.height));
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    ctx?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (data) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4 * 37) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
      r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
      const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      // 先保存当前样式，热键「恢复配色」才能退回。
      await setSetting(backupKey(scope), normalizeStyle(getSetting<OverlayStyle>('overlay.style', DEFAULT_OVERLAY_STYLE)));
      await applyPaletteLook(scope, { bg: hex, fg: lum > 0.4 ? '#0f172a' : '#f8fafc', theme: lum > 0.4 ? 'light' : 'dark' });
    }
    window.setTimeout(() => doc.classList.remove('ov-palette-fade'), 1500);
  } catch {
    doc.classList.remove('ov-palette-capturing');
  }
}

export async function restoreOverlayPalette(scope: PaletteScope): Promise<void> {
  const backup = getSetting<OverlayStyle | null>(backupKey(scope), null);
  if (!backup) return;
  await setSetting('overlay.style', normalizeStyle(backup));
}
