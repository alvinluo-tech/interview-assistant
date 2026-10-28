/*
 * 浮窗平台层：OverlayPlatformProvider（穿透/交互切换、zones 注册与全量
 * 上报、cursor-zone 订阅、悬停驻留 hook、热键绑定、原生拖拽/缩放）。
 * 对齐原版 TD/ED/DD/OD + KT/GT 的行为与常量（350ms 扫描、4px 外扩、
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
import { getSetting, setSetting } from '@/lib/store';
import type { OverlayMode } from '@/lib/overlayStyle';

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
      try {
        const win = getCurrentWindow();
        const [sf, outer] = await Promise.all([win.scaleFactor(), win.outerPosition()]);
        const list: { id: string; x: number; y: number; width: number; height: number }[] = [];
        for (const [id, el] of zonesRef.current) {
          if (!el.isConnected) continue;
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          list.push({
            id,
            x: Math.round(outer.x + (r.x - ZONE_EXPAND_PX) * sf),
            y: Math.round(outer.y + (r.y - ZONE_EXPAND_PX) * sf),
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
    const timer = window.setInterval(scan, ZONE_SCAN_MS);
    return () => {
      stopped = true;
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

  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>;
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
 * 悬停驻留触发（原版 KT）：光标停留在 zone 上，进度条走满即触发，
 * 触发后同 zone 冷却 800ms。
 */
export function useDwell(
  zoneId: string,
  hoverMs: number,
  onTrigger: () => void,
  opts?: { cooldownMs?: number; disabled?: boolean },
): number {
  const { activeZoneId } = usePlatform();
  const cooldownMs = opts?.cooldownMs ?? 800;
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const cooldownUntilRef = useRef(0);
  const startRef = useRef(0);
  const triggeredRef = useRef(false);
  // 回调用 ref 持有：避免父组件每次渲染产生的新函数重置驻留进度
  const onTriggerRef = useRef(onTrigger);
  onTriggerRef.current = onTrigger;

  const active = !opts?.disabled && activeZoneId === zoneId;

  useEffect(() => {
    if (!active) {
      setProgress(0);
      triggeredRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    startRef.current = performance.now();
    triggeredRef.current = false;
    const tick = () => {
      const now = performance.now();
      if (now < cooldownUntilRef.current) {
        setProgress(0);
      } else {
        const p = Math.min(1, (now - startRef.current) / hoverMs);
        setProgress(p);
        if (p >= 1 && !triggeredRef.current) {
          triggeredRef.current = true;
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
  }, [active, hoverMs, cooldownMs, zoneId]);

  return active ? progress : 0;
}
