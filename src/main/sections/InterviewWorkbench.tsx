import { useAiReady, useAiSettings } from '@/lib/aiSettings';
import { usesLiveSpeech } from '@/lib/aiConfig';
import { DualCameraSwitch } from '@/lib/dualCamera';
import { t } from '@/lib/i18n';
/*
 * 面试工作台：面试方式、简历/岗位/资料选择、回答风格、
 * 静音门限、自动回答等偏好，开始/结束会话。
 */
import { useState, type ReactNode } from 'react';
import { Mic, Check, ChevronRight, FileText, FolderOpen, Globe2, Headphones, Loader2, MessageSquare, Play, Sparkles, Square, Target, Timer, Video, Volume2 } from 'lucide-react';
import {
  Button,
  Select,
  Slider,
  Switch,
  Textarea,
  showToast,
} from '@/ui/primitives';
import { useData, type Goal, type Resume, type Material, type InterviewSession } from '@/lib/backend';
import { useSetting, setSetting } from '@/lib/store';
import { startOverlayFlow } from '../MainWindow';
import { ANSWER_STYLES, type AnswerStyle } from '@/lib/ai';
import { MicrophoneCheck } from './MicrophoneCheck';
import { requestInterviewStop } from '@/lib/interviewLifecycle';
import { OutputExclusions } from './OutputExclusions';
import {SpeechProfilePanel} from './SpeechProfilePanel';
import {useSpeechProfile} from '@/lib/speechPreferences';
import {SPEECH_LANGUAGES} from '@/lib/speechProfile';
import {PhoneSpeakerSetup} from './PhoneSpeakerSetup';

export function InterviewWorkbench({ onNavigate }: { onNavigate: (s: string) => void }) {
  const [speechProfile,saveSpeechProfile]=useSpeechProfile('interview');
  const goals = useData<Goal[]>('goals', [])[0];
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  const sessions = useData<InterviewSession[]>('interviewSessions', [])[0];
  const [goalId, setGoalId] = useSetting<string | null>('exam.goalId', goals[0]?.id ?? null);
  // 选中的简历要跨页面切换保留：存在设置里，切到别的页面再回来不会重置。
  const [storedResumeId, setResumeId] = useSetting<string>('interview.pendingResumeId', '');
  const defaultResumeId = resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '';
  // 记录过但简历已被删除时回退到默认，避免下拉框显示空值。
  const resumeId = resumes.some((r) => r.id === storedResumeId) ? storedResumeId : defaultResumeId;
  const [materialIds, setMaterialIds] = useSetting<string[]>('interview.pendingMaterialIds', []);
  const [savedAudioSource, setAudioSource] = useSetting<'SPEAKER' | 'PHONE' | 'MICROPHONE'>(
    'interview.audioSource',
    'SPEAKER',
  );
  // The former microphone practice card is a legacy phone-mode selection, not the AI mock room.
  const audioSource = savedAudioSource === 'SPEAKER' ? 'SPEAKER' : 'PHONE';
  const [silenceGateMs, setSilenceGateMs] = useSetting<number>('interview.silenceGateMs', 900);
  const [autoAnswer, setAutoAnswer] = useSetting<boolean>('interview.autoAnswer', true);
  const [prefsState, setPrefsState] = useSetting<Record<string, unknown>>('interviewPreference', {});
  const answerStyle = (prefsState.answerStyle as AnswerStyle) ?? 'natural';
  const [starting, setStarting] = useState(false);
  const chatReady = useAiReady('chat');
  const sttReady = useAiReady('stt');
  const aiReady = chatReady && sttReady;
  const aiSettings = useAiSettings();
  const liveSpeech = usesLiveSpeech(aiSettings);
  const sttRoute = aiSettings.routes.stt;
  const sttProvider = aiSettings.providers.find(provider => provider.id === sttRoute?.providerId);
  // 会话状态由浮窗掌管，工作台通过本地数据层感知
  const activeSessionId = sessions.find((s) => s.type === 'INTERVIEW' && s.status === 'ACTIVE')?.id ?? null;
  const activeSession = activeSessionId != null;
  const materialChosen = materials.filter((m) => materialIds.includes(m.id));
  const langName = (id: string) => SPEECH_LANGUAGES.find((item) => item.id === id)?.name ?? id;
  const translation = speechProfile.translationLanguage;
  const speechProfileLabel = `${translation === 'none' ? t('辅助翻译') + t('关闭') : t('辅助翻译') + langName(translation)}`;
  const [materialsOpen, setMaterialsOpen] = useState(false);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [outputOpen, setOutputOpen] = useState(false);

  const start = async () => {
    if (starting) return;
    if (!sttReady || (autoAnswer && !chatReady)) {
      showToast({ type: 'error', title: t('请先配置 AI 服务'), description: !sttReady ? t('请为语音转写选择模型，然后开始练习。') : t('自动回答需要配置对话作答模型。') });
      return;
    }
    setStarting(true);
    try {
      // 上一场如果还挂着（崩溃/强退留下的），先收尾再开新场
      if (activeSession) {
        const { completeSession } = await import('@/lib/backend');
        await completeSession(activeSessionId);
      }
      // 会话由浮窗侧创建并掌管（两个 webview 的运行时状态不共享）
      await setSetting('interview.sessionId', null);
      await setSetting('interview.pendingConfig', {
        goalId,
        resumeId: resumeId || null,
        materialIds,
        audioSource,
      });
      await startOverlayFlow('interview', goalId);
      showToast({ type: 'success', title: t('面试会话已启动'), description: t('浮窗正在连接，主窗口已收起。') });
    } catch (e) {
      showToast({
        type: 'error',
        title: t('开始面试失败，请重试'),
        description: String((e as Error).message ?? e),
      });
    } finally {
      setStarting(false);
    }
  };

  const stop = async () => {
    const { recallWorkbench } = await import('../MainWindow');
    try {
      if (activeSessionId) await requestInterviewStop(activeSessionId);
      await setSetting('interview.sessionId', null);
    } catch (error) {
      showToast({type:'error',title:t('结束面试未完成'),description:String((error as Error).message||error)});
    } finally {await recallWorkbench();}
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_240px] items-start gap-6">
      <div className="flex min-w-0 flex-col gap-8">
        {activeSession && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-selection px-4 py-3">
            <div className="flex items-center gap-3">
              <Loader2 size={18} className="animate-spin text-primary" />
              <div>
                <div className="text-sm font-medium text-selection-fg">{t('面试进行中')}</div>
                <div className="text-xs text-ink-muted">{t('浮窗正在聆听；结束会自动回到工作台。')}</div>
              </div>
            </div>
            <Button variant="destructive" size="sm" onClick={() => void stop()}>
              <Square size={13} />
              {t('结束面试')}
            </Button>
          </div>
        )}

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('这一场的背景')}</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-raised">
            <SettingLine icon={Target} title={t('目标岗位')}>
              <div className="w-[188px] [&>select]:h-9 [&>select]:w-full [&>select]:border-line [&>select]:text-[13px]"><Select value={goalId ?? ''} onChange={(e) => setGoalId(e.target.value || null)}>
                {goals.length === 0 && <option value="">{t('先去资料管理新建')}</option>}
                {goals.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                  </option>
                ))}
              </Select></div>
            </SettingLine>
            <SettingLine icon={FileText} title={t('使用简历')}>
              <div className="w-[168px] [&>select]:h-9 [&>select]:w-full [&>select]:border-line [&>select]:text-[13px]"><Select value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
                {resumes.length === 0 && <option value="">{t('先去资料管理上传')}</option>}
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                    {r.isSample ? t(' · 示例') : ''}
                  </option>
                ))}
              </Select></div>
            </SettingLine>
            <DisclosureLine
              icon={FolderOpen}
              title={t('关联资料')}
              desc={
                materialChosen.length === 0
                  ? t('还没有选择资料')
                  : t('{count} 份 · {names}', { count: materialChosen.length, names: materialChosen.map((m) => m.name).join('、') })
              }
              open={materialsOpen}
              onToggle={() => setMaterialsOpen((v) => !v)}
            />
            {materialsOpen && (
              <div className="px-4 pb-4 pt-1">
                <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line bg-surface-base p-2">
                  {materials.length === 0 && (
                    <span className="text-xs text-ink-muted">{t('还没有面试资料，先在「资料管理」里上传或新建一份')}</span>
                  )}
                  {materials.map((m) => {
                    const on = materialIds.includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMaterialIds(on ? materialIds.filter((x) => x !== m.id) : [...materialIds, m.id].slice(0, 20))}
                        className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                          on ? 'border-primary/40 bg-selection text-selection-fg' : 'border-line text-ink-muted hover:bg-[var(--mx-action-secondary-hover)]'
                        }`}
                      >
                        {m.name}
                      </button>
                    );
                  })}
                </div>
                <button type="button" className="mt-2 text-xs text-primary hover:underline" onClick={() => onNavigate('resource')}>
                  {t('管理资料')}
                </button>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-ink-muted">{t('只使用本场选定的资料组织回答。')}</p>
        </section>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('声音与回答')}</h2>
          <div className="divide-y divide-line rounded-xl border border-line bg-surface-raised">
            <SettingLine icon={Headphones} title={t('声音来源')} desc={t('按面试方式选择输入')} align="center">
              <div className="flex rounded-lg bg-surface-sunken p-0.5">
                {[
                  { key: 'SPEAKER', label: t('线上会议') },
                  { key: 'PHONE', label: t('电话外放') },
                ].map((c) => (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setAudioSource(c.key as 'SPEAKER' | 'PHONE')}
                    className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                      audioSource === c.key ? 'bg-surface-raised font-medium text-ink shadow-card' : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </SettingLine>

            {audioSource === 'SPEAKER' ? (
              <>
                <DisclosureLine
                  icon={Volume2}
                  title={t('系统声音')}
                  desc={t('自动采集电脑里播放的声音，可排除其他播放设备')}
                  open={outputOpen}
                  onToggle={() => setOutputOpen((v) => !v)}
                />
                {outputOpen && (
                  <div className="px-4 pb-4 pt-1">
                    <OutputExclusions active={activeSession} />
                  </div>
                )}
              </>
            ) : (
              <div className="px-4 py-3">
                <MicrophoneCheck enabled={!starting && !activeSession} />
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">{t('请确保麦克风能听到电话另一端的声音。在上方完成自己的试音后可启用本地声音识别；未确认身份的转写可在浮窗标记为“这是我”或“面试官 · 作答”。与 AI 对练请使用独立的「模拟面试」入口。')}</p>
                <PhoneSpeakerSetup disabled={activeSession} />
              </div>
            )}

            {sttProvider && (
              <SettingLine
                icon={Mic}
                title={t('语音转写')}
                desc={`${sttProvider.name} / ${sttRoute?.modelId}`}
                align="center"
              >
                <span className="rounded-md bg-surface-sunken px-2 py-1 text-[11px] text-ink-muted" data-testid="speech-mode-summary">
                  {aiSettings.speechInputMode === 'realtime' ? t('持续实时语音流') : liveSpeech ? t('分段实时字幕') : t('停顿后识别')}
                </span>
              </SettingLine>
            )}

            <SettingLine icon={Sparkles} title={t('自动回答')} desc={t('问题结束后给出参考思路')} align="center">
              <Switch ariaLabel={t('自动回答')} checked={autoAnswer} onCheckedChange={setAutoAnswer} />
            </SettingLine>

            <SettingLine icon={Video} title={t('双机位面试')} desc={t('有第二个摄像头拍你和屏幕时打开，浮窗会几乎全透明。')} align="center">
              <DualCameraSwitch scope="interview" />
            </SettingLine>

            <DisclosureLine
              icon={Globe2}
              title={t('语言与翻译')}
              desc={speechProfileLabel}
              open={speechOpen}
              onToggle={() => setSpeechOpen((v) => !v)}
            />
            {speechOpen && (
              <div className="px-4 pb-4 pt-1">
                <SpeechProfilePanel value={speechProfile} disabled={activeSession} onChange={value=>void saveSpeechProfile(value).catch(error=>showToast({type:'error',title:t('语言设置保存失败'),description:String(error)}))}/>
              </div>
            )}

            <SettingLine icon={Timer} title={t('等面试官说完的时间')} desc={t('静音 {ms}ms 后出回答。说话慢就调大。', { ms: silenceGateMs })} align="center">
              <div className="w-40">
                <Slider min={300} max={6000} step={100} value={silenceGateMs} onChange={setSilenceGateMs} />
                <div className="mt-1 flex justify-between text-[10px] text-ink-muted">
                  <button type="button" className="hover:text-ink" onClick={() => setSilenceGateMs(1000)}>{t('灵敏')}</button>
                  <button type="button" className="hover:text-ink" onClick={() => setSilenceGateMs(1600)}>{t('适中')}</button>
                  <button type="button" className="hover:text-ink" onClick={() => setSilenceGateMs(2200)}>{t('稳妥')}</button>
                </div>
              </div>
            </SettingLine>

            <DisclosureLine
              icon={MessageSquare}
              title={t('回答风格')}
              desc={t(ANSWER_STYLES.find((s) => s.key === answerStyle)?.label ?? '自然')}
              open={styleOpen}
              onToggle={() => setStyleOpen((v) => !v)}
            />
            {styleOpen && (
              <div className="space-y-3 px-4 pb-4 pt-1">
                <Select className="w-48" value={answerStyle} onChange={(e) => void setPrefsState({ ...prefsState, answerStyle: e.target.value })}>
                  {ANSWER_STYLES.map((s) => (
                    <option key={s.key} value={s.key}>{t(s.label)}</option>
                  ))}
                </Select>
                <Textarea
                  rows={2}
                  maxLength={2000}
                  placeholder={t('例如：回答尽量控制在 1 分钟内，多提订单系统项目')}
                  value={String(prefsState.customAnswerStyle ?? '')}
                  onChange={(e) => setPrefsState({ ...prefsState, customAnswerStyle: e.target.value })}
                />
              </div>
            )}
          </div>
          {!aiReady && (
            <div className="mt-3 rounded-lg border border-[var(--mx-status-warning-border)] bg-[var(--mx-status-warning-bg)] px-3 py-2 text-xs text-[var(--mx-status-warning-text)]">
              {t('请到「设置 → AI 服务」分别为对话作答与语音转写选择模型；两项可使用不同连接。')}
            </div>
          )}
        </section>
      </div>

      <aside className="sticky top-4 flex flex-col gap-4">
        <div className="rounded-xl border border-line bg-surface-raised p-5 shadow-card">
          <div className="mb-4 flex size-9 items-center justify-center rounded-lg bg-selection text-primary">
            <Check size={16} />
          </div>
          <h3 className="text-[15px] font-semibold">{t('这一场，准备好了。')}</h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('选项会记住，下次打开可以直接继续。')}</p>
          <ul className="mt-4 space-y-2.5 text-xs">
            <li className="flex items-center gap-2">
              <Check size={13} className={aiReady ? 'text-[var(--mx-status-success-text)]' : 'text-ink-muted'} />
              <span className={aiReady ? '' : 'text-ink-muted'}>{aiReady ? t('模型已配置') : t('还需要配置 AI 服务')}</span>
            </li>
            <li className="flex items-center gap-2">
              <Check size={13} className="text-[var(--mx-status-success-text)]" />
              <span>{audioSource === 'SPEAKER' ? t('输入来源已选择') : t('麦克风输入已选择')}</span>
            </li>
            <li className="flex items-center gap-2">
              <Check size={13} className={resumeId && goalId ? 'text-[var(--mx-status-success-text)]' : 'text-ink-muted'} />
              <span className={resumeId && goalId ? '' : 'text-ink-muted'}>{resumeId && goalId ? t('已关联简历与岗位') : t('还没选简历或岗位')}</span>
            </li>
          </ul>
          <Button className="mt-5 w-full" onClick={() => void start()} disabled={starting || activeSession || !sttReady || (autoAnswer && !chatReady)}>
            <Play size={14} />
            {starting ? t('启动中…') : t('开始面试')}
          </Button>
          <p className="mt-2 text-center text-[11px] text-ink-muted">{t('Ctrl 全局动作沿用现有配置')}</p>
        </div>
        <p className="px-1 text-[11px] leading-relaxed text-ink-muted">{t('语言与回答策略可随时在偏好中调整。')}</p>
      </aside>
    </div>
  );
}

function SettingLine({
  icon: Icon,
  title,
  desc,
  align = 'start',
  children,
}: {
  icon: typeof Target;
  title: string;
  desc?: string;
  align?: 'start' | 'center';
  children: ReactNode;
}) {
  return (
    <div className={`flex justify-between gap-6 px-4 py-3 ${align === 'center' ? 'items-center' : 'items-start'}`}>
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <div className="whitespace-nowrap text-[13px] font-medium">{title}</div>
          {desc && <div className="mt-0.5 text-[11px] leading-[18px] text-ink-muted">{desc}</div>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function DisclosureLine({
  icon: Icon,
  title,
  desc,
  open,
  onToggle,
}: {
  icon: typeof Target;
  title: string;
  desc: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center justify-between gap-6 px-4 py-3 text-left transition-colors hover:bg-[var(--mx-action-secondary-hover)]">
      <div className="flex min-w-0 items-start gap-3">
        <Icon size={15} className="mt-0.5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{title}</div>
          <div className="mt-0.5 truncate text-[11px] leading-[18px] text-ink-muted">{desc}</div>
        </div>
      </div>
      <ChevronRight size={15} className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-90' : ''}`} />
    </button>
  );
}
