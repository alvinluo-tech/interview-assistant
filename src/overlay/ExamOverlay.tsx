import {GenerationDetails} from './GenerationDetails';
import {selectSolverTurn} from '@/lib/examEngine';
/*
 * 笔试浮窗：顶栏（拖拽/品牌/题号/状态/档位）、
 * 滚动边缘、markdown 正文、追问 chips、底栏（模式/解题/加页/重置/退出、
 * 多页收集态）。文案与悬停时长集中定义。
 */
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowDown, Copy, Puzzle } from 'lucide-react';
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
  continueTurn,
  fixTurnWithSamples,
  restorePreviousAnswer,
  prepareExamRun,
  extractLastCodeBlock,
  scaffoldForTurn,
  type TurnScaffold,
  stripMarkdown,
  type SolverState,
} from '@/lib/examEngine';
import { setOverlaySize, setSessionActive, isTauri } from '@/lib/bridge';
import { applyOverlayPalette } from '@/lib/overlayPalette';
import type { CodeVerdict } from '@/lib/codeRunner';
import { effectiveHotkeys, hotkeyBadge, type ActionKey, type HotkeyScheme } from '@/lib/hotkeys';
import { isMac, BRAND } from '@/lib/env';
import { t } from '@/lib/i18n';
import { getSetting } from '@/lib/store';
import { Md } from './Md';
import { ThinkingLine } from './ThinkingLine';
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
    let active = true;
    const config=getSetting<{runId:string;goalId:string|null;resumeSessionId?:string}|null>('exam.pendingConfig',null);
    if(config) void (async () => {
      try {
        if(config.resumeSessionId && isTauri()) await (await import('@/lib/backend')).refreshData();
        if(active) prepareExamRun(config.runId,config.goalId,undefined,config.resumeSessionId);
      } catch (error) { if(active) showToast({type:'error',title:t('恢复笔试失败'),description:t(String((error as Error).message || error))}); }
    })();
    return () => { active = false; };
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

  // 全局热键：答题 / 截屏加页 / 复制答案 / 打断（含应急打断）
  useEffect(() => {
    if (preview) return;
    const offAnswer = bindHotkey('answer', () => void solve());
    const offCapture = bindHotkey('capture', () => void capturePage());
    const offCopy = bindHotkey('copy-code', () => void copyAnswerToClipboard());
    // 应急：鼠标正忙着做题时也能停掉这次回答，或者丢掉还没发出去的截图。
    const offCancel = bindHotkey('cancel', () => {
      const current = getSolverState();
      if (['thinking', 'streaming', 'uploading', 'capturing'].includes(current.phase)) void abortSolve();
      else if (current.pendingScreenshots.length) clearPendingScreenshots();
    });
    return () => {
      offAnswer();
      offCapture();
      offCopy();
      offCancel();
    };
  }, [preview, bindHotkey]);

  return <ExamShell skin={skin} preview={preview} />;
}

/** 复制答案（热键路径，与浮窗内按钮同一逻辑） */
async function copyAnswerToClipboard(body?:string) {
  const s = getSolverState();
  const lastBody = body ?? (s.turns.find(turn=>turn.id===s.selectedTurnId) || s.turns[s.turns.length - 1])?.body ?? '';
  if (!lastBody.trim()) {showToast({type:'info',title:t('答案还没写完，写完再复制')});return;}
  const code = extractLastCodeBlock(lastBody);
  try {
    await writeText(code ?? stripMarkdown(lastBody));
    showToast({type:'success',title:code?t('已复制代码（{n} 行）', { n: code.trimEnd().split('\n').length }):t('已复制答案文字（{n} 字）', { n: stripMarkdown(lastBody).length })});
  } catch {
    showToast({type:'error',title:t('复制失败，请再按一次')});
  }
}

async function copyRunnableCode() {
  const s = getSolverState();
  const turn = s.turns.find((item) => item.id === s.selectedTurnId) || s.turns[s.turns.length - 1];
  const scaffold = turn ? scaffoldForTurn(turn) : null;
  if (!scaffold) { showToast({ type: 'info', title: t('这道题没有识别到代码') }); return; }
  try {
    await writeText(scaffold.content);
    showToast({ type: 'success', title: scaffold.runnable ? t('已复制 {name}（含题面样例）', { name: scaffold.filename }) : t('已复制代码与样例，需自行补 main', { name: scaffold.filename }) });
  } catch {
    showToast({ type: 'error', title: t('复制失败，请再按一次') });
  }
}

function verificationLabel(verdict: CodeVerdict, language?: string): string {
  const lang = language || verdict.runner || '';
  if (verdict.verdict === 'passed') return t('已运行题面样例 {passed}/{total}（{lang}·本地）', { passed: verdict.passed, total: verdict.total, lang });
  if (verdict.verdict === 'failed') return t('样例未全部通过：{passed}/{total}（{lang}·本地）', { passed: verdict.passed, total: verdict.total, lang });
  const reason = verdict.note === 'no-samples' ? t('题面没有给出带输出的样例') : verdict.note === 'timeout' ? t('执行超时') : verdict.note === 'error' ? t('执行器异常') : t('暂不支持该语言');
  return t('未执行验证：{note}', { note: reason });
}

/** 把一段输出压成一行，方便在浮窗里并排显示「期望 / 实际」。 */
function shortValue(value: string, limit = 40): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (!flat) return '∅';
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** 失败时把每组的期望/实际露出来：不露，用户没法判断是代码错还是判定口径错。 */
function VerificationDetails({ verdict }: { verdict: CodeVerdict }) {
  if (verdict.verdict !== 'failed') return null;
  const failing = verdict.outcomes.filter((outcome) => !outcome.ok).slice(0, 3);
  if (!failing.length) return null;
  return (
    <div className="ov-text-3 mt-0.5 space-y-0.5 text-[10px]">
      {failing.map((outcome) => (
        <div key={outcome.index}>
          <span className="opacity-70">{t('第 {index} 组', { index: outcome.index + 1 })}</span>
          <span> · {t('期望 {value}', { value: shortValue(outcome.expected) })}</span>
          <span> · {t('实际 {value}', { value: shortValue(outcome.actual) })}</span>
          {outcome.error?.trim() ? <div>{t('报错：{error}', { error: shortValue(outcome.error) })}</div> : null}
        </div>
      ))}
    </div>
  );
}

function useSolverState(): SolverState {  const [, force] = useReducer((x: number) => x + 1, 0);
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
  const { interactive, setInteractive } = usePlatform();

  // 恢复会话与流式输出时贴底：followBottom 关掉后不再自动滚动。
  const followBottom = useRef(true);
  // 箭头会出现光标正下方：刚滚过就让驻留跳过一次，否则往上翻会被它拽回去。
  const lastScrollAt = useRef(0);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [awayFromBottom, setAwayFromBottom] = useState(false);

  useEffect(() => {
    registerOverlayList(listRef.current);
    return () => registerOverlayList(null);
  }, []);

  const jumpToBottom = (auto = false) => {
    if (!auto && performance.now() - lastScrollAt.current < 1200) return;
    followBottom.current = true;
    setAwayFromBottom(false);
    const el = listRef.current;
    if (!el) return;
    // 长答案动辄上万像素，平滑滚动会拖好几秒；短距离才用动画。
    const far = el.scrollHeight - el.clientHeight - el.scrollTop > 2000;
    el.scrollTo({ top: el.scrollHeight, behavior: far ? 'auto' : 'smooth' });
  };

  // 新的一轮答案出现时回到最新：用户可能正翻着旧题按了「解题」。
  useEffect(() => {
    if (solver.turns.length > 0) jumpToBottom(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solver.turns.length]);

  const modeInfo = examModeInfo(solver.mode);
  const multiPage = solver.pendingScreenshots.length > 0;
  const solving =
    solver.phase === 'thinking' ||
    solver.phase === 'streaming' ||
    solver.phase === 'capturing' ||
    solver.phase === 'uploading';

  const selected=solver.turns.find(turn=>turn.id===solver.selectedTurnId) || solver.turns[solver.turns.length-1];
  // 正文还没吐出来时，唯一能证明「模型在干活」的就是思维链：给字数、耗时和尾部预览。
  const waitingFirstToken = solving && !solver.turns.find(turn => turn.id === solver.activeTurnId)?.body.trim();
  // 被输出上限截断且已有正文：给「继续生成」把剩下的写完，而不是让用户自己追问。
  const truncated = selected?.completionStatus === 'truncated' && Boolean(selected?.body.trim());
  // 样例没全过：让用户决定要不要按失败样例重写（最多两轮，硬上限）。
  const fixable = selected?.verification?.verdict === 'failed' && (selected?.fixRound ?? 0) < 2;
  const copy = () => copyAnswerToClipboard(selected?.body ?? '');
  // 追问输入框要能打字：浮窗默认穿透，打开时临时投影为可交互，关闭后还原原状态。
  const [askOpen, setAskOpen] = useState(false), [askText, setAskText] = useState('');
  const askRestore = useRef(false);
  const openAsk = () => {askRestore.current = interactive; setInteractive(true); setAskOpen(true);};
  const closeAsk = () => {setAskOpen(false); setInteractive(askRestore.current);};
  const sendAsk = () => {
    const message = askText.trim();
    if (!message) return;
    setAskText('');
    closeAsk();
    void followUp({ message, turnId: selected?.id });
  };

  const doSolve = async () => {
    await solve();
  };

  const empty = solver.turns.length === 0 && !multiPage && !solving && !solver.errorMessage;
  // 恢复会话时吸到底部；之后只在内容变高时贴底，用户的长滚动永远不被抢回来。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    let frame = 0;
    const paint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setAwayFromBottom(el.scrollHeight - el.clientHeight - el.scrollTop > 24);
      });
    };
    // 只记录跟随意图，不改滚动位置：滚动事件里贴底会和用户的滚轮打架。
    const onScroll = () => {
      lastScrollAt.current = performance.now();
      followBottom.current = el.scrollHeight - el.clientHeight - el.scrollTop <= 24;
      paint();
    };
    // 内容变高（流式输出、图片解码）才主动贴底。
    const stick = () => {
      if (followBottom.current) el.scrollTop = el.scrollHeight;
      paint();
    };
    el.scrollTop = el.scrollHeight;
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(stick);
    if (contentRef.current) observer.observe(contentRef.current);
    paint();
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [empty]);


  return (
    <div
      className={`relative flex h-full flex-col overflow-hidden rounded-[16px] border text-[13px] ${isDark ? 'overlay-dark' : ''}`}
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
        className="flex h-[46px] shrink-0 items-center gap-1.5 border-b px-3"
        style={{ background: 'var(--ov-tool-bg)', borderBottomColor: 'var(--ov-tool-line)' }}
      >
        <DragHandle hoverMs={1000} />
        <span className="ov-text-2 truncate text-[11px] font-medium">{BRAND}</span>
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

      <ScrollEdgePillProxy id="scroll-up" direction="up" label={t('悬停回看')} hotkey={hotkeys['scroll-up']} />

      {/* 消息区 */}
      <div className="relative min-h-0 flex-1">
        <div ref={listRef} className="h-full overflow-y-auto p-3">
          {empty ? (
            <div className="ov-text-2 flex h-full flex-col items-center justify-center gap-1.5 px-4 text-center">
              <div className="ov-text text-[13px] font-medium">{t('把鼠标悬停到下方「解题」按钮 1.2 秒')}</div>
              <div className="ov-text-2 text-[11px] opacity-80">{t('AI 会自动截屏并解答')}</div>
              <div className="ov-text-3 text-[10.5px] opacity-60">
                {t('也可以直接按 {keys}，手不用离开键盘', { keys: hotkeyBadge(hotkeys.answer, isMac()) })}
              </div>
            </div>
          ) : (
            <div ref={contentRef}>
              {multiPage && (
                <div className="ov-chip mb-2 rounded-md border px-2 py-1 text-[11px]">
                  {t('已截 {n} 页，按「发送」开始解答', { n: solver.pendingScreenshots.length })}
                </div>
              )}
              {solver.statusText && (
                <div className="ov-text-2 mb-2 flex items-center gap-1.5 text-[11px]">
                  <span className="ov-dot size-1.5 animate-pulse rounded-full" />
                  {solver.statusText}
                </div>
              )}
              {waitingFirstToken && (
                <ThinkingLine
                  elapsedSec={solver.elapsedSec}
                  chars={solver.reasoningChars}
                  preview={solver.reasoningPreview}
                  quietSec={solver.quietSec}
                  firstTokenMs={solver.firstTokenMs}
                />
              )}
              {solver.turns.map((turn, i) => (
                <div key={turn.id} className="mb-3">
                  <DwellChip id={`select-${turn.id}`} hoverMs={1200} onTrigger={()=>selectSolverTurn(turn.id)} label={t('{index} · {kind}{state}', { index: i+1, kind: turn.parentTurnId?t('追问'):t('原题'), state: selected?.id===turn.id?t(' · 当前追问对象'):t(' · 选择此题追问') })} />
                  {turn.body.startsWith('> ') && (
                    <div className="ov-text-3 mb-1 text-[11px] italic opacity-80">
                      {turn.body.split('\n')[0].slice(2)}
                    </div>
                  )}
                  <div data-overlay-scroll-anchor={i === solver.turns.length - 1 || undefined}>
                    <Md text={turn.body.replace(/^> .*\n\n/, '')} />
                    <GenerationDetails status={turn.completionStatus} request={turn.request}/>
                    {turn.verification && <div className="ov-text-3 mt-1 text-[10px]" role="status">{verificationLabel(turn.verification, turn.codeLanguage)}</div>}
                    {turn.verification && <VerificationDetails verdict={turn.verification} />}
                    {turn.imageSaveError && <div role="alert" className="ov-text-2">{t('原题截图未保存，请保留题目并在需要时重新截图。')}</div>}
                  </div>
                </div>
              ))}
              {solver.errorMessage && (
                <div className="ov-text-2 rounded-md border border-dashed px-2 py-1.5 text-[11px]">
                  {solver.errorMessage}
                </div>
              )}
            </div>
          )}
        </div>
        {awayFromBottom && <ScrollToBottomButton onJump={() => jumpToBottom()} />}
      </div>

      <ScrollEdgePillProxy id="scroll-down" direction="down" label={t('悬停看新')} hotkey={hotkeys['scroll-down']} />

      {/* 追问 chips */}
      {solver.turns.length > 0 && !multiPage && !solving && (
        <div className="mt-2 flex flex-wrap gap-1.5 px-2">
          {[...new Set(selected?.followUpOptions ?? [])].slice(0,3).map((option,index)=><DwellChip
            key={option} id={`suggested-${index}`} hoverMs={HOVER_MS.followUp} label={option}
            onTrigger={() => void followUp({message:option})} />)}
          {truncated && (
            <DwellChip
              id="continue-answer"
              hoverMs={HOVER_MS.followUp}
              onTrigger={() => void continueTurn(selected?.id)}
              label={t('继续生成')}
            />
          )}
          {fixable && (
            <DwellChip
              id="fix-samples"
              hoverMs={HOVER_MS.followUp}
              onTrigger={() => void fixTurnWithSamples(selected?.id)}
              label={t('按样例修正')}
            />
          )}
          {selected?.previousBody && (
            <DwellChip
              id="restore-answer"
              hoverMs={HOVER_MS.followUp}
              onTrigger={() => void restorePreviousAnswer(selected?.id)}
              label={t('恢复上一版')}
            />
          )}
          {showCopyCode && (
            <DwellChip
              id="copy-code"
              hoverMs={HOVER_MS.copyCode}
              onTrigger={() => void copy()}
              icon={<Copy size={11} />}
              label={
                extractLastCodeBlock(solver.turns[solver.turns.length - 1]?.body ?? '')
                  ? t('复制代码')
                  : t('复制文字')
              }
            />
          )}
          {(() => {
            const scaffold: TurnScaffold | null = scaffoldForTurn(selected ?? solver.turns[solver.turns.length - 1]);
            if (!scaffold) return null;
            return (
              <DwellChip
                id="copy-runnable"
                hoverMs={HOVER_MS.copyCode}
                onTrigger={() => void copyRunnableCode()}
                icon={<Copy size={11} />}
                label={t('复制可运行代码')}
              />
            );
          })()}          <DwellChip
            id="fu-simplify"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'simplify' })}
            label={t('继续简化')}
          />
          <DwellChip
            id="fu-brute"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'brute-force' })}
            label={t('换暴力解法')}
          />
          <DwellChip
            id="fu-review"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'code-review' })}
            label={t('截图检查当前代码')}
          />
          <DwellChip
            id="fu-optimize"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => void followUp({ intent: 'optimize' })}
            label={t('优化复杂度')}
          />
          <DwellChip
            id="fu-ask"
            hoverMs={HOVER_MS.followUp}
            onTrigger={() => (askOpen ? closeAsk() : openAsk())}
            label={t('追问')}
          />
        </div>
      )}

      {askOpen && !solving && (
        <div className="mt-2 px-2">
          <textarea
            autoFocus
            rows={2}
            value={askText}
            onChange={event => setAskText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {event.preventDefault(); sendAsk();}
              else if (event.key === 'Escape') {event.preventDefault(); closeAsk();}
            }}
            placeholder={t('追问：例如时间复杂度太高，请换成能满足题面限制的写法')}
            className="ov-input w-full resize-none rounded-md border px-2 py-1.5 text-[11px] outline-hidden"
          />
          <div className="mt-1 flex items-center gap-2">
            <span className="ov-text-3 text-[10px]">{t('Enter 发送 · Shift + Enter 换行')}</span>
            <div className="flex-1" />
            <button type="button" onClick={closeAsk} className="ov-chip ov-text rounded px-2 py-0.5 text-[10.5px]">{t('取消')}</button>
            <button type="button" disabled={!askText.trim()} onClick={sendAsk} className="ov-chip ov-text rounded px-2 py-0.5 text-[10.5px] disabled:opacity-40">{t('发送')}</button>
          </div>
        </div>
      )}

      {/* 底栏 */}
      <div
        className="mt-1 max-h-[50vh] shrink-0 overflow-y-auto border-t px-2 py-1.5"
        style={{ background: 'var(--ov-tool-bg)', borderTopColor: 'var(--ov-tool-line)' }}
      >
        <div className="flex flex-wrap gap-1.5">
          <DwellButton
            id="mode"
            variant="muted"
            hoverMs={HOVER_MS.mode}
            subLabel={t('最多 {n} 页', { n: modeInfo.maxScreenshotPages })}
            onTrigger={() => setSolverMode(nextOf(solver.mode))}
          >
            {t(modeInfo.shortLabel)}
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
                {t('发送 {n} 页', { n: solver.pendingScreenshots.length })}
              </DwellButton>
              <DwellButton
                id="add-page"
                variant="muted"
                hoverMs={HOVER_MS.addPage}
                hotkey={hotkeys.capture}
                subLabel={t('已 {done}/{max}', { done: solver.pendingScreenshots.length, max: modeInfo.maxScreenshotPages })}
                onTrigger={() => void capturePage()}
              >
                {t('加页')}
              </DwellButton>
              <DwellButton
                id="cancel-pages"
                variant="muted"
                hoverMs={HOVER_MS.cancelPages}
                // 答题途中也要能中断：多页模式下原本只有「清空待发截图」，在飞的请求停不下来。
                onTrigger={() => (solving ? void abortSolve() : clearPendingScreenshots())}
              >
                {t(solving ? '打断回答' : '取消')}
              </DwellButton>
            </>
          ) : (
            <>
              <DwellButton
                id="solve"
                variant="primary"
                hoverMs={HOVER_MS.answer}
                hotkey={hotkeys.answer}
                subLabel={solving ? t('处理中') : undefined}
                onTrigger={() => void doSolve()}
              >
                <span className="flex items-center gap-1">
                  <Puzzle size={12} />
                  {t('解题')}
                </span>
              </DwellButton>
              {!solving && (
                <DwellButton
                  id="add-page"
                  variant="muted"
                  hoverMs={HOVER_MS.answer}
                  hotkey={hotkeys.capture}
                  subLabel={t('先截第1页')}
                  onTrigger={() => void capturePage()}
                >
                  {t('加页')}
                </DwellButton>
              )}
              <DwellButton
                id="reset"
                variant="muted"
                hoverMs={HOVER_MS.reset}
                hotkey={solving ? hotkeys.cancel : undefined}
                subLabel={solving ? t('保留已生成的部分') : undefined}
                onTrigger={() => void abortSolve()}
              >
                {t(solving ? '打断' : '重置')}
              </DwellButton>
            </>
          )}
          <DwellButton
            id="exit"
            variant="destructive"
            hoverMs={HOVER_MS.exit}
            onTrigger={() => void endExamSession(false)}
          >
            {t('退出')}
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
  if (s.phase === 'error') return t('出错，可重试');
  if (s.phase === 'capturing') return t('截屏中…');
  if (s.phase === 'uploading') return t('上传截图…');
  if (s.phase === 'thinking') return t('AI 思考中…');
  if (s.phase === 'streaming') return t('AI 输出中…');
  return t('已连接');
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
  const { interactive, registerZone, simulate } = usePlatform();
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
      onClick={interactive && !simulate ? onTrigger : undefined}
      className={`ov-chip ov-text relative flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium ${interactive ? '' : ''}`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-[inherit] ring-1 ring-inset ring-current opacity-25" />
      )}
    </button>
  );
}

/** 一键配色：截屏采样背景色 → 推导主题（本地版 overlay.suggestPalette） */
function PaletteButton() {
  return <ConfirmPaletteButton id="auto-palette" onApply={() => applyOverlayPalette('exam')} />;
}

/** 一键回到底部：只在离开底部时出现，与自由对话的箭头一致 */
function ScrollToBottomButton({ onJump }: { onJump: () => void }) {
  const { interactive, registerZone, simulate } = usePlatform();
  const progress = useDwell('scroll-bottom', 400, onJump, { disabled: interactive });
  const [refEl, setRefEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    registerZone('scroll-bottom', refEl);
    return () => registerZone('scroll-bottom', null);
  }, [refEl, registerZone]);
  return (
    <button
      ref={setRefEl as (el: HTMLButtonElement | null) => void}
      type="button"
      onClick={interactive && !simulate ? onJump : undefined}
      aria-label={t('滚动到底部')}
      title={t('滚动到底部')}
      className="ov-chip ov-text absolute bottom-2 right-2 z-10 flex size-7 items-center justify-center rounded-full border shadow-md"
    >
      <ArrowDown size={14} />
      {!interactive && progress > 0 && (
        <span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-current opacity-25" />
      )}
    </button>
  );
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
