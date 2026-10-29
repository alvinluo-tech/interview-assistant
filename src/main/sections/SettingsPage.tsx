/*
 * 设置页（对齐原版 sU）：浮窗样式 / 通用 / 快捷键 / 隐蔽 / 更新日志 / 关于
 * 六个 tab。浮窗样式包含主题、底色浓度、文字透明度、外框线、字号、滚动速度、
 * 透明度步长、面试/笔试宽高、样式预设、预览按钮。
 * 复刻新增「AI 服务」tab 用于配置本地 AI 接口。
 */
import { useEffect, useState } from 'react';
import { Eye, RotateCcw, Trash2, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Input,
  SectionHeader,
  SettingRow,
  Slider,
  Switch,
  showToast,
} from '@/ui/primitives';
import { DEFAULT_OVERLAY_STYLE, useSetting, type OverlayStyle } from '@/lib/store';
import { normalizeStyle as normalizeStyleHelper } from '@/lib/overlayStyle';
import {
  ACTIONS,
  ACTION_LABELS,
  DEFAULT_PANIC_HOTKEY,
  SCHEME_DEFAULTS,
  effectiveHotkeys,
  keyEventToAccelerator,
  type ActionKey,
  type HotkeyScheme,
} from '@/lib/hotkeys';
import { useAiSettings, useAiReady } from '@/lib/aiSettings';
import { AiServicesTab } from './AiServicesTab';
import { setActionHotkeys, setPanicHotkey } from '@/lib/bridge';
import { APP_VERSION } from '@/lib/env';
import { LOCALE_NAMES, LOCALES, currentLocale, switchLocale, systemLocale } from '@/lib/i18n';
import { SimulatedPlatform } from '@/overlay/platform';
import { ExamOverlay } from '@/overlay/ExamOverlay';
import { InterviewOverlay } from '@/overlay/InterviewOverlay';
import { StealthTab } from './StealthTab';
import { backupData, getDataError } from '@/lib/backend';
import { UpdateStatusButton } from '../UpdateNotice';
import { DeveloperInfo } from './DeveloperInfo';
import { StorageSettings } from './StorageSettings';

type Tab = 'overlay-style' | 'general' | 'hotkeys' | 'stealth' | 'ai' | 'storage' | 'changelog' | 'about';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overlay-style', label: '浮窗样式' },
  { key: 'general', label: '通用' },
  { key: 'hotkeys', label: '快捷键' },
  { key: 'stealth', label: '隐蔽' },
  { key: 'ai', label: 'AI 服务' },
  { key: 'changelog', label: '更新日志' },
  { key: 'storage', label: '存储' },
  { key: 'about', label: '关于' },
];

export function SettingsPage() {
  const [tab, setTab] = useState<Tab>('general');
  const [aiDirty, setAiDirty] = useState(false);
  const [pendingTab, setPendingTab] = useState<Tab | null>(null);
  return (
    <div className="flex gap-6">
      <nav className="sticky top-0 flex h-fit w-[128px] shrink-0 flex-col gap-0.5 pt-1">
        <div className="mb-2 px-2 text-[13px] font-semibold">设置</div>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { if (tab === 'ai' && aiDirty && t.key !== 'ai') setPendingTab(t.key); else setTab(t.key); }}
            className={`rounded-md px-2 py-1.5 text-left text-[13px] transition-colors ${
              tab === t.key ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {tab === 'overlay-style' && <OverlayStyleTab />}
        {tab === 'general' && <GeneralTab />}
        {tab === 'hotkeys' && <HotkeysTab />}
        {tab === 'stealth' && <StealthTab />}
        {tab === 'ai' && <AiServicesTab onDirtyChange={setAiDirty} />}
        {tab === 'changelog' && <ChangelogTab />}
        {tab === 'about' && <AboutTab />}
      {tab === 'storage' && <StorageSettings />}
      </div>
      <ConfirmDialog open={pendingTab !== null} title="放弃未保存的 AI 配置？" body="模型列表、密钥和用途分配的更改还没有保存。" confirmText="放弃修改" onCancel={() => setPendingTab(null)} onConfirm={() => { if (pendingTab) setTab(pendingTab); setPendingTab(null); setAiDirty(false); }} />
    </div>
  );
}

// ---------------- 通用 ----------------

function GeneralTab() {
  const [autoOpen, setAutoOpen] = useSetting('interview.autoOpenMockShell', true);
  const [uiScale, setUiScale] = useSetting('desktop.uiScale', 1);
  const [theme, setTheme] = useSetting<'system' | 'light' | 'dark'>('desktop.theme', 'system');
  const [locale, setLocale] = useState(currentLocale());
  const [expandLangs, setExpandLangs] = useState(false);

  useEffect(() => {
    document.documentElement.style.zoom = String(uiScale);
  }, [uiScale]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const langList = expandLangs ? LOCALES : LOCALES.slice(0, 4);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader title="通用" desc="语言与外观，应用到所有窗口。" />

        <div className="mb-2 text-xs font-medium text-muted-foreground">界面语言</div>
        <p className="mb-2 text-xs text-muted-foreground">切换语言会刷新窗口让翻译生效。</p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => void switchLocale(systemLocale())}
            className="rounded-md border p-2.5 text-left text-sm hover:bg-accent"
          >
            跟随系统
            <span className="mt-0.5 block text-[11px] text-muted-foreground">当前：{LOCALE_NAMES[systemLocale()]}</span>
          </button>
          {langList.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => {
                setLocale(l);
                void switchLocale(l);
              }}
              className={`rounded-md border p-2.5 text-left text-sm transition-colors ${
                locale === l ? 'border-primary/50 bg-primary/10 text-primary' : 'hover:bg-accent'
              }`}
            >
              {LOCALE_NAMES[l]}
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{l}</span>
            </button>
          ))}
        </div>
        {LOCALES.length > 4 && (
          <button
            type="button"
            className="mt-2 text-xs text-primary hover:underline"
            onClick={() => setExpandLangs((v) => !v)}
          >
            {expandLangs ? '收起' : '展开全部语言'}
          </button>
        )}

        <div className="mt-6 mb-2 text-xs font-medium text-muted-foreground">外观主题</div>
        <p className="mb-2 text-xs text-muted-foreground">只影响主窗口；浮窗的明暗在「浮窗样式」里单独选。</p>
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: 'system', label: '跟随系统', desc: '随操作系统外观切换' },
            { key: 'light', label: '浅色', desc: '始终浅色' },
            { key: 'dark', label: '深色', desc: '始终深色' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTheme(t.key as 'system' | 'light' | 'dark')}
              className={`rounded-md border p-2.5 text-left transition-colors ${
                theme === t.key ? 'border-primary/50 bg-primary/10 text-primary' : 'hover:bg-accent'
              }`}
            >
              <span className="text-[13px]">{t.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{t.desc}</span>
            </button>
          ))}
        </div>

        <div className="mt-6 mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">界面大小</span>
          <span className="text-xs tabular-nums text-muted-foreground">{Math.round(uiScale * 100)}%</span>
        </div>
        <p className="mb-2 text-xs text-muted-foreground">
          整个主窗口的字和按钮一起放大或缩小，小屏幕上看着吃力就调大。
        </p>
        <Slider min={0.3} max={4} step={0.05} value={uiScale} onChange={setUiScale} />
        <button
          type="button"
          className="mt-2 text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
          disabled={uiScale === 1}
          onClick={() => setUiScale(1)}
        >
          恢复默认 100%
        </button>

        <div className="mt-4 border-t pt-2">
          <SettingRow
            title="自动打开设备调试页面"
            desc="开始面试/笔试后自动打开演示页，用于提前检查摄像头/麦克风等设备。关闭后需自行打开。"
          >
            <Switch checked={autoOpen} onCheckedChange={setAutoOpen} />
          </SettingRow>
        </div>
      </Card>
    </div>
  );
}

// ---------------- 浮窗样式 ----------------

const BUILTIN_PRESETS = [
  { id: 'builtin-default', name: '默认样式' },
  { id: 'builtin-dual-camera', name: '几乎全透明（双机位）' },
];

function OverlayStyleTab() {
  const [styleRaw, setStyle] = useSetting<OverlayStyle>('overlay.style', DEFAULT_OVERLAY_STYLE);
  const style = normalizeStyleHelper(styleRaw);
  const [presets, setPresets] = useSetting<{ id: string; name: string; style: OverlayStyle }[]>(
    'overlay.stylePresets',
    [],
  );
  const [presetName, setPresetName] = useState('');
  const [previewOpen, setPreviewOpen] = useState<'interview' | 'exam' | null>(null);

  const patch = (p: Partial<OverlayStyle>) => setStyle({ ...style, ...p });

  const applyPreset = (presetId: string) => {
    if (presetId === 'builtin-default') {
      setStyle(
        normalizeStyleHelper({
          ...style,
          theme: 'light',
          paletteBg: '',
          paletteFg: '',
          textHalo: true,
          textBold: false,
          fontScale: 1,
          scrollSpeed: 1,
          examBgOpacity: 0.85,
          examTextOpacity: 1,
          examBorderOpacity: 0,
          interviewBgOpacity: 0.85,
          interviewTextOpacity: 1,
          interviewBorderOpacity: 0,
        }),
      );
    } else if (presetId === 'builtin-dual-camera') {
      setStyle(
        normalizeStyleHelper({
          ...style,
          examBgOpacity: 0.03,
          examTextOpacity: 1,
          examBorderOpacity: 0.12,
          interviewBgOpacity: 0.03,
          interviewTextOpacity: 1,
          interviewBorderOpacity: 0.12,
        }),
      );
    } else {
      const p = presets.find((x) => x.id === presetId);
      if (p) setStyle(p.style);
    }
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    if (presets.length >= 30) {
      showToast({ type: 'error', title: `预设最多存 30 个，删掉一个再存。` });
      return;
    }
    const existing = presets.find((p) => p.name === name);
    if (existing) {
      setPresets(presets.map((p) => (p.id === existing.id ? { ...p, style } : p)));
    } else {
      setPresets([
        ...presets,
        { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, style },
      ]);
    }
    setPresetName('');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader
          title="浮窗样式定制"
          desc="把这一整套样式（主题、配色、底色、文字、外框线、字号、宽高）存成预设，换场景时点一下就切过去。"
          right={
            <div className="flex gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setPreviewOpen('interview')}>
                <Eye size={13} />
                预览面试浮窗
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPreviewOpen('exam')}>
                <Eye size={13} />
                预览笔试浮窗
              </Button>
            </div>
          }
        />

        {/* 预设 */}
        <div className="mb-1 text-xs font-medium text-muted-foreground">样式预设</div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {BUILTIN_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => applyPreset(p.id)}
              className="rounded-full border px-2.5 py-1 text-xs hover:border-primary/50 hover:bg-primary/5"
            >
              {p.name}
            </button>
          ))}
          {presets.map((p) => (
            <span
              key={p.id}
              className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-xs text-primary"
            >
              <button type="button" onClick={() => applyPreset(p.id)}>
                {p.name}
              </button>
              <button
                type="button"
                aria-label={`删除预设「${p.name}」`}
                onClick={() => setPresets(presets.filter((x) => x.id !== p.id))}
              >
                <Trash2 size={10} />
              </button>
            </span>
          ))}
        </div>
        <div className="mb-4 flex gap-1.5">
          <Input
            className="h-8 text-xs"
            placeholder="给现在的样式起个名字，比如「白底网页」"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') savePreset();
            }}
          />
          <Button size="sm" variant="outline" onClick={savePreset} disabled={!presetName.trim()}>
            <Plus size={13} />
            存为预设
          </Button>
        </div>

        {/* 主题 */}
        <div className="mb-1 text-xs font-medium text-muted-foreground">浮窗主题</div>
        <div className="mb-4 grid grid-cols-2 gap-2">
          {[
            { key: 'light', label: '浅色', desc: '浅色屏幕 · 白底黑字' },
            { key: 'dark', label: '深色', desc: '深色屏幕 · 黑底白字' },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => patch({ theme: t.key as 'light' | 'dark', paletteBg: '', paletteFg: '' })}
              className={`rounded-md border p-2.5 text-left transition-colors ${
                style.theme === t.key ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent'
              }`}
            >
              <span className="text-[13px] font-medium">{t.label}</span>
              <span className="mt-0.5 block text-[11px] text-muted-foreground">{t.desc}</span>
            </button>
          ))}
        </div>

        {/* 滑杆组 */}
        <SliderRow
          label="面试浮窗底色浓度"
          value={style.interviewBgOpacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ interviewBgOpacity: v })}
        />
        <SliderRow
          label="笔试浮窗底色浓度"
          value={style.examBgOpacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ examBgOpacity: v })}
        />
        <SliderRow
          label="文字透明度"
          value={style.interviewTextOpacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ interviewTextOpacity: v, examTextOpacity: v })}
        />
        <SliderRow
          label="外框线"
          value={style.interviewBorderOpacity}
          min={0}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ interviewBorderOpacity: v, examBorderOpacity: v })}
        />
        <SliderRow
          label="正文字号"
          value={style.fontScale}
          min={0.3}
          max={4}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ fontScale: v })}
        />
        <SliderRow
          label="滚动速度"
          value={style.scrollSpeed}
          min={0.05}
          max={5}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ scrollSpeed: v })}
        />
        <SliderRow
          label="快捷键调透明度的步长"
          value={style.hotkeyOpacityStep}
          min={0.01}
          max={1}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => patch({ hotkeyOpacityStep: v })}
        />

        <div className="mt-3 flex flex-col gap-1">
          <SettingRow title="文字描边" desc="底色越透，文字描边越强，保证在任意画面上都看得清。">
            <Switch checked={style.textHalo} onCheckedChange={(v) => patch({ textHalo: v })} />
          </SettingRow>
          <SettingRow title="文字加粗" desc="正文加粗，适合投影或小屏。">
            <Switch checked={style.textBold} onCheckedChange={(v) => patch({ textBold: v })} />
          </SettingRow>
        </div>

        {/* 宽高 */}
        <div className="mt-3 grid grid-cols-2 gap-4">
          <SizeRow
            title="面试浮窗宽高"
            desc="默认「手机形态」窄而高。也可以直接拖浮窗右下角改大小，两边改的是同一份设置。"
            width={style.interviewWidth}
            height={style.interviewHeight}
            onChange={(w, h) => patch({ interviewWidth: w, interviewHeight: h })}
          />
          <SizeRow
            title="笔试浮窗宽高"
            desc="笔试题干长，通常比面试浮窗宽一些更好读。"
            width={style.examWidth}
            height={style.examHeight}
            onChange={(w, h) => patch({ examWidth: w, examHeight: h })}
          />
        </div>

        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setStyle(DEFAULT_OVERLAY_STYLE)}
          >
            <RotateCcw size={13} />
            恢复默认
          </Button>
        </div>
      </Card>

      {/* 预览弹窗 */}
      {previewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-6">
          <div className="absolute inset-0" onClick={() => setPreviewOpen(null)} />
          <div className="relative z-10 flex max-h-full flex-col gap-2">
            <div className="rounded-lg bg-slate-900/80 px-3 py-1.5 text-center text-xs text-white">
              {previewOpen === 'interview' ? '面试浮窗预览' : '笔试浮窗预览'}（示例内容，非真实会话）
            </div>
            <div
              className="overflow-hidden rounded-xl shadow-2xl"
              style={{
                width: previewOpen === 'interview' ? style.interviewWidth : style.examWidth,
                height: previewOpen === 'interview' ? style.interviewHeight : style.examHeight,
                backgroundImage:
                  'repeating-conic-gradient(rgba(15,23,42,0.07) 0% 25%, rgba(148,163,184,0.14) 0% 50%)',
                backgroundSize: '16px 16px',
              }}
            >
              <SimulatedPlatform mode={previewOpen}>
                {previewOpen === 'interview' ? <InterviewOverlay preview /> : <ExamOverlay preview />}
              </SimulatedPlatform>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setPreviewOpen(null)}>
              关闭预览
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{format(value)}</span>
      </div>
      <Slider min={min} max={max} step={step} value={value} onChange={onChange} />
    </div>
  );
}

function SizeRow({
  title,
  desc,
  width,
  height,
  onChange,
}: {
  title: string;
  desc: string;
  width: number;
  height: number;
  onChange: (w: number, h: number) => void;
}) {
  return (
    <div>
      <div className="text-xs font-medium">{title}</div>
      <p className="mb-1.5 mt-0.5 text-[11px] leading-snug text-muted-foreground">{desc}</p>
      <div className="flex items-center gap-1.5">
        <Input
          type="number"
          className="h-8 w-20 text-xs"
          min={120}
          max={2560}
          value={Math.round(width)}
          onChange={(e) => onChange(Number(e.target.value) || width, height)}
        />
        <span className="text-xs text-muted-foreground">×</span>
        <Input
          type="number"
          className="h-8 w-20 text-xs"
          min={80}
          max={2560}
          value={Math.round(height)}
          onChange={(e) => onChange(width, Number(e.target.value) || height)}
        />
      </div>
    </div>
  );
}

// ---------------- 快捷键 ----------------

function HotkeysTab() {
  const [panic, setPanic] = useSetting('panic.hotkey', DEFAULT_PANIC_HOTKEY);
  const [scheme, setScheme] = useSetting<HotkeyScheme>('overlay.hotkeyScheme', 'simple');
  const [custom, setCustom] = useSetting<Partial<Record<ActionKey, string>>>('overlay.actionHotkeys', {});
  const [capturing, setCapturing] = useState<string | null>(null);
  const [panicCapturing, setPanicCapturing] = useState(false);
  const [panicRegistered, setPanicRegistered] = useState(true);

  // 恐慌键注册状态（被其它程序占用时提示，原生侧会自动重试）
  useEffect(() => {
    void import('@/lib/bridge').then(async ({ panicHotkeyStatus, onEvent }) => {
      try {
        const s = await panicHotkeyStatus();
        setPanicRegistered(Boolean(s?.registered));
      } catch {
        // ignore
      }
      onEvent<{ registered: boolean }>('panic-hotkey-status', (p) => setPanicRegistered(p.registered));
    });
  }, []);

  const effective = effectiveHotkeys(scheme, custom);

  // 录键
  useEffect(() => {
    if (!capturing && !panicCapturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setCapturing(null);
        setPanicCapturing(false);
        return;
      }
      const { accelerator, error } = keyEventToAccelerator(e);
      if (error || !accelerator) return;
      if (panicCapturing) {
        setPanic(accelerator);
        void setPanicHotkey(accelerator);
        setPanicCapturing(false);
      } else if (capturing) {
        const next = { ...custom, [capturing]: accelerator };
        setCustom(next);
        void setActionHotkeys(
          Object.entries(effectiveHotkeys(scheme, next)).map(([action, acc]) => ({ action, accelerator: acc })),
        );
        setCapturing(null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, panicCapturing, custom, scheme, setCustom, setPanic]);

  const applyScheme = (s: HotkeyScheme) => {
    setScheme(s);
    setCustom({});
    void setActionHotkeys(
      Object.entries(SCHEME_DEFAULTS[s]).map(([action, accelerator]) => ({ action, accelerator })),
    );
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-5">
        <SectionHeader
          title="应急隐藏快捷键"
          desc="面试和笔试浮窗都适用：浮窗显示时按一下瞬间隐藏，再按一次恢复，无任何提示。"
        />
        <div className="flex items-center justify-between rounded-md border p-3">
          <div>
            <div className="text-sm font-medium">当前快捷键</div>
            <div className="text-xs text-muted-foreground">
              任意键或组合都能设，包括单按一个键；客户端开着时，这个键在其他软件里按了不起作用。
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <kbd className="rounded border px-2 py-1 text-xs">
              {panicCapturing ? '请按下快捷键… (Esc 取消)' : panic}
            </kbd>
            <Button size="sm" variant="outline" onClick={() => setPanicCapturing(true)}>
              修改
            </Button>
            {panic !== DEFAULT_PANIC_HOTKEY && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPanic(DEFAULT_PANIC_HOTKEY);
                  void setPanicHotkey(DEFAULT_PANIC_HOTKEY);
                }}
              >
                默认
              </Button>
            )}
          </div>
        </div>
        {!panicRegistered && (
          <div className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
            当前快捷键未生效：已被系统或其他程序占用，按下不会有任何反应。正在后台自动重试，也可以直接换一个组合立即恢复。
          </div>
        )}
      </Card>

      <Card className="p-5">
        <SectionHeader
          title="浮窗快捷键"
          desc="面试 / 笔试浮窗打开时生效：滚动、答题、截屏、挪动浮窗都能用键盘完成，不用碰鼠标。浮窗显示期间，设好的键在其他软件里按了不起作用。"
          right={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCustom({});
                void setActionHotkeys(
                  Object.entries(SCHEME_DEFAULTS[scheme]).map(([action, accelerator]) => ({
                    action,
                    accelerator,
                  })),
                );
              }}
            >
              <RotateCcw size={13} />
              全部恢复默认
            </Button>
          }
        />
        <div className="mb-4 grid grid-cols-2 gap-2">
          {[
            {
              key: 'simple' as const,
              label: '简洁',
              desc: '⌘/Ctrl 加一个键，好按。浮窗显示期间，这些组合在其他软件里按了不起作用（比如浏览器里 Ctrl+T 开不了新标签）。',
            },
            {
              key: 'conflict-free' as const,
              label: '防冲突',
              desc: '⌘/Ctrl + ⌥/Alt + ⇧ 再加一个键，几乎不会和其他软件撞，代价是要多按两个键。',
            },
          ].map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => applyScheme(s.key)}
              className={`rounded-md border p-3 text-left transition-colors ${
                scheme === s.key ? 'border-primary/50 bg-primary/10' : 'hover:bg-accent'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{s.label}</span>
                <kbd className="rounded border px-1.5 py-0.5 text-[10px]">
                  {SCHEME_DEFAULTS[s.key].answer}
                </kbd>
              </div>
              <div className="mt-1 text-[11px] leading-snug text-muted-foreground">{s.desc}</div>
            </button>
          ))}
        </div>

        <div className="divide-y">
          {ACTIONS.map((action) => {
            const info = ACTION_LABELS[action];
            const value = effective[action];
            const isCapturing = capturing === action;
            return (
              <div key={action} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-sm">{info.label}</div>
                  <div className="text-[11px] text-muted-foreground">{info.desc}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <kbd
                    className={`min-w-[80px] rounded border px-2 py-1 text-center text-[11px] ${
                      isCapturing ? 'border-primary text-primary' : value ? '' : 'text-muted-foreground'
                    }`}
                  >
                    {isCapturing ? '请按下快捷键… (Esc 取消)' : value || '已关闭'}
                  </kbd>
                  <Button size="sm" variant="outline" onClick={() => setCapturing(action)}>
                    修改
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const next = { ...custom, [action]: '' };
                      setCustom(next);
                      void setActionHotkeys(
                        Object.entries(effectiveHotkeys(scheme, next))
                          .filter(([, acc]) => acc)
                          .map(([a, acc]) => ({ action: a, accelerator: acc })),
                      );
                    }}
                  >
                    停用
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

// ---------------- 更新日志 ----------------

function ChangelogTab() {
  const entries = [
    {
      date: '2026-10-28',
      items: [
        { tag: '新功能', text: '首个复刻版本：面试浮窗 / 笔试浮窗 / 模拟面试 / 题库资料全套页面。' },
        { tag: '新功能', text: 'AI 管线本地化：接入你自己的 OpenAI 兼容接口（对话 / 视觉 / 语音转写）。' },
        { tag: '体验优化', text: '浮窗样式系统与原版一致：主题、透明度、文字描边、字号、滚动速度。' },
      ],
    },
  ];
  return (
    <Card className="p-5">
      <SectionHeader title="更新日志" desc="这个客户端版本里的全部改动。" />
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无更新记录。</p>
      ) : (
        <div className="flex flex-col gap-4">
          {entries.map((e) => (
            <div key={e.date}>
              <div className="mb-1.5 text-xs font-medium text-muted-foreground">{e.date}</div>
              <div className="flex flex-col gap-1.5">
                {e.items.map((it, i) => (
                  <div key={i} className="flex items-start gap-2 text-sm">
                    <Badge variant={it.tag === '新功能' ? 'default' : it.tag === '体验优化' ? 'secondary' : 'outline'}>
                      {it.tag}
                    </Badge>
                    <span>{it.text}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------- 关于 ----------------

function AboutTab() {
  const ai = useAiSettings();
  const aiReady = useAiReady();
  const activeProvider = ai.providers.find(p => p.id === ai.routes.chat?.providerId);
  const [osVersion, setOsVersion] = useState('');
  const [dataBusy,setDataBusy] = useState(false);
  const [confirmRestore,setConfirmRestore] = useState(false);
  const dataError=getDataError();
  async function dataAction(restore:boolean) {
    setConfirmRestore(false);setDataBusy(true);
    try {await backupData(restore);showToast({type:'success',title:restore?'已恢复备份':'本地备份已保存',description:restore?'已同步到所有窗口。':'包含简历、资料、题库与记录，不包含 API Key。'});}
    catch(error) {showToast({type:'error',title:'数据操作失败',description:String(error)});}
    finally {setDataBusy(false);}
  }

  useEffect(() => {
    void import('@/lib/bridge').then(async ({ osVersion }) => {
      const v = await osVersion();
      setOsVersion(v ?? '');
    });
  }, []);

  return (
    <Card className="p-5">
      <SectionHeader title="关于" desc="版本信息。联系我们反馈问题时，把这里的内容一并带上。" />
      <div className="divide-y">
        <Row label="客户端版本" value={APP_VERSION} />
        <Row label="界面版本" value="随客户端内置" />
        <Row label="系统版本" value={osVersion || '无法读取'} />
        <Row
          label="客户端更新"
          value={
            <div className="flex items-center gap-2">
              <span>自动检查官方更新，确认后下载与安装。</span>
              <UpdateStatusButton />
            </div>
          }
        />
        <Row label="本地数据备份" value={<div className="space-y-2"><p className="text-xs text-muted-foreground">每次保存会保留上一份数据；手动备份可恢复。恢复前也会保留当前文件。</p>{dataError&&<p role="alert" className="text-xs text-destructive">{dataError}</p>}<Button size="sm" variant="outline" disabled={dataBusy} onClick={()=>void dataAction(false)}>创建手动备份</Button><Button size="sm" variant="ghost" disabled={dataBusy} onClick={()=>setConfirmRestore(true)}>恢复手动备份</Button></div>} />
        <Row
          label="AI 接口"
          value={
            <span className="text-xs">
              {activeProvider?.baseUrl || '未配置'}
              {aiReady ? ' · 作答模型已配置' : ' · 尚未配置作答模型'}
            </span>
          }
        />
      </div>
      <DeveloperInfo />
      <ConfirmDialog open={confirmRestore} title="恢复手动备份？" body="会用最近一次手动备份替换简历、资料、题库和会话记录。当前文件会另外保留；进行中的会话请先结束。" confirmText="恢复备份" onCancel={()=>setConfirmRestore(false)} onConfirm={()=>void dataAction(true)} />
    </Card>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}
