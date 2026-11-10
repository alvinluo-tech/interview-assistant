import {useMemo, useState} from 'react';
import {Check, ChevronDown, Search} from 'lucide-react';
import type {AiRoute, AiSettings} from '@/lib/aiConfig';
import {isSpeechRecognitionModel, resolveAiRoute} from '@/lib/aiConfig';
import {useClickOutside} from '@/ui/primitives';
import {t} from '@/lib/i18n';

interface Option { route: AiRoute; provider: string; model: string; label: string }

/** Chat-capable models across every configured provider, grouped by provider name. */
function chatModels(settings: AiSettings): Option[] {
  const options: Option[] = [];
  for (const provider of settings.providers) {
    for (const model of provider.models) {
      if (isSpeechRecognitionModel(model.id)) continue;
      // Speech-synthesis families are recognisable by name and are useless as chat models.
      if (/(?:^|-)(?:tts|cosyvoice)(?:-|$)/i.test(model.id)) continue;
      options.push({
        route: { providerId: provider.id, modelId: model.id },
        provider: provider.name,
        model: model.name || model.id,
        label: `${provider.name} · ${model.name || model.id}`,
      });
    }
  }
  return options;
}

export function describeRoute(settings: AiSettings, route: AiRoute | null): string {
  if (!route) {
    try {
      const { provider, modelId } = resolveAiRoute(settings, 'chat');
      return provider.models.find(model => model.id === modelId)?.name || modelId;
    } catch {
      return t('未配置对话模型');
    }
  }
  const provider = settings.providers.find(item => item.id === route.providerId);
  const model = provider?.models.find(item => item.id === route.modelId);
  return `${provider?.name || t('已删除的连接')} · ${model?.name || route.modelId}`;
}

/**
 * Per-conversation model picker. `value === null` means "follow the global chat route":
 * the option stays first and is selected by default, so a user who never opens the picker
 * keeps the old behaviour.
 */
export function ModelPicker({settings, value, onChange}: { settings: AiSettings; value: AiRoute | null; onChange: (next: AiRoute | null) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const options = useMemo(() => chatModels(settings), [settings]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? options.filter(option => option.label.toLowerCase().includes(needle)) : options;
  }, [options, query]);
  const ref = useClickOutside(() => setOpen(false));
  const current = describeRoute(settings, value);
  const pick = (next: AiRoute | null) => { onChange(next); setOpen(false); setQuery(''); };
  return <div ref={ref} className="relative">
    <button type="button" onClick={() => setOpen(v => !v)} aria-haspopup="listbox" aria-expanded={open}
      className="flex max-w-[15rem] items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted" title={t('模型：{model}', { model: current })}>
      <span className="truncate">{current}</span><ChevronDown size={13} className="shrink-0"/>
    </button>
    {open && <div role="listbox" className="absolute right-0 z-30 mt-1 w-72 rounded-xl border bg-popover p-1.5 shadow-lg">
      <div className="flex items-center gap-1.5 rounded-lg border px-2 py-1.5"><Search size={13} className="text-muted-foreground"/><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder={t('搜索模型')} className="w-full bg-transparent text-xs outline-none" aria-label={t('搜索模型')}/></div>
      <div className="mt-1 max-h-64 overflow-y-auto">
        <button type="button" onClick={() => pick(null)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted">
          <span className="flex-1 truncate">{t('跟随全局默认')}</span>
          {value === null ? <Check size={13} className="text-primary"/> : <span className="truncate text-[11px] text-muted-foreground">{describeRoute(settings, null)}</span>}
        </button>
        {filtered.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">{options.length ? t('没有匹配的模型') : t('请先在「设置 → AI 服务」添加模型')}</p>}
        {filtered.map(option => {
          const active = value?.providerId === option.route.providerId && value?.modelId === option.route.modelId;
          return <button key={`${option.route.providerId}:${option.route.modelId}`} type="button" role="option" aria-selected={active} onClick={() => pick(option.route)}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-muted">
            <span className="min-w-0 flex-1"><span className="block truncate">{option.model}</span><span className="block truncate text-[11px] text-muted-foreground">{option.provider}</span></span>
            {active && <Check size={13} className="shrink-0 text-primary"/>}
          </button>;
        })}
      </div>
      <p className="border-t px-2 pb-1 pt-2 text-[11px] leading-4 text-muted-foreground">{t('只影响这段对话，不会修改「设置」里的默认模型。')}</p>
    </div>}
  </div>;
}
