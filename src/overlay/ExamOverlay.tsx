/*
 * 笔试浮窗（原版 gJ + tG 壳）：顶栏（拖拽/品牌/题号/状态/档位）、
 * 滚动边缘、markdown 正文、追问 chips、底栏（模式/解题/加页/重置/退出、
 * 多页收集态）。文案与悬停时长对齐原版。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Copy, Puzzle } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { showToast } from '@/ui/primitives';
import {
  computeSkin,
  normalizeStyle,
  type OverlayMode,
} from '@/lib/overlayStyle';
import { DEFAULT_OVERLAY_STYLE, useSetting, type OverlayStyle } from '@/lib/store';
import {
  clearPendingScreenshots,
  examModeInfo,
  getSolverState,
  setSolverMode,
  subscribeSolver,
  solve,
  capturePage,
  abortSolve,
  endExamSession,
  followUp,
  prepareExamRun,
  extractLastCodeBlock,
  stripMarkdown,
  type SolverState,
} from '@/lib/examEngine';
import { setOverlaySize, setSessionActive, captureScreen } from '@/lib/bridge';
import { effectiveHotkeys, hotkeyBadge, type ActionKey, type HotkeyScheme } from '@/lib/hotkeys';
import { isMac } from '@/lib/env';
import { getSetting } from '@/lib/store';
import { Md } from './Md';
import {
  DwellButton,
  ConfirmPaletteButton,
  DragHandle,
  HOVER_MS,
  ScrollEdgePill,
  registerOverlayList,
} from './widgets';
import { useDwell, usePlatform } from './platform';

export function ExamOverlay({ preview }: { preview?: boolean }) {
  const rawStyle = useSetting('overlay.style', DEFAULT_OVERLAY_STYLE)[0];
  const style: OverlayStyle = normalizeStyle(rawStyle);
  const skin = useMemo(() => computeSkin(style, 'exam' as OverlayMode), [style]);
  const { bindHotkey } = usePlatform();
  useEffect(() => {
    if (preview) return;
    const config=getSetting<{runId:string;goalId:string|null}|null>('exam.pendingConfig',null);
    if(config)prepareExamRun(config.runId,config.goalId);
  }, [preview]);

  useEffect(() => {
    if (preview) return;
    setOverlaySize(style.examWidth, style.examHeight).catch(() => {});
  }, [preview, style.examWidth, style.examHeight]);

  useEffect(() => {
    if (preview) return;
    setSessionActive(true).catch(() => {});
    return () => {
      setSessionActive(false).catch(() => {});
    };
  }, [preview]);

  // 全局热键：答题 / 截屏加页 / 复制答案（原版 exam 的绑定）
  useEffect(() => {
    if (preview) return;
    const offAnswer = bindHotkey('answer', () => void solve());
    const offCapture = bindHotkey('capture', () => void capturePage());
    const offCopy = bindHotkey('copy-code', () => void copyAnswerToClipboard());
    return () => {
      offAnswer();
      offCapture();
      offCopy();
    };
  }, [preview, bindHotkey]);

  return <ExamShell skin={skin} preview={preview} />;
}

/** 复制答案（热键路径，与浮窗内按钮同一逻辑） */
async function copyAnswerToClipboard(body?:string) {
  const s = getSolverState();
  const lastBody = body ?? s.turns[s.turns.length - 1]?.body ?? '';
  if (!lastBody.trim()) {showToast({type:'info',title:'答案还没写完，写完再复制'});return;}
  const code = extractLastCodeBlock(lastBody);
  try {
    await writeText(code ?? stripMarkdown(lastBody));
    showToast({type:'success',title:code?`已复制代码（${code.trimEnd().split('\n').length} 行）`:`已复制答案文字（${stripMarkdown(lastBody).length} 字）`});
  } catch {
    showToast({type:'error',title:'复制失败，请再按一次'});
  }
}

function useSolverState(): SolverState {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeSolver(force), [force]);
  return getSolverState();
}

function ExamShell({
  skin,
  preview,
}: {
  skin: ReturnType<typeof computeSkin>;
  preview?: boolean;
}) {
  const solver = useSolverState();
  const listRef = useRef<HTMLDivElement | null>(null);
  const scheme = useSetting<HotkeyScheme>('overlay.hotkeyScheme', 'simple')[0];
  const customKeys = useSetting('overlay.actionHotkeys', {} as Partial<Record<ActionKey, string>>)[0];
  const hotkeys = effectiveHotkeys(scheme, customKeys);
  const showCopyCode = useSetting('exam.showCopyCodeButton', false)[0];
  const isDark = skin.theme === 'dark';

  useEffect(() => {
    registerOverlayList(listRef.current);
    return () => registerOverlayList(null);
  }, []);

  const modeInfo = examModeInfo(solver.mode);
  const multiPage = solver.pendingScreenshots.length > 0;
  const solving =
    solver.phase === 'thinking' ||
    solver.phase === 'streaming' ||
    solver.phase === 'capturing' ||
    solver.phase === 'uploading';

  const copy = () => copyAnswerToClipboard(solver.turns[solver.turns.length-1]?.body ?? '');

  const doSolve = async () => {
    if (multiPage) {
      await solve();
    } else {
      await solve();
    }
  };

  const empty = solver.turns.length === 0 && !multiPage && !solving;

  return (
    <div
      className={`relative flex h-screen flex-col overflow-hidden rounded-xl border text-[13px] ${isDark ? 'overlay-dark' : ''}`}
      data-overlay-theme={skin.theme}
      style={{
        color: skin.textColor,
        background: skin.shellBg,
        borderColor: skin.outerBorderColor,
        boxShadow: skin.shellShadow,
        ...skin.vars,
      }}
    >
      {/* 顶栏 */}
      <div
        className="flex items-center gap-1.5 border-b px-3 py-1.5"
        style={{ background: skin.surfaceBg, borderBottomColor: skin.borderColor }}
      >
        <DragHandle hoverMs={1000} />
        <span className="ov-text-2 truncate text-[11px] font-medium">骆耀升老公酱面试助手</span>
        <div className="flex-1" />
        <div className="flex items-center gap-1.5">
          <span className="ov-dot size-1.5 rounded-full" />
          <span className="ov-text-3 max-w-[110px] truncate text-[10px]">{statusText(solver)}</span>
          {solving && (
            <span className="ov-text-3 text-[10px] tabular-nums">{solver.elapsedSec}s</span>
          )}
          <span className="ov-chip rounded px-1 py-px text-[10px]">{modeInfo.shortLabel}</span>
        </div>
        <PaletteButton />
      </div>

      <ScrollEdgePillProxy id="scroll-up" direction="up" label="悬停回看" hotkey={hotkeys['scroll-up']} />

      {/* 消息区 */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-3">
        {empty ? (
          <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
            <div className="ov-text text-[13px] font-medium">把鼠标悬停到下方「解题」按钮 1.2 秒</div>
            <div className="ov-text-2 text-[11px] opacity-80">AI 会自动截屏并解答</div>
            <div className="ov-text-3 text-[10.5px] opacity-60">
              也可以直接按 {hotkeyBadge(hotkeys.answer, isMac())}，手不用离开键盘
            </div>
          </div>
        ) : (
          <>
            {multiPage && (
              <div className="ov-chip mb-2 rounded-md border px-2 py-1 text-[11px]">
                已截 {solver.pendingScreenshots.length} 页，按「发送」开始解答
              </div>
            )}
            {solver.statusText && (
              <div className="ov-text-2 mb-2 flex items-center gap-1.5 text-[11px]">
                <span className="ov-dot size-1.5 animate-pulse rounded-full" />
                {solver.statusText}
              </div>
            )}
            {solver.turns.map((turn, i) => (
              <div key={turn.id} className="mb-3">
                {turn.body.startsWith('> ') && (
                  <div className="ov-text-3 mb-1 text-[11px] italic opacity-80">
                    {turn.body.split('\n')[0].slice(2)}
                  </div>
                )}
                <div data-overlay-scroll-anchor={i === solver.turns.length - 1 || undefined}>
                  <Md text={turn.body.replace(/^> .*\n\n/, '')} />
                </div>
              </div>
            ))}
            {solver.errorMessage && (
              <div className="ov-text-2 rounded-md border border-dashed px-2 py-1.5 text-[11px]">
                {solver.errorMessage}
              </div>
            )}
          </>
        )}
      </div>

      <ScrollEdgePillProxy id="scroll-down" direction="down" label="悬停看新" hotkey={hotkeys['scroll-down']} />

      {/* 追问 chips */}
      {solver.turns.length > 0 && !multiPage && !solving && (
        <div className="mt-2 flex flex-wrap gap-1.5 px-2">
          {[...new Set(solver.turns[solver.turns.length-1]?.followUpOptions ?? [])].slice(0,3).map((option,index)=><DwellChip
            key={option} id={`suggested-${index}`} hoverMs={HOVER_MS.followUp} label={option}
            onTrigger={() => void followUp({message:option})} />)}
          {showCopyCode && (
            <DwellChip
              id="copy-code"
              hoverMs={HOVER_MS.copyCode}
              onTrigger={() => void copy()}
              icon={<Copy size={11} />}
              label={
                extractLastCodeBlock(solver.turns[solver.turns.length - 1]?.body ?? '')
                  ? '复制代码'
                  : '复制文字'
              }
            />
          )}
          <DwellChip
            id="fu-simplify"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'simplify' })}
            label="继续简化"
          />
          <DwellChip
            id="fu-brute"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'brute-force' })}
            label="换暴力解法"
          />
          <DwellChip
            id="fu-review"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'code-review' })}
            label="检查我抄的代码"
          />
        </div>
      )}

      {/* 底栏 */}
      <div
        className="mt-1 border-t px-2 py-1.5"
        style={{ background: skin.surfaceBg, borderTopColor: skin.borderColor }}
      >
        <div className="flex gap-1.5">
          <DwellButton
            id="mode"
            variant="muted"
            hoverMs={HOVER_MS.mode}
            subLabel={`最多 ${modeInfo.maxScreenshotPages} 页`}
            onTrigger={() => setSolverMode(nextOf(solver.mode))}
          >
            {modeInfo.shortLabel}
          </DwellButton>
          {multiPage ? (
            <>
              <DwellButton
                id="send-pages"
                variant="primary"
                hoverMs={HOVER_MS.sendPages}
                hotkey={hotkeys.answer}
                onTrigger={() => void doSolve()}
              >
                发送 {solver.pendingScreenshots.length} 页
              </DwellButton>
              <DwellButton
                id="add-page"
                variant="muted"
                hoverMs={HOVER_MS.addPage}
                hotkey={hotkeys.capture}
                subLabel={`已 ${solver.pendingScreenshots.length}/${modeInfo.maxScreenshotPages}`}
                onTrigger={() => void capturePage()}
              >
                加页
              </DwellButton>
              <DwellButton
                id="cancel-pages"
                variant="muted"
                hoverMs={HOVER_MS.cancelPages}
                onTrigger={() => clearPendingScreenshots()}
              >
                取消
              </DwellButton>
            </>
          ) : (
            <>
              <DwellButton
                id="solve"
                variant="primary"
                hoverMs={HOVER_MS.answer}
                hotkey={hotkeys.answer}
                subLabel={solving ? '处理中' : undefined}
                onTrigger={() => void doSolve()}
              >
                <span className="flex items-center gap-1">
                  <Puzzle size={12} />
                  解题
                </span>
              </DwellButton>
              {!solving && (
                <DwellButton
                  id="add-page"
                  variant="muted"
                  hoverMs={HOVER_MS.answer}
                  hotkey={hotkeys.capture}
                  subLabel="先截第1页"
                  onTrigger={() => void capturePage()}
                >
                  加页
                </DwellButton>
              )}
              <DwellButton
                id="reset"
                variant="muted"
                hoverMs={HOVER_MS.reset}
                onTrigger={() => void abortSolve()}
              >
                重置
              </DwellButton>
            </>
          )}
          <DwellButton
            id="exit"
            variant="destructive"
            hoverMs={HOVER_MS.exit}
            onTrigger={() => void endExamSession(false)}
          >
            退出
          </DwellButton>
        </div>
      </div>
      {preview ? null : null}
    </div>
  );
}

function nextOf(mode: SolverState['mode']): SolverState['mode'] {
  const order = ['instant', 'quick', 'programming'] as const;
  return order[(order.indexOf(mode) + 1) % order.length];
}

function statusText(s: SolverState): string {
  if (s.phase === 'error') return '出错，可重试';
  if (s.phase === 'capturing') return '截屏中…';
  if (s.phase === 'uploading') return '上传截图…';
  if (s.phase === 'thinking') return 'AI 思考中…';
  if (s.phase === 'streaming') return 'AI 输出中…';
  return '已连接';
}

/** 追问 chip（小号驻留按钮） */
function DwellChip({
  id,
  label,
  icon,
  hoverMs,
  onTrigger,
}: {
  id: string;
  label: string;
  icon?: React.ReactNode;
  hoverMs: number;
  onTrigger: () => void;
}) {
  const { interactive, registerZone } = usePlatform();
  const progress = useDwell(id, hoverMs, onTrigger, { disabled: interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone(id, refEl);
    return () => registerZone(id, null);
  }, [id, refEl, registerZone]);
  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      onClick={interactive ? onTrigger : undefined}
      className={`ov-chip ov-text relative flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium ${interactive ? '' : ''}`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {!interactive && progress > 0 && (
        <span className="ov-bar absolute bottom-0 left-0 h-[2px]" style={{ width: `${progress * 100}%` }} />
      )}
    </button>
  );
}

/** 一键配色：截屏采样背景色 → 推导主题（本地版 overlay.suggestPalette） */
function PaletteButton() {
  return <ConfirmPaletteButton id="auto-palette" onApply={applyPalette} />;
}

async function applyPalette() {
  const doc = document.documentElement;
  try {
    doc.classList.add('ov-palette-capturing');
    await new Promise((r) => setTimeout(r, 150));
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
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      const hex = `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const { applyPaletteLook } = await import('@/lib/dualCamera');
      await applyPaletteLook('exam', {
        bg: hex,
        fg: lum > 0.4 ? '#0f172a' : '#f8fafc',
        theme: lum > 0.4 ? 'light' : 'dark',
      });
    }
    window.setTimeout(() => doc.classList.remove('ov-palette-fade'), 1500);
  } catch {
    doc.classList.remove('ov-palette-capturing');
  }
}

/** ScrollEdgePill 包装（保持 JSX 顺序清晰） */
function ScrollEdgePillProxy(props: {
  id: string;
  direction: 'up' | 'down';
  label: string;
  hotkey?: string;
}) {
  return <ScrollEdgePill {...props} />;
}
