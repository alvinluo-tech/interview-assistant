/*
 * 浮窗交互控件：驻留按钮（进度条画在底边，交互态直接点击）、
 * 拖拽把手、滚动边缘 pill。悬停时长见各按钮的 hoverMs。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { t } from '@/lib/i18n';
import { useDwell, usePlatform } from './platform';
import { hotkeyBadge } from '@/lib/hotkeys';
import { isMac } from '@/lib/env';
import { onEvent as onTauriEvent } from '@/lib/bridge';
import { DEFAULT_OVERLAY_STYLE, useSetting } from '@/lib/store';
import { normalizeStyle } from '@/lib/overlayStyle';

/** 大悬停按钮 */
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
  inline,
  className = '',
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
  /** 小号文字按钮：保持行内尺寸，但仍然注册悬停热区（穿透模式下可悬停触发） */
  inline?: boolean;
  className?: string;
}) {
  const { interactive, registerZone, simulate } = usePlatform();
  const showHints = useSetting('interview.showHotkeyHints', true)[0];
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
      onClick={interactive && !simulate && !disabled ? onTrigger : undefined}
      data-dwell-ms={hoverMs}
      className={`relative flex max-w-full flex-col items-center justify-center gap-0.5 rounded-md border leading-snug transition-opacity ${inline ? 'min-h-6 min-w-0 flex-none px-1.5 py-0.5' : 'min-h-9 min-w-[5rem] flex-auto px-2 py-1'} ${variantClass} ${compact ? 'text-xs' : ''} ${disabled ? 'opacity-50' : 'hover:opacity-90'} ${className}`}
    >
      <span className="flex w-full min-w-0 flex-col items-center justify-center gap-0.5">
        <span className={`max-w-full whitespace-normal break-words text-center [overflow-wrap:anywhere] ${inline ? 'text-[10.5px]' : 'text-[12.5px]'}`} data-overlay-action-label>{children}</span>
        {hotkey && showHints && (
          <span className="ov-text-3 shrink-0 whitespace-nowrap text-[9px] opacity-65">
            {hotkeyBadge(hotkey, isMac())}
          </span>
        )}
      </span>
      {subLabel && <span className="ov-text-3 max-w-full whitespace-normal break-words text-center text-[9px] opacity-65">{subLabel}</span>}
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current opacity-25" />
      )}
    </button>
  );
}

/**
 * 可悬停展开的折叠区：穿透模式收不到鼠标事件，原生 <details> 点不开，
 * 这里用驻留按钮同时兼容穿透（悬停）与窗口模式（点击）。
 */
export function DwellDisclosure({
  id,
  label,
  children,
  className,
  hoverMs = 1200,
}: {
  id: string;
  label: ReactNode;
  children: ReactNode;
  className?: string;
  hoverMs?: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      {/* flex 容器让按钮按内容收缩并左对齐，避免撑满整行后文字居中 */}
      <div className="flex">
        <DwellButton id={id} inline hoverMs={hoverMs} onTrigger={() => setOpen((value) => !value)}>
          <span className="flex items-center gap-1">
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            {label}
          </span>
        </DwellButton>
      </div>
      {open && <div className="ov-text-3 mt-1 text-[10px]">{children}</div>}
    </div>
  );
}

/** 图标/紧凑悬停按钮 */
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
  const { interactive, registerZone, simulate } = usePlatform();
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
      onClick={interactive && !simulate && !disabled ? onTrigger : undefined}
      data-dwell-ms={hoverMs}
      className={`ov-text relative flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-md border ${variantClass} ${disabled ? 'opacity-50' : ''}`}
    >
      {icon}
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current opacity-25" />
      )}
    </button>
  );
}

/** 拖拽把手（穿透态悬停 0.9s/1s 进入原生拖动） */
export function DragHandle({ id = 'drag', hoverMs = 900 }: { id?: string; hoverMs?: number }) {
  const { interactive, registerZone, setDragActive } = usePlatform();
  const progress = useDwell(id, hoverMs, () => setDragActive(true), { disabled: interactive, requireReentry: true });
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
  // 窗口模式下用原生 drag-region 拖动，不会触发 drag-mode-changed，改监听移动事件去抖保存。
  useEffect(() => {
    if (!interactive) return;
    let timer: number | undefined;
    let off: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      if (disposed) return;
      void getCurrentWindow().onMoved(() => {
        if (timer) window.clearTimeout(timer);
        timer = window.setTimeout(() => void persistPosition(), 400);
      }).then(unlisten => { if (disposed) unlisten(); else off = unlisten; });
    }).catch(() => {});
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      off?.();
    };
  }, [interactive]);

  return (
    <div
      ref={setRefEl as (el: HTMLDivElement | null) => void}
      data-tauri-drag-region={interactive || undefined}
      onPointerDown={undefined}
      data-dwell-ms={hoverMs}
      aria-label={t('抓住浮窗')}
      className="ov-chip relative flex size-6 cursor-grab items-center justify-center rounded-md border"
      title={dragging ? t('跟随中 · 静止 0.8s 释放') : t('悬停 {s}s 进入拖动', { s: hoverMs / 1000 })}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" className="ov-text-3 opacity-70">
        <circle cx="2" cy="2" r="0.9" fill="currentColor" />
        <circle cx="8" cy="2" r="0.9" fill="currentColor" />
        <circle cx="2" cy="8" r="0.9" fill="currentColor" />
        <circle cx="8" cy="8" r="0.9" fill="currentColor" />
        <circle cx="5" cy="5" r="0.9" fill="currentColor" />
      </svg>
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current opacity-25" />
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
    await setSetting('overlay.position', { x: outer.x, y: outer.y });
    await positionOverlay({ x: outer.x, y: outer.y });
  } catch {
    // ignore
  }
}

/** 边缘滚动 pill */
export function ScrollEdgePill({
  id,
  direction,
  label,
  hotkey,
  compact = false,
  className = '',
}: {
  id: string;
  direction: 'up' | 'down';
  label: string;
  hotkey?: string;
  /** 小圆钮：贴在阅读区边缘，只占 24px，不占正文高度 */
  compact?: boolean;
  className?: string;
}) {
  const { bindHotkeyHold, registerZone, activeZoneId, interactive } = usePlatform();
  const showHints = useSetting('interview.showHotkeyHints', true)[0];
  const speed = normalizeStyle(useSetting('overlay.style', DEFAULT_OVERLAY_STYLE)[0]).scrollSpeed;
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  const [held, setHeld] = useState(false);
  const [hovered, setHovered] = useState(false);
  const scrolling = held || (interactive ? hovered : activeZoneId === id);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);
  useEffect(() => {
    return bindHotkeyHold(direction === 'up' ? 'scroll-up' : 'scroll-down', setHeld);
  }, [bindHotkeyHold, direction]);
  // 按住热键时持续滚动
  useEffect(() => {
    if (!scrolling) return;
    let raf = 0;
    let last = performance.now();
    const started = last;
    const step = (now: number) => {
      const velocity = 3 + 6 * Math.min(1, (now - started) / 1000);
      scrollOverlayList(direction, velocity * Math.min((now - last) / 16.7, 3) * speed);
      last = now;
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [scrolling, direction, speed]);
  if (compact) {
    return (
      <div
        ref={setRefEl as (el: HTMLDivElement | null) => void}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label={label}
        className={`ov-pill absolute z-10 flex size-6 items-center justify-center rounded-full border text-[11px] leading-none opacity-80 transition-opacity hover:opacity-100 ${className}`}
      >
        <span aria-hidden="true">{direction === 'up' ? '↑' : '↓'}</span>
      </div>
    );
  }
  return (
    <div
      ref={setRefEl as (el: HTMLDivElement | null) => void}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`ov-pill relative mx-2 flex h-6 items-center justify-center gap-1 rounded-full border text-[10px] font-medium ${className}`}
    >
      <span className="ov-text-2 flex items-center gap-1">
        {hotkey && showHints ? (
          <span className="ov-text-3">{hotkeyBadge(hotkey, isMac())}</span>
        ) : (
          <span>{label}</span>
        )}
        <span className="ov-text-3">{direction === 'up' ? t('回看') : t('看新')}</span>
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

/** First dwell arms the action; a separate visible target confirms it. */
export function ConfirmPaletteButton({id, onApply}: {id:string; onApply:()=>Promise<void>}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 5000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return <div className="relative flex items-center">
    <DwellIconButton id={id} hoverMs={HOVER_MS.palette} label={t('一键配色')} icon={<span aria-hidden="true">◐</span>}
      onTrigger={() => setArmed(true)} disabled={armed} />
    {armed && <div className="absolute right-0 top-full z-20 mt-1 w-28 rounded-md bg-background p-1 shadow-lg">
      <DwellButton id={`${id}-confirm`} hoverMs={HOVER_MS.paletteConfirm} onTrigger={() => {setArmed(false);void onApply();}}>{t('确认配色')}</DwellButton>
    </div>}
  </div>;
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
