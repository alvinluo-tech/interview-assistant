/*
 * 浮窗交互控件：驻留按钮（进度条画在底边，交互态直接点击）、
 * 拖拽把手、滚动边缘 pill。悬停时长对齐原版各按钮的 hoverMs。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useDwell, usePlatform } from './platform';
import { hotkeyBadge } from '@/lib/hotkeys';
import { isMac } from '@/lib/env';
import { onEvent as onTauriEvent } from '@/lib/bridge';

/** 大悬停按钮（原版 kW） */
export function DwellButton({
  id,
  children,
  subLabel,
  hotkey,
  variant = 'muted',
  hoverMs = 1200,
  onTrigger,
  disabled,
  compact,
}: {
  id: string;
  children: ReactNode;
  subLabel?: ReactNode;
  hotkey?: string;
  variant?: 'primary' | 'muted' | 'destructive';
  hoverMs?: number;
  onTrigger: () => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { interactive, registerZone } = usePlatform();
  const progress = useDwell(id, hoverMs, onTrigger, { disabled: disabled || interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);

  const variantClass =
    variant === 'primary'
      ? 'ov-chip-active font-semibold'
      : variant === 'destructive'
        ? 'ov-chip border-dashed'
        : 'ov-chip font-medium';

  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      disabled={disabled}
      onClick={interactive && !disabled ? onTrigger : undefined}
      className={`relative flex h-9 min-w-0 flex-1 flex-col items-center justify-center gap-0 overflow-hidden rounded-md border px-1 leading-[1.15] transition-opacity ${variantClass} ${compact ? 'px-0.5' : ''} ${disabled ? 'opacity-50' : 'hover:opacity-90'}`}
    >
      <span className="flex max-w-full items-center justify-center gap-1 truncate">
        <span className="truncate text-[12.5px]">{children}</span>
        {hotkey && showHotkeyHints() && (
          <span className="ov-text-3 shrink-0 whitespace-nowrap text-[9px] opacity-65">
            {hotkeyBadge(hotkey, isMac())}
          </span>
        )}
      </span>
      {subLabel && <span className="ov-text-3 max-w-full truncate text-[9px] opacity-65">{subLabel}</span>}
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[3px]" style={{ width: `${progress * 100}%` }} />
      )}
    </button>
  );
}

/** 图标/紧凑悬停按钮（原版 JW） */
export function DwellIconButton({
  id,
  icon,
  label,
  hotkey: _hotkey,
  hoverMs = 1200,
  onTrigger,
  variant = 'muted',
  disabled,
}: {
  id: string;
  icon: ReactNode;
  label?: string;
  hotkey?: string;
  hoverMs?: number;
  onTrigger: () => void;
  variant?: 'primary' | 'muted' | 'destructive';
  disabled?: boolean;
}) {
  const { interactive, registerZone } = usePlatform();
  const progress = useDwell(id, hoverMs, onTrigger, { disabled: disabled || interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);
  const variantClass =
    variant === 'primary'
      ? 'ov-chip-active font-semibold'
      : variant === 'destructive'
        ? 'ov-chip border-dashed'
        : 'ov-chip';
  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={interactive && !disabled ? onTrigger : undefined}
      className={`ov-text relative flex h-6.5 w-6.5 items-center justify-center rounded-md border ${variantClass} ${disabled ? 'opacity-50' : ''}`}
    >
      {icon}
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[2px]" style={{ width: `${progress * 100}%` }} />
      )}
    </button>
  );
}

/** 拖拽把手（穿透态悬停 0.9s/1s 进入原生拖动） */
export function DragHandle({ id = 'drag', hoverMs = 900 }: { id?: string; hoverMs?: number }) {
  const { interactive, registerZone, setDragActive } = usePlatform();
  const progress = useDwell(id, hoverMs, () => setDragActive(true), { disabled: interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);
  useEffect(() => {
    if (interactive) return;
    return onDragModeChanged((active) => {
      setDragging(active);
      if (!active) {
        // 放下后持久化位置由浮窗 shell 统一处理
        window.setTimeout(() => persistPosition(), 300);
      }
    });
  }, [interactive]);

  return (
    <div
      ref={setRefEl as (el: HTMLDivElement | null) => void}
      data-tauri-drag-region={interactive || undefined}
      onPointerDown={undefined}
      className="ov-chip relative flex size-6 cursor-grab items-center justify-center rounded-md border"
      title={dragging ? '跟随中 · 静止 0.8s 释放' : `悬停 ${hoverMs / 1000}s 进入拖动`}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" className="ov-text-3 opacity-70">
        <circle cx="2" cy="2" r="0.9" fill="currentColor" />
        <circle cx="8" cy="2" r="0.9" fill="currentColor" />
        <circle cx="2" cy="8" r="0.9" fill="currentColor" />
        <circle cx="8" cy="8" r="0.9" fill="currentColor" />
        <circle cx="5" cy="5" r="0.9" fill="currentColor" />
      </svg>
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[2px]" style={{ width: `${progress * 100}%` }} />
      )}
    </div>
  );
}

export function onDragModeChanged(cb: (active: boolean) => void): () => void {
  // 同步订阅：由 bridge.onEvent 在内部异步注册，返回的清理函数保持同步语义
  const off = onTauriEvent<{ active: boolean }>('drag-mode-changed', (p) => cb(p.active));
  return off;
}

export async function persistPosition() {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const { positionOverlay } = await import('@/lib/bridge');
    const { setSetting } = await import('@/lib/store');
    const outer = await getCurrentWindow().outerPosition();
    setSetting('overlay.position', { x: outer.x, y: outer.y });
    void positionOverlay({ x: outer.x, y: outer.y });
  } catch {
    // ignore
  }
}

/** 边缘滚动 pill（原版 WW/Pq） */
export function ScrollEdgePill({
  id,
  direction,
  label,
  hotkey,
}: {
  id: string;
  direction: 'up' | 'down';
  label: string;
  hotkey?: string;
}) {
  const { bindHotkeyHold, registerZone } = usePlatform();
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  const [held, setHeld] = useState(false);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);
  useEffect(() => {
    return bindHotkeyHold(direction === 'up' ? 'scroll-up' : 'scroll-down', setHeld);
  }, [bindHotkeyHold, direction]);
  // 按住热键时持续滚动
  useEffect(() => {
    if (!held) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      scrollOverlayList(direction, (3 + 6) * (Math.min((now - last) / 16.7, 3)) * 1);
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [held, direction]);
  return (
    <div
      ref={setRefEl as (el: HTMLDivElement | null) => void}
      className="ov-pill pointer-events-none relative mx-2 flex h-6 items-center justify-center gap-1 rounded-full border text-[10px] font-medium"
    >
      <span className="ov-text-2 flex items-center gap-1">
        {hotkey && showHotkeyHints() ? (
          <span className="ov-text-3">{hotkeyBadge(hotkey, isMac())}</span>
        ) : (
          <span>{label}</span>
        )}
        <span className="ov-text-3">{direction === 'up' ? '回看' : '看新'}</span>
      </span>
    </div>
  );
}

/** 滚动浮窗消息列表（由 shell 注册） */
let overlayListEl: HTMLElement | null = null;
export function registerOverlayList(el: HTMLElement | null) {
  overlayListEl = el;
}
export function scrollOverlayList(direction: 'up' | 'down', amountPx: number) {
  if (!overlayListEl) return;
  overlayListEl.scrollTop += direction === 'up' ? -amountPx : amountPx;
}

function showHotkeyHints(): boolean {
  // 惰性读取设置（渲染层无法用 hook 的场景）
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = (window as unknown as { __ml_getSetting?: <T>(k: string, d: T) => T }).__ml_getSetting;
    if (mod) return mod('interview.showHotkeyHints', true);
  } catch {
    // ignore
  }
  return true;
}

export const HOVER_MS = {
  action: 1100,
  answer: 1200,
  capture: 1200,
  addPage: 900,
  answerNow: 800,
  reset: 800,
  exit: 2500,
  voiceAsk: 1800,
  copyCode: 1800,
  followUp: 1800,
  mode: 900,
  palette: 1400,
  paletteConfirm: 1200,
  sendPages: 1200,
  cancelPages: 800,
  navArrow: 600,
  endInterview: 2600,
  switchInteractive: 2200,
  scrollEdge: 700,
} as const;
