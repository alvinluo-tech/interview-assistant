/*
 * 浮窗应用根组件：心跳（5s）、overlay-shown/hidden 事件、会话握手、
 * 位置恢复、热键（移动/尺寸/透明度/配色）注册、模式路由。
 * 对齐原版 mJ/hJ 的生命周期与常量。
 */
import { useEffect, useRef, useState } from 'react';
import { getCurrentWindow, currentMonitor } from '@tauri-apps/api/window';
import {
  overlayHeartbeat,
  overlaySessionReady,
  overlayShowSeq,
  setOverlaySize,
  positionOverlay,
  onEvent,
} from '@/lib/bridge';
import { getSetting, setSetting, useSetting, DEFAULT_OVERLAY_STYLE, type OverlayStyle } from '@/lib/store';
import { normalizeStyle, type OverlayMode } from '@/lib/overlayStyle';
import { ExamOverlay } from './ExamOverlay';
import { InterviewOverlay } from './InterviewOverlay';
import { OverlayPlatformProvider } from './platform';
import { persistPosition } from './widgets';

type ActiveMode = 'exam' | 'interview' | 'preview' | 'interview-preview';

export function OverlayApp() {
  const [active, setActive] = useState(false);
  const [seq, setSeq] = useState(0);
  const [showSeq, setShowSeq] = useState(0);
  const seqRef = useRef(0);
  const styleSetting = useSetting('overlay.style', DEFAULT_OVERLAY_STYLE)[0];
  const style: OverlayStyle = normalizeStyle(styleSetting);

  // 心跳
  useEffect(() => {
    overlayHeartbeat();
    const timer = window.setInterval(overlayHeartbeat, 5000);
    return () => window.clearInterval(timer);
  }, []);

  // 显示/隐藏事件 → 会话状态
  useEffect(() => {
    const offShown = onEvent<{ seq: number }>('overlay-shown', (p) => {
      if (p.seq > 0 && seqRef.current >= p.seq) return;
      seqRef.current += 1;
      setActive(true);
      setSeq(seqRef.current);
      setShowSeq(p.seq);
    });
    const offHidden = onEvent('overlay-hidden', () => {
      setActive(false);
      if (seqMode() === 'interview') void import('@/lib/interviewEngine').then(engine => engine.endInterview(false));
    });
    // 启动时主动查一次（崩溃恢复场景原生已显示）
    void (async () => {
      try {
        const s = await overlayShowSeq();
        if (s > 0) {
          seqRef.current += 1;
          setActive(true);
          setSeq(seqRef.current);
          setShowSeq(s);
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      offShown();
      offHidden();
    };
  }, []);

  // 会话握手 + 位置恢复 + 热键注册
  useEffect(() => {
    if (!active) return;
    const business = seqMode() === 'exam' || seqMode() === 'interview';
    overlaySessionReady(showSeq, business);
    restorePosition();
    const offPersist = onEvent('drag-mode-changed', (p) => {
      if (!(p as { active?: boolean }).active) {
        window.setTimeout(persistPosition, 300);
      }
    });
    return offPersist;
  }, [active, showSeq, seq]);

  // 尺寸同步
  useEffect(() => {
    if (!active) return;
    const mode = seqMode();
    const key = mode === 'interview' || mode === 'interview-preview' ? 'interview' : 'exam';
    const w = key === 'interview' ? style.interviewWidth : style.examWidth;
    const h = key === 'interview' ? style.interviewHeight : style.examHeight;
    if (Math.abs(window.innerWidth - w) > 3 || Math.abs(window.innerHeight - h) > 3) {
      setOverlaySize(w, h).catch(() => {});
    }
  }, [active, style.interviewWidth, style.interviewHeight, style.examWidth, style.examHeight]);

  // 手机副屏接管（exam-dual）：无连接时静默待机，手机上线后隐身本地浮窗
  useEffect(() => {
    if (!active) return;
    if (seqMode() !== 'exam') return;
    let disposed = false;
    let cleanup: (() => void) | null = null;
    void import('@/lib/dualScreen').then(({ startDualTakeover }) => {
      if (!disposed) cleanup = startDualTakeover();
    });
    return () => { disposed = true; cleanup?.(); };
  }, [active, seq]);

  function seqMode(): ActiveMode {
    return (getSetting('overlay.mode', 'exam') as ActiveMode) ?? 'exam';
  }

  if (!active) return null;

  const mode = seqMode();
  const key = `${mode}-${seq}`;
  const isInterview = mode === 'interview' || mode === 'interview-preview';
  const isPreview = mode === 'preview' || mode === 'interview-preview';

  return (
    <OverlayPlatformProvider
      key={key}
      mode={isInterview ? 'interview' : 'exam'}
      interactive={isPreview ? true : undefined}
    >
      {isInterview ? <InterviewOverlay preview={isPreview} /> : <ExamOverlay preview={isPreview} />}
    </OverlayPlatformProvider>
  );
}

async function restorePosition() {
  try {
    const pos = getSetting('overlay.position', null) as { x: number; y: number } | null;
    if (pos) {
      await positionOverlay({ x: pos.x, y: pos.y });
    }
  } catch {
    // ignore
  }
}

/** 浮窗热键注册：移动 / 尺寸 / 透明度 / 一键配色（原版 XE + vK） */
export function useOverlayStyleHotkeys(style: OverlayStyle, mode: OverlayMode) {
  useEffect(() => {
    const unlisteners: (() => void)[] = [];
    const off = onEvent<{ action: string; pressed: boolean }>('action-hotkeys', async (p) => {
      if (!p.pressed) return;
      const sizeKey = mode === 'interview' ? 'interview' : 'exam';
      const patch: Partial<OverlayStyle> = {};
      switch (p.action) {
        case 'move-left':
        case 'move-right':
        case 'move-up':
        case 'move-down':
          await moveOverlay(p.action);
          return;
        case 'size-up': {
          const w = sizeKey === 'interview' ? style.interviewWidth : style.examWidth;
          const h = sizeKey === 'interview' ? style.interviewHeight : style.examHeight;
          const nw = clampDim(Math.round(Math.max(w, h) * 1.1));
          if (sizeKey === 'interview') {
            patch.interviewWidth = nw;
            patch.interviewHeight = clampDim(Math.round((h * nw) / w));
          } else {
            patch.examWidth = nw;
            patch.examHeight = clampDim(Math.round((h * nw) / w));
          }
          break;
        }
        case 'size-down': {
          const w = sizeKey === 'interview' ? style.interviewWidth : style.examWidth;
          const h = sizeKey === 'interview' ? style.interviewHeight : style.examHeight;
          const nw = clampDim(Math.round(Math.max(w, h) / 1.1));
          if (sizeKey === 'interview') {
            patch.interviewWidth = nw;
            patch.interviewHeight = clampDim(Math.round((h * nw) / w));
          } else {
            patch.examWidth = nw;
            patch.examHeight = clampDim(Math.round((h * nw) / w));
          }
          break;
        }
        case 'opacity-up':
        case 'opacity-down': {
          const step = style.hotkeyOpacityStep;
          const cur = sizeKey === 'interview' ? style.interviewBgOpacity : style.examBgOpacity;
          const next = Math.min(1, Math.max(0, cur + (p.action === 'opacity-up' ? step : -step)));
          if (sizeKey === 'interview') patch.interviewBgOpacity = next;
          else patch.examBgOpacity = next;
          break;
        }
        case 'text-opacity-up':
        case 'text-opacity-down': {
          const step = style.hotkeyOpacityStep;
          const cur = sizeKey === 'interview' ? style.interviewTextOpacity : style.examTextOpacity;
          const next = Math.min(1, Math.max(0, cur + (p.action === 'text-opacity-up' ? step : -step)));
          if (sizeKey === 'interview') patch.interviewTextOpacity = next;
          else patch.examTextOpacity = next;
          break;
        }
        default:
          return;
      }
      const merged = normalizeStyle({ ...style, ...patch });
      await setSetting('overlay.style', merged);
      const { emit } = await import('@tauri-apps/api/event');
      await emit('overlay-style-hotkey-patch', patch);
    });
    unlisteners.push(off);
    return () => unlisteners.forEach((u) => u());
  }, [style, mode]);
}

function clampDim(v: number): number {
  return Math.min(2560, Math.max(120, v));
}

/** 按住方向键移动浮窗（首步 48px、后续每 30ms 30px） */
let moveLoopActive = false;
async function moveOverlay(action: string) {
  if (moveLoopActive) return;
  moveLoopActive = true;
  try {
    const win = getCurrentWindow();
    const monitor = await currentMonitor();
    const work = monitor?.workArea;
    const startPos = await win.outerPosition();
    const size = await win.outerSize();
    const step = 30;
    let first = true;
    let x = startPos.x;
    let y = startPos.y;
    // 持续移动直到该方向热键松开（简化为按一次移动 N 步；原版为按住持续移动）
    for (let i = 0; i < 12; i++) {
      const dx = action === 'move-left' ? -step : action === 'move-right' ? step : 0;
      const dy = action === 'move-up' ? -step : action === 'move-down' ? step : 0;
      const d = first ? 48 : step;
      x = clampAxis(x + (dx !== 0 ? Math.sign(dx) * d : 0), work?.position.x ?? 0, (work?.position.x ?? 0) + (work?.size.width ?? 0) - size.width);
      y = clampAxis(y + (dy !== 0 ? Math.sign(dy) * d : 0), work?.position.y ?? 0, (work?.position.y ?? 0) + (work?.size.height ?? 0) - size.height);
      await positionOverlay({ x, y });
      first = false;
      await new Promise((r) => setTimeout(r, 30));
    }
    await persistPosition();
  } finally {
    moveLoopActive = false;
  }
}

function clampAxis(v: number, min: number, max: number): number {
  if (max < min) return Math.round(min);
  return Math.round(Math.min(max, Math.max(min, v)));
}
