/*
 * 手机副屏宿主端（exam-dual 本地版，对应原版 YG/HG 接管链路，spec 02 §214、04 §8）：
 * - 在笔试工作台扫码启动（cmd_dual_start），手机连上后接管浮窗显示：
 *   本地浮窗 DOM 隐身（CSS 类 dual-takeover），全量 UI 状态节流推给手机；
 * - 手机热区（归一化）换算成浮窗像素回设 cmd_set_overlay_zones，
 *   电脑鼠标在浮窗范围内悬停手机按钮（cursor-point 归一化回传手机画光标）；
 * - 断线 15s 宽限内不弹回本地浮窗（原版 KG 语义）；「切回电脑」= exit → released。
 */
import { cmd, listenEvent, setOverlaySize, setOverlayZones, setCursorPointFeed } from './bridge';
import {
  answerNow,
  capturePage,
  clearPendingScreenshots,
  examModeInfo,
  followUp,
  endExamSession,
  getSolverState,
  nextExamMode,
  setSolverMode,
  solve,
  type SolverState,
} from './examEngine';

export interface DualStartInfo {
  port: number;
  token: string;
  urls: string[];
}

const DUAL_DWELL_MS = 1200; // 与「解题」悬停一致
const STATE_PUSH_MS = 100; // 原版 60ms tick，本地 100ms 足够
const RECONNECT_GRACE_MS = 15000;

let zonesSuppressed = false;
export const isZonesSuppressed = () => zonesSuppressed;
const takeoverListeners = new Set<() => void>();
export function subscribeDualTakeover(listener: () => void): () => void {
  takeoverListeners.add(listener);
  return () => { takeoverListeners.delete(listener); };
}
function notifyTakeover() { takeoverListeners.forEach(listener => listener()); }

export async function startDualScreen(): Promise<DualStartInfo> {
  return cmd<DualStartInfo>('cmd_dual_start');
}

export async function stopDualScreen(): Promise<void> {
  await cmd<void>('cmd_dual_stop');
}

export function dualUrlWithToken(info: DualStartInfo): string {
  const url = info.urls[0] ?? `http://127.0.0.1:${info.port}`;
  return `${url}/?token=${encodeURIComponent(info.token)}`;
}

interface PhoneZone {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

let overlayRect: { x: number; y: number; w: number; h: number } | null = null;
let overlayRectAt = 0;

/** 诊断计数（E2E 用；生产无副作用） */
const diag = { msg: 0, peer: 0, enter: 0, restore: 0, action: 0, send: 0 };
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).__dualDiag = diag;
}

async function refreshOverlayRect() {
  if (Date.now() - overlayRectAt < 800 && overlayRect) return;
  try {
    const r = await cmd<[number, number, number, number]>('cmd_get_overlay_rect');
    overlayRect = { x: r[0], y: r[1], w: r[2], h: r[3] };
    overlayRectAt = Date.now();
  } catch {
    // 窗口不存在时忽略
  }
}

async function dualSend(obj: unknown): Promise<void> {
  diag.send++;
  await cmd<boolean>('cmd_dual_send', { text: JSON.stringify(obj) });
}

/** 接管会话：在浮窗窗口调用；返回清理函数 */
export function startDualTakeover(): () => void {
  let active = false;
  let disposed = false;
  let revision = 0;
  let releasing = false;
  let originalSize: { width: number; height: number } | null = null;
  let restoreTimer: number | null = null;
  let pushTimer: number | null = null;
  let dwellTimer: number | null = null;
  let dwellZone: string | null = null;
  let lastState = '';
  const cleanups: (() => void)[] = [];

  const enter = () => {
    if (disposed || releasing || active) return;
    diag.enter++;
    revision++;
    active = true;
    zonesSuppressed = true;
    originalSize = { width: window.innerWidth, height: window.innerHeight };
    lastState = '';
    document.documentElement.classList.add('dual-takeover');
    notifyTakeover();
    void setCursorPointFeed(true).catch(() => {});
    pushTimer = window.setInterval(pushState, STATE_PUSH_MS);
    void pushState();
  };

  const restore = async (released: boolean) => {
    diag.restore++;
    if (!active) return;
    const current = ++revision;
    active = false;
    zonesSuppressed = false;
    document.documentElement.classList.remove('dual-takeover');
    if (pushTimer) window.clearInterval(pushTimer);
    if (dwellTimer) window.clearTimeout(dwellTimer);
    pushTimer = null;
    dwellTimer = null;
    dwellZone = null;
    await setCursorPointFeed(false).catch(() => {});
    if (current !== revision) return;
    await setOverlayZones([]).catch(() => {});
    if (current !== revision) return;
    if (originalSize) {
      const size = originalSize;
      originalSize = null;
      await setOverlaySize(size.width, size.height).catch(() => {});
    }
    if (current !== revision) return;
    // Force the desktop scanner to republish even if its rectangles did not move.
    notifyTakeover();
    if (released) await dualSend({ t: 'released' }).catch(() => {});
  };

  const release = async (endSession = false) => {
    if (disposed || releasing || !active) return;
    releasing = true;
    cancelRestore();
    if (endSession) await dualSend({ t: 'ended' }).catch(() => {});
    await restore(!endSession);
    await stopDualScreen().catch(() => {});
    if (endSession) await endExamSession(false).catch(error => {
      console.error('[dual] ending session failed', error);
    });
    releasing = false;
  };

  const performAction = async (id: string) => {
    if (disposed || !active || releasing) return;
    if (id === 'exit') return release();
    if (id === 'end-session') return release(true);
    try { await dispatchAction(id); }
    catch { await dualSend({ t: 'action-error', message: '操作失败，请重试或切回电脑查看。' }).catch(() => {}); }
  };

  const scheduleRestore = () => {
    if (restoreTimer != null) return;
    // 原版语义：断线宽限内手机自动重连，期间电脑不弹回浮窗
    restoreTimer = window.setTimeout(() => {
      restoreTimer = null;
      void restore(false);
    }, RECONNECT_GRACE_MS);
  };
  const cancelRestore = () => {
    if (restoreTimer != null) {
      window.clearTimeout(restoreTimer);
      restoreTimer = null;
    }
  };

  // ---- 状态推送（solver 快照） ----
  const followUpLabels: { intent: string; label: string }[] = [
    { intent: 'simplify', label: '继续简化' },
    { intent: 'brute-force', label: '换暴力解法' },
    { intent: 'code-review', label: '检查我抄的代码' },
    { intent: 'partial-pass', label: '降通过率' },
  ];
  async function pushState() {
    if (!active || disposed || releasing) return;
    const s: SolverState = getSolverState();
    const info = examModeInfo(s.mode);
    const turns = s.turns.slice(-3).map((t, i) => ({
      md: t.body,
      tsText: new Date(t.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
      idx: i,
    }));
    const payload = {
      t: 'state',
      data: {
        brand: '面绪',
        mode: s.mode,
        modeLabel: info.label,
        statusText: s.statusText,
        solving: s.phase === 'capturing' || s.phase === 'uploading' || s.phase === 'thinking' || s.phase === 'streaming',
        elapsed: s.elapsedSec,
        pendingPages: s.pendingScreenshots.length,
        maxPages: info.maxScreenshotPages,
        turns,
        followUps: s.turns.length > 0 && s.phase === 'done' ? followUpLabels : [],
        errorMessage: s.errorMessage,
      },
    };
    const key = JSON.stringify(payload);
    if (key === lastState) return;
    lastState = key;
    await dualSend(payload).catch(() => {});
  }
  // The interval bounds streaming updates; subscriptions would send on every token.
  const addOff = (p: Promise<() => void>) => {
    void p.then((off) => { if (disposed) off(); else cleanups.push(off); }).catch(() => {});
  };

  // ---- 手机消息 ----
  addOff(
    listenEvent<string>('dual-message', (raw) => {
      diag.msg++;
      let m: { t?: string; [k: string]: unknown };
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (disposed || !m || typeof m !== 'object' || Array.isArray(m)) return;
      if (!active && m.t !== 'ping') return;
      switch (m.t) {
        case 'hello': {
          const w = Number(m.w), h = Number(m.h);
          if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
          const current = revision;
          void refreshOverlayRect().then(() => {
            if (disposed || !active || current !== revision) return;
            const aspect = Math.max(0.3, Math.min(3, w / h));
            // Native rects use physical pixels, while setOverlaySize expects logical pixels.
            void setOverlaySize(Math.round(window.innerHeight * aspect), window.innerHeight).then(() => { overlayRectAt = 0; }).catch(() => {});
          });
          break;
        }
        case 'zones': {
          if (!Array.isArray(m.zones) || m.zones.length > 128) return;
          const allowed = new Set(['solve', 'direct', 'add-page', 'reset', 'mode-next', 'scroll-up', 'scroll-down', 'exit', 'end-session',
            'followup:simplify', 'followup:brute-force', 'followup:code-review', 'followup:partial-pass']);
          const zones = (m.zones as PhoneZone[]).filter(z => z && allowed.has(z.id)
            && [z.x, z.y, z.w, z.h].every(Number.isFinite)
            && z.x >= 0 && z.y >= 0 && z.w > 0 && z.h > 0 && z.x + z.w <= 1.01 && z.y + z.h <= 1.01);
          const current = revision;
          void refreshOverlayRect().then(() => {
            if (!overlayRect || disposed || !active || current !== revision) return;
            void setOverlayZones(
              zones.map((z) => ({
                id: `dual:${z.id}`,
                x: Math.round(overlayRect!.x + z.x * overlayRect!.w),
                y: Math.round(overlayRect!.y + z.y * overlayRect!.h),
                width: Math.round(z.w * overlayRect!.w),
                height: Math.round(z.h * overlayRect!.h),
              })),
            ).catch(() => {});
          });
          break;
        }
        case 'action':
          void performAction(String(m.id ?? ''));
          break;
        case 'exit':
          cancelRestore();
          void release();
          break;
        case 'ping':
          void dualSend({ t: 'pong', id: m.id });
          break;
        default:
          break;
      }
    }),
  );

  // ---- 对端连接状态 ----
  addOff(
    listenEvent<{ count: number; reason?: string }>('dual-peer', (p) => {
      if (disposed) return;
      diag.peer++;
      if (p.count > 0) {
        cancelRestore();
        void enter();
        lastState = '';
        void pushState();
      } else {
        if (p.reason === 'stopped') { cancelRestore(); void restore(false); }
        else scheduleRestore();
      }
    }),
  );

  // ---- 光标点位 → 手机（60ms 节流由原生 16ms 轮询 + 本地时间戳合并承担） ----
  let lastCursorAt = 0;
  addOff(
    listenEvent<{ x: number; y: number }>('cursor-point', (p) => {
      if (!active || disposed) return;
      const current = revision;
      const now = Date.now();
      if (now - lastCursorAt < 60) return;
      lastCursorAt = now;
      void refreshOverlayRect().then(() => {
        if (!active || disposed || current !== revision || !overlayRect || overlayRect.w <= 0 || overlayRect.h <= 0) return;
        const nx = (p.x - overlayRect.x) / overlayRect.w;
        const ny = (p.y - overlayRect.y) / overlayRect.h;
        if (nx < -0.05 || nx > 1.05 || ny < -0.05 || ny > 1.05) return;
        void dualSend({ t: 'cursor', x: Math.max(0, Math.min(1, nx)), y: Math.max(0, Math.min(1, ny)) }).catch(() => {});
      });
    }),
  );

  // ---- 电脑鼠标悬停手机热区 → 驻留触发 ----
  addOff(
    listenEvent<{ zoneId: string | null }>('cursor-zone', (p) => {
      if (!active || disposed) return;
      const id = p.zoneId?.startsWith('dual:') ? p.zoneId.slice(5) : null;
      if (id === dwellZone) return;
      dwellZone = id;
      if (dwellTimer) window.clearTimeout(dwellTimer);
      dwellTimer = null;
      if (id) {
        dwellTimer = window.setTimeout(() => {
          if (active && !disposed && dwellZone === id) void performAction(id);
        }, DUAL_DWELL_MS);
      }
    }),
  );

  // 挂载时补查：监听器是异步注册的，手机可能已在线（dual-peer 事件已错过）
  void cmd<number>('cmd_dual_peer_count').then((count) => {
    if (!disposed && count > 0) {
      cancelRestore();
      void enter();
      lastState = '';
      void pushState();
    }
  }).catch(() => {});

  return () => {
    disposed = true;
    cancelRestore();
    void restore(false);
    cleanups.forEach((c) => c());
  };
}

async function dispatchAction(id: string) {
  diag.action++;
  if (id === 'solve') {
    await solve();
  } else if (id === 'direct') {
    answerNow();
  } else if (id === 'add-page') {
    await capturePage();
  } else if (id === 'reset') {
    clearPendingScreenshots();
  } else if (id === 'mode-next') {
    const s = getSolverState();
    setSolverMode(nextExamMode(s.mode));
  } else if (id.startsWith('followup:')) {
    const intent = id.slice('followup:'.length);
    await followUp({ intent: intent as 'simplify' | 'brute-force' | 'code-review' | 'partial-pass' });
  } else if (id === 'scroll-up' || id === 'scroll-down') {
    await dualSend({ t: 'do', id }).catch(() => {});
  }
  // turn:N / exit 等仅手机本地行为
}
