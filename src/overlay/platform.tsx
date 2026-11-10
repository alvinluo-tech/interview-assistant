/*
 * 浮窗平台层：OverlayPlatformProvider（穿透/交互切换、zones 注册与全量
 * 上报、cursor-zone 订阅、悬停驻留 hook、热键绑定、原生拖拽/缩放）。
 * 行为与常量（350ms 扫描、4px 外扩、
 * 800ms 冷却）。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { onEvent, setOverlayInteractive, setOverlayZones, setDragActive } from '@/lib/bridge';
import { isZonesSuppressed, subscribeDualTakeover } from '@/lib/dualScreen';
import { getSetting, setSetting } from '@/lib/store';
import type { OverlayMode } from '@/lib/overlayStyle';
import { t } from '@/lib/i18n';

export interface OverlayPlatform {
  inOverlay: true;
  mode: OverlayMode;
  interactive: boolean;
  toggleInteractive: () => void;
  registerZone: (id: string, el: HTMLElement | null) => void;
  /** 穿透模式下当前命中的 zone（悬停驻留用） */
  activeZoneId: string | null;
  bindHotkey: (action: string, fn: () => void) => () => void;
  bindHotkeyHold: (action: string, fn: (pressed: boolean) => void) => () => void;
  setDragActive: (on: boolean) => void;
  startResize: () => void;
  /** 主窗口仿真容器（预览用） */
  simulate?: boolean;
}

const PlatformContext = createContext<OverlayPlatform | null>(null);

const ZONE_SCAN_MS = 350;
const ZONE_EXPAND_PX = 4;

/** 元素被哪些滚动/裁剪容器限制；结果按元素缓存，避免每轮扫描重复读计算样式。 */
const CLIP_CACHE = new WeakMap<HTMLElement, HTMLElement[]>();
function clipAncestors(el: HTMLElement): HTMLElement[] {
  const cached = CLIP_CACHE.get(el);
  if (cached) return cached;
  const ancestors: HTMLElement[] = [];
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) ancestors.push(node);
  }
  CLIP_CACHE.set(el, ancestors);
  return ancestors;
}

/** 可见热区 = 元素矩形 ∩ 各裁剪祖先 ∩ 窗口视口；完全不可见时返回 null。 */
function visibleRect(el: HTMLElement): { left: number; top: number; width: number; height: number } | null {
  const base = el.getBoundingClientRect();
  if (base.width <= 0 || base.height <= 0) return null;
  let left = base.left, top = base.top, right = base.right, bottom = base.bottom;
  for (const node of clipAncestors(el)) {
    const r = node.getBoundingClientRect();
    left = Math.max(left, r.left); top = Math.max(top, r.top);
    right = Math.min(right, r.right); bottom = Math.min(bottom, r.bottom);
  }
  left = Math.max(left, 0); top = Math.max(top, 0);
  right = Math.min(right, window.innerWidth); bottom = Math.min(bottom, window.innerHeight);
  if (right - left < 2 || bottom - top < 2) return null;
  return { left, top, width: right - left, height: bottom - top };
}

export function OverlayPlatformProvider({
  mode,
  interactive: interactiveOverride,
  simulate,
  children,
}: {
  mode: OverlayMode;
  /** 主窗口预览用：恒可交互 */
  interactive?: boolean;
  simulate?: boolean;
  children: ReactNode;
}) {
  const isExam = mode === 'exam';
  const [interactive, setInteractiveState] = useState(() => {
    if (simulate || interactiveOverride) return true;
    if (isExam) return false;
    return getSetting('interview.interactive', false);
  });
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const zonesRef = useRef(new Map<string, HTMLElement>());

  // interactive 状态同步到原生
  useEffect(() => {
    if (!simulate) {
      setOverlayInteractive(interactive).catch(() => {});
      if (!isExam) {
        setSetting('interview.interactive', interactive);
      }
    }
  }, [interactive, simulate, isExam]);

  // 非 interactive（穿透）时定期把注册的 zone 矩形全量上报
  useEffect(() => {
    if (simulate || interactive) return;
    let stopped = false;
    let last = '';
    const scan = async () => {
      if (stopped) return;
      if (isZonesSuppressed()) return; // 副屏接管期间热区由 dualScreen 接管
      try {
        const win = getCurrentWindow();
        const [sf, outer] = await Promise.all([win.scaleFactor(), win.outerPosition()]);
        if (stopped || isZonesSuppressed()) return;
        const list: { id: string; x: number; y: number; width: number; height: number }[] = [];
        for (const [id, el] of zonesRef.current) {
          if (!el.isConnected) continue;
          // 只上报真正可见的部分：滚出滚动容器或窗口的元素不能在其他应用的位置形成热区。
          const r = visibleRect(el);
          if (!r) continue;
          list.push({
            id,
            x: Math.round(outer.x + (r.left - ZONE_EXPAND_PX) * sf),
            y: Math.round(outer.y + (r.top - ZONE_EXPAND_PX) * sf),
            width: Math.round((r.width + ZONE_EXPAND_PX * 2) * sf),
            height: Math.round((r.height + ZONE_EXPAND_PX * 2) * sf),
          });
        }
        const key = JSON.stringify(list);
        if (key !== last) {
          last = key;
          await setOverlayZones(list);
        }
      } catch {
        // ignore
      }
    };
    scan();
    const offTakeover = subscribeDualTakeover(() => { last = ''; void scan(); });
    const timer = window.setInterval(scan, ZONE_SCAN_MS);
    return () => {
      stopped = true;
      offTakeover();
      window.clearInterval(timer);
      setOverlayZones([]).catch(() => {});
    };
  }, [interactive, simulate]);

  // cursor-zone 订阅
  useEffect(() => {
    if (simulate) return;
    return onEvent<{ zoneId: string | null }>('cursor-zone', (p) => {
      setActiveZoneId(p.zoneId);
    });
  }, [simulate]);

  // 原生拖动状态：拖动中要提示「静止多久放下」
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (simulate) return;
    return onEvent<{ active: boolean }>('drag-mode-changed', (p) => setDragging(!!p.active));
  }, [simulate]);

  // 热键事件
  const hotkeyHandlersRef = useRef(new Map<string, Set<(pressed: boolean) => void>>());
  useEffect(() => {
    if (simulate) return;
    return onEvent<{ action: string; pressed: boolean }>('action-hotkeys', (p) => {
      const handlers = hotkeyHandlersRef.current.get(p.action);
      handlers?.forEach((h) => {
        try {
          h(p.pressed);
        } catch (e) {
          console.error('[hotkey] handler failed', e);
        }
      });
    });
  }, [simulate]);

  const registerZone = useCallback((id: string, el: HTMLElement | null) => {
    if (el) {
      zonesRef.current.set(id, el);
    } else {
      zonesRef.current.delete(id);
    }
  }, []);

  const bindHotkey = useCallback(
    (action: string, fn: () => void) => {
      let set = hotkeyHandlersRef.current.get(action);
      if (!set) {
        set = new Set();
        hotkeyHandlersRef.current.set(action, set);
      }
      const handler = (pressed: boolean) => {
        if (pressed) fn();
      };
      set.add(handler);
      return () => {
        set!.delete(handler);
      };
    },
    [],
  );

  const bindHotkeyHold = useCallback((action: string, fn: (pressed: boolean) => void) => {
    let set = hotkeyHandlersRef.current.get(action);
    if (!set) {
      set = new Set();
      hotkeyHandlersRef.current.set(action, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
    };
  }, []);

  const value: OverlayPlatform = {
    inOverlay: true,
    mode,
    interactive,
    toggleInteractive: () => setInteractiveState((v) => !v),
    registerZone,
    activeZoneId: interactive ? null : activeZoneId,
    bindHotkey,
    bindHotkeyHold,
    setDragActive: (on) => {
      setDragActive(on).catch(() => {});
    },
    startResize: () => {
      getCurrentWindow()
        .startResizeDragging('SouthEast')
        .catch(() => {});
    },
    simulate,
  };

  // 穿透模式下的悬停提示：告诉用户「悬停多久触发」和拖动时的「静止多久放下」。
  const hintZoneId = dragging ? 'drag' : !interactive && !simulate ? activeZoneId : null;
  const hintEl = hintZoneId ? zonesRef.current.get(hintZoneId) : undefined;
  const hint = hintEl && hintEl.dataset.dwellMs && !hintEl.matches(':disabled') ? (
    <HoverHint key={`${hintZoneId}-${dragging}`} zoneEl={hintEl} dragging={dragging} />
  ) : null;

  return (
    <PlatformContext value={value}>
      {children}
      {hint}
    </PlatformContext>
  );
}

const HINT_WIDTH = 188;

/** 悬停提示：进度条对应真实的驻留时长，拖动时切换为放下说明。 */
function HoverHint({ zoneEl, dragging }: { zoneEl: HTMLElement; dragging: boolean }) {
  const [progress, setProgress] = useState(0);
  const [rect, setRect] = useState(() => zoneEl.getBoundingClientRect());
  const hoverMs = Number(zoneEl.dataset.dwellMs) || 1100;
  useEffect(() => {
    // 滚动（capture 阶段能拿到内部滚动容器）或窗口尺寸变化时重算，提示不会停在旧位置。
    const update = () => {
      const visible = visibleRect(zoneEl);
      setRect(visible ? new DOMRect(visible.left, visible.top, visible.width, visible.height) : zoneEl.getBoundingClientRect());
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, { capture: true, passive: true });
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [zoneEl]);
  useEffect(() => {
    if (dragging) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / hoverMs);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [dragging, hoverMs]);
  const label = (zoneEl.getAttribute('aria-label')
    || zoneEl.querySelector('[data-overlay-action-label]')?.textContent
    || zoneEl.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  const seconds = (hoverMs / 1000).toFixed(1).replace(/\.0$/, '');
  const text = dragging
    ? t('移动鼠标定位 · 静止 {s} 秒放下', { s: '0.8' })
    : `${label ? `${label} · ` : ''}${t('悬停 {s} 秒', { s: seconds })}`;
  const top = rect.top > 46 ? rect.top - 34 : rect.bottom + 6;
  const left = Math.max(4, Math.min(rect.left + rect.width / 2 - HINT_WIDTH / 2, (window.innerWidth || 360) - HINT_WIDTH - 4));
  return (
    <div className="ov-panel ov-text-2 pointer-events-none fixed z-50 rounded-md border px-2 py-1 text-[10px] shadow-md" style={{ top, left, width: HINT_WIDTH }}>
      <div className="truncate">{text}</div>
      {!dragging && (
        <span className="relative mt-1 block h-0.5 w-full overflow-hidden rounded-sm">
          <span aria-hidden="true" className="absolute inset-0 opacity-20" style={{ background: 'currentColor' }} />
          <span aria-hidden="true" className="absolute inset-y-0 left-0" style={{ width: `${Math.round(progress * 100)}%`, background: 'currentColor' }} />
        </span>
      )}
    </div>
  );
}

/** 没有平台容器时返回 null（主窗口里复用浮窗组件时用）。 */
export function usePlatformOptional(): OverlayPlatform | null {
  return useContext(PlatformContext);
}

export function usePlatform(): OverlayPlatform {
  const ctx = useContext(PlatformContext);
  if (!ctx) throw new Error('usePlatform outside provider');
  return ctx;
}

/** 主窗口仿真容器（预览组件可直接点击，无 zones/热键） */
export function SimulatedPlatform({ mode, children }: { mode: OverlayMode; children: ReactNode }) {
  return (
    <OverlayPlatformProvider mode={mode} interactive simulate>
      {children}
    </OverlayPlatformProvider>
  );
}

/**
 * 悬停驻留触发：光标停留在 zone 上，进度条走满即触发，
 * 触发后同 zone 冷却 800ms。
 */
export function useDwell(
  zoneId: string,
  hoverMs: number,
  onTrigger: () => void,
  opts?: { cooldownMs?: number; disabled?: boolean; requireReentry?: boolean },
): number {
  const { activeZoneId } = usePlatform();
  const cooldownMs = opts?.cooldownMs ?? 800;
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const cooldownUntilRef = useRef(0);
  const startRef = useRef(0);
  const triggeredRef = useRef(false);
  // 拖动这类动作：同一次悬停只触发一次，光标离开后重新进入才再次生效。
  const reenteredRef = useRef(true);
  // 回调用 ref 持有：避免父组件每次渲染产生的新函数重置驻留进度
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const active = !opts?.disabled && activeZoneId === zoneId;

  useEffect(() => {
    if (!active) {
      setProgress(0);
      triggeredRef.current = false;
      reenteredRef.current = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    startRef.current = performance.now();
    triggeredRef.current = false;
    const tick = () => {
      const now = performance.now();
      if (opts?.requireReentry && !reenteredRef.current) {
        setProgress(0);
        rafRef.current = null;
        return;
      }
      if (now < cooldownUntilRef.current) {
        setProgress(0);
      } else {
        const p = Math.min(1, (now - startRef.current) / hoverMs);
        setProgress(p);
        if (p >= 1 && !triggeredRef.current) {
          triggeredRef.current = true;
          reenteredRef.current = false;
          cooldownUntilRef.current = now + cooldownMs;
          startRef.current = now;
          onTriggerRef.current();
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [active, hoverMs, cooldownMs, zoneId, opts?.requireReentry]);

  return active ? progress : 0;
}
