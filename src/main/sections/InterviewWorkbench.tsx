import { useAiReady, useAiSettings } from '@/lib/aiSettings';
import { usesLiveSpeech } from '@/lib/aiConfig';
import { DualCameraSwitch } from '@/lib/dualCamera';
/*
 * 面试工作台（对齐原版 tB）：面试方式、简历/岗位/资料选择、回答风格、
 * 静音门限、自动回答等偏好，开始/结束会话。
 */
import { useState } from 'react';
import { Play, Square, Info, Loader2 } from 'lucide-react';
import {
  Button,
  Card,
  SectionHeader,
  SettingRow,
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

export function InterviewWorkbench({ onNavigate }: { onNavigate: (s: string) => void }) {
  const goals = useData<Goal[]>('goals', [])[0];
  const resumes = useData<Resume[]>('resumes', [])[0];
  const materials = useData<Material[]>('materials', [])[0];
  const sessions = useData<InterviewSession[]>('interviewSessions', [])[0];
  const [goalId, setGoalId] = useSetting<string | null>('exam.goalId', goals[0]?.id ?? null);
  const [resumeId, setResumeId] = useState<string>(resumes.find((r) => !r.isSample)?.id ?? resumes[0]?.id ?? '');
  const [materialIds, setMaterialIds] = useSetting<string[]>('interview.pendingMaterialIds', []);
  const [audioSource, setAudioSource] = useSetting<'SPEAKER' | 'PHONE' | 'MICROPHONE'>(
    'interview.audioSource',
    'SPEAKER',
  );
  const [silenceGateMs, setSilenceGateMs] = useSetting<number>('interview.silenceGateMs', 1600);
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

  const start = async () => {
    if (starting) return;
    if (!sttReady || (autoAnswer && !chatReady)) {
      showToast({ type: 'error', title: '请先配置 AI 服务', description: !sttReady ? '请为语音转写选择模型，然后开始练习。' : '自动回答需要配置对话作答模型。' });
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
      showToast({ type: 'success', title: '面试会话已启动', description: '浮窗正在连接，主窗口已收起。' });
    } catch (e) {
      showToast({
        type: 'error',
        title: '开始面试失败，请重试',
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
      showToast({type:'error',title:'结束面试未完成',description:String((error as Error).message||error)});
    } finally {await recallWorkbench();}
  };

  return (
    <div className="flex flex-col gap-4">
      {activeSession && (
        <Card className="flex items-center justify-between border-primary/30 bg-primary/5 p-4">
          <div className="flex items-center gap-3">
            <Loader2 size={18} className="animate-spin text-primary" />
            <div>
              <div className="text-sm font-medium">面试进行中</div>
              <div className="text-xs text-muted-foreground">
                浮窗正在聆听；结束会自动回到工作台。
              </div>
            </div>
          </div>
          <Button variant="destructive" size="sm" onClick={() => void stop()}>
            <Square size={13} />
            结束面试
          </Button>
        </Card>
      )}

      <Card className="p-5">
        <SectionHeader
          title="面试工作台"
          desc="选好简历和岗位，点「开始面试」：主窗口收起，透明浮窗出现在屏幕上，面试官一说话就出参考回答。"
          right={
            <Button onClick={() => void start()} disabled={starting || activeSession || !sttReady || (autoAnswer && !chatReady)}>
              <Play size={14} />
              {starting ? '启动中…' : '开始面试'}
            </Button>
          }
        />

        <div className="mb-4 grid grid-cols-2 gap-3">
          {[
            { key: 'SPEAKER', title: '线上面试', desc: '听电脑里播放的声音（腾讯会议 / 飞书等）' },
            { key: 'MICROPHONE', title: '模拟练习', desc: '用麦克风，对着 AI 练习回答' },
          ].map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setAudioSource(c.key as 'SPEAKER' | 'MICROPHONE')}
              className={`rounded-lg border p-3 text-left transition-colors ${
                audioSource === c.key ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent'
              }`}
            >
              <div className="text-sm font-medium">{c.title}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{c.desc}</div>
            </button>
          ))}
        </div>

        {audioSource !== 'SPEAKER' && <MicrophoneCheck enabled={!starting && !activeSession} />}
        {sttProvider && <div className="mb-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs" data-testid="speech-mode-summary">
          <div className="font-medium">{sttProvider.name} / {sttRoute?.modelId} · {aiSettings.speechInputMode === 'realtime' ? '持续实时语音流' : liveSpeech ? '分段实时字幕' : '停顿后识别'}</div>
          <div className="mt-1 text-muted-foreground">{aiSettings.speechInputMode === 'realtime' ? '持续发送音频，实时显示部分字幕，句子定稿后流式回答。断线后会重连并提示中断。' : liveSpeech ? '约每 2.5 秒更新字幕；停顿后校正整句并流式回答。预览会增加转写用量。' : '等待说话停顿后转写，AI 回答逐步显示。'}</div>
        </div>}

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-medium text-muted-foreground">
            简历
            <Select className="mt-1" value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
              {resumes.length === 0 && <option value="">先去资料管理上传</option>}
              {resumes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.isSample ? ' · 示例' : ''}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs font-medium text-muted-foreground">
            目标岗位
            <Select
              className="mt-1"
              value={goalId ?? ''}
              onChange={(e) => setGoalId(e.target.value || null)}
            >
              {goals.length === 0 && <option value="">先去资料管理新建</option>}
              {goals.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.companyName ? `${g.companyName} · ${g.name}` : g.name}
                </option>
              ))}
            </Select>
          </label>
        </div>

        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              面试资料（已选 {materialChosen.length}/20 份）
            </span>
            <button
              type="button"
              className="text-xs text-primary hover:underline"
              onClick={() => onNavigate('resource')}
            >
              管理资料
            </button>
          </div>
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-md border p-2">
            {materials.length === 0 && (
              <span className="text-xs text-muted-foreground">
                还没有面试资料，先在「资料管理」里上传或新建一份
              </span>
            )}
            {materials.map((m) => {
              const on = materialIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() =>
                    setMaterialIds(on ? materialIds.filter((x) => x !== m.id) : [...materialIds, m.id].slice(0, 20))
                  }
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${
                    on ? 'border-primary/50 bg-primary/10 text-primary' : 'hover:bg-accent'
                  }`}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>

        {!aiReady && (
          <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700">
            请到「设置 → AI 服务」分别为对话作答与语音转写选择模型；两项可使用不同连接。
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionHeader title="回答策略" desc="控制 AI 回答的样子；开始面试后也可以在浮窗里热键操作。" />
        <SettingRow title="自动回答" desc="面试官说完自动出参考回答；关闭后需按「立即回答」或快捷键。">
          <Switch checked={autoAnswer} onCheckedChange={setAutoAnswer} />
        </SettingRow>
        <SettingRow
          title="双机位面试"
          desc="有第二个摄像头拍你和屏幕时打开。面试浮窗会换成几乎全透明、只留一圈淡边框，镜头里基本看不出来。"
        >
          <DualCameraSwitch scope="interview" />
        </SettingRow>
        <SettingRow
          title="等面试官说完的时间"
          desc={`静音 ${silenceGateMs}ms 后出回答。面试官说话慢就调大；预设：灵敏 1000 / 适中 1600 / 稳妥 2200。`}
        >
          <div className="w-40">
            <Slider min={300} max={6000} step={100} value={silenceGateMs} onChange={setSilenceGateMs} />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span
                className="cursor-pointer hover:text-foreground"
                onClick={() => setSilenceGateMs(1000)}
              >
                灵敏
              </span>
              <span
                className="cursor-pointer hover:text-foreground"
                onClick={() => setSilenceGateMs(1600)}
              >
                适中
              </span>
              <span
                className="cursor-pointer hover:text-foreground"
                onClick={() => setSilenceGateMs(2200)}
              >
                稳妥
              </span>
            </div>
          </div>
        </SettingRow>
        <SettingRow title="回答风格" desc="决定浮窗里参考回答的格式。">
          <Select
            className="w-36"
            value={answerStyle}
            onChange={(e) => void setPrefsState({ ...prefsState, answerStyle: e.target.value })}
          >
            {ANSWER_STYLES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <div className="pb-2">
          <div className="mb-1 text-xs font-medium text-muted-foreground">额外回答要求</div>
          <Textarea
            rows={2}
            maxLength={20000}
            placeholder="例如：回答尽量控制在 1 分钟内，多提订单系统项目"
            value={String(prefsState.customAnswerStyle ?? '')}
            onChange={(e) => setPrefsState({ ...prefsState, customAnswerStyle: e.target.value })}
          />
        </div>
      </Card>

      <div className="grid grid-cols-3 gap-3">
        {[
          { title: '实时听译', desc: '面试官说完自动出参考回答' },
          { title: '不抢焦点', desc: '浮窗不接受焦点，不打断你的操作' },
          { title: '全局热键', desc: 'Ctrl 组合键随时控制浮窗' },
        ].map((s) => (
          <Card key={s.title} className="p-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Info size={13} className="text-primary" />
              {s.title}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{s.desc}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}
