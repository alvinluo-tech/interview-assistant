import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, EyeOff, Loader2, Plus, RefreshCw, Search, Server, Trash2, Unplug } from 'lucide-react';
import { Badge, Button, Card, ConfirmDialog, Input, SectionHeader, Select, showToast } from '@/ui/primitives';
import {
  AI_ROLES, PROVIDER_PRESETS, ROLE_LABELS, bailianConnection, createProvider, mergeDiscoveredModels,
  normalizeBaseUrl, removeProvider, validateModelId, isSpeechRecognitionModel, isUnsupportedBailianSpeechModel, type AiProvider, type AiRole, type AiSettings,
} from '@/lib/aiConfig';
import { getAiLoadError, getAiSettings, reloadAiSettings, saveAiSettings, useAiSettings } from '@/lib/aiSettings';
import { discoverModels, testChatModel } from '@/lib/aiProtocol';
import { aiFetch } from '@/lib/aiTransport';
import { questionSpeaker } from '@/lib/questionSpeech';
import { DEFAULT_REALTIME_ENDPOINT, isRealtimeAsrModel } from '@/lib/realtimeAsrProtocol';

type Status = { kind: 'success' | 'error' | 'info'; text: string } | null;
const roleDescriptions: Record<AiRole, string> = {
  chat: '面试回答、模拟面试、题库与复盘。',
  vision: '截图解题。所选模型需支持图片输入。',
  stt: '实时听译及模拟面试的语音输入。',
  tts: '模拟面试官的语音播报；不指定模型时使用系统语音，无需密钥。',
};

export function AiServicesTab({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const saved = useAiSettings();
  const [voicePlaying, setVoicePlaying] = useState(false);
  const voice = useMemo(() => questionSpeaker(setVoicePlaying, reason => showToast({type:'error', title:'语音试听失败', description:String((reason as Error).message || reason)})), []);
  useEffect(() => () => voice.stop(), [voice]);
  const [draft, setDraft] = useState<AiSettings>(() => structuredClone(getAiSettings()));
  const [selectedId, setSelectedId] = useState(saved.providers[0]?.id ?? '');
  const [preset, setPreset] = useState('compatible');
  const [revealKey, setRevealKey] = useState(false);
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(30);
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'discover' | 'test' | 'save' | null>(null);
  const [testingId, setTestingId] = useState('');
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [externalConflict, setExternalConflict] = useState(false);
  const previousSaved = useRef(saved);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const provider = draft.providers.find(p => p.id === selectedId);
  const sttProvider = draft.providers.find(p => p.id === draft.routes.stt?.providerId);
  const realtimeSpeechSelected = isRealtimeAsrModel(draft.routes.stt?.modelId || '');
  const unsupportedSpeechSelected = !!sttProvider && isUnsupportedBailianSpeechModel(sttProvider,draft.routes.stt?.modelId || '');
  const automaticRealtimeEndpoint = (sttProvider && bailianConnection(sttProvider.baseUrl)?.realtimeEndpoint) || DEFAULT_REALTIME_ENDPOINT;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const loadError = getAiLoadError();

  useEffect(() => {
    const draftJson = JSON.stringify(draft);
    if (draftJson === JSON.stringify(saved)) setExternalConflict(false);
    else if (draftJson === JSON.stringify(previousSaved.current)) {
      setDraft(structuredClone(saved));
      if (!saved.providers.some(p => p.id === selectedId)) setSelectedId(saved.providers[0]?.id ?? '');
    } else setExternalConflict(true);
    previousSaved.current = saved;
  }, [saved]);

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function cancel() {
    sequence.current++;
    controller.current?.abort();
    controller.current = null;
    setBusy(null);
  }
  function selectProvider(id: string) {
    cancel(); setSelectedId(id); setSearch(''); setLimit(30); setStatus(null);
    setRevealKey(false); setCustomId(''); setCustomName(''); setError('');
  }
  function patchProvider(patch: Partial<AiProvider>) {
    cancel(); setStatus(null);
    setDraft(value => ({ ...value, providers: value.providers.map(p => p.id === selectedId ? { ...p, ...patch } : p) }));
  }
  function addProvider() {
    if (draft.providers.length >= 20) { setError('最多保存 20 个连接'); return; }
    const next = createProvider(preset);
    setDraft(value => ({ ...value, providers: [...value.providers, next] }));
    selectProvider(next.id);
  }
  async function networkAction(kind: 'discover' | 'test', modelId = '') {
    if (!provider) return;
    cancel();
    const current = ++sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(kind); setStatus(null); setError(''); setTestingId(modelId);
    const snapshot = structuredClone(provider);
    try {
      if (kind === 'discover') {
        const models = await discoverModels(snapshot, aiFetch, abort.signal);
        if (!mounted.current || sequence.current !== current) return;
        const at = new Date().toISOString();
        setDraft(value => ({ ...value, providers: value.providers.map(p => p.id === snapshot.id ? {
          ...p, baseUrl: normalizeBaseUrl(snapshot.baseUrl), models: mergeDiscoveredModels(p, models, value.routes), lastFetchedAt: at,
        } : p) }));
        setStatus({ kind: models.length ? 'success' : 'info', text: models.length ? `已从接口获取 ${models.length} 个模型。请在下方分配用途并保存。` : '接口连接成功，但模型列表为空。可以手动添加服务商提供的模型 ID。' });
      } else {
        const result = await testChatModel(snapshot, modelId, aiFetch, abort.signal);
        if (!mounted.current || sequence.current !== current) return;
        setStatus({ kind: 'success', text: `${modelId} 对话测试通过 · ${result.latencyMs} ms · ${result.sample}` });
      }
    } catch (e) {
      if (mounted.current && sequence.current === current && !abort.signal.aborted) setStatus({ kind: 'error', text: String(e instanceof Error ? e.message : e) });
    } finally {
      if (mounted.current && sequence.current === current) { setBusy(null); controller.current = null; }
    }
  }
  async function save() {
    cancel(); setBusy('save'); setError('');
    try {
      const normalized = await saveAiSettings(draft);
      if (mounted.current) setDraft(structuredClone(normalized));
      showToast({ type: 'success', title: 'AI 配置已保存', description: '新请求立即使用新配置，无需重启。' });
    } catch (e) { if (mounted.current) setError(String(e instanceof Error ? e.message : e)); }
    finally { if (mounted.current) setBusy(null); }
  }
  function addCustomModel() {
    if (!provider) return;
    try {
      const id = validateModelId(customId);
      if (provider.models.some(m => m.id === id)) throw new Error('这个模型 ID 已在列表中');
      if (provider.models.length >= 2000) throw new Error('单个连接最多保存 2000 个模型');
      patchProvider({ models: [...provider.models, { id, name: customName.trim() || id, source: 'custom' }] });
      setCustomId(''); setCustomName(''); setSearch(''); setLimit(30);
      setStatus({ kind: 'info', text: '自定义模型已添加。请在「按用途选择模型」中使用，然后保存配置。' });
    } catch (e) { setError(String(e instanceof Error ? e.message : e)); }
  }
  function deleteModel(id: string) {
    cancel();
    setDraft(value => {
      const next = structuredClone(value);
      const p = next.providers.find(p => p.id === selectedId);
      if (p) p.models = p.models.filter(m => m.id !== id);
      for (const role of AI_ROLES) if (next.routes[role]?.providerId === selectedId && next.routes[role]?.modelId === id) next.routes[role] = null;
      return next;
    });
    setStatus(null);
  }
  function assignRoute(role: AiRole, serialized: string) {
    const route = serialized ? JSON.parse(serialized) : null;
    setDraft(value => ({...value,routes:{...value.routes,[role]:route},
      ...(role === 'tts' && !route && !value.ttsVoice.trim() ? {ttsVoice:'alloy'} : {}),
      ...(role==='stt' ? {speechInputMode:route && isRealtimeAsrModel(route.modelId) ? 'realtime' : value.speechInputMode==='realtime' ? 'auto' : value.speechInputMode} : {})}));
  }
  function useCurrentConnectionRealtime() {
    if(!sttProvider)return;
    const modelId='fun-asr-realtime';
    if(sttProvider.models.length>=2000&&!sttProvider.models.some(model=>model.id===modelId)){setError('模型库已满，请先移除一个模型。');return;}
    cancel();setError('');
    setDraft(value=>({...value,providers:value.providers.map(provider=>provider.id===sttProvider.id ? {...provider,models:provider.models.some(model=>model.id===modelId)?provider.models:[...provider.models,{id:modelId,name:'Fun-ASR 实时识别',source:'custom'}]} : provider),
      routes:{...value.routes,stt:{providerId:sttProvider.id,modelId}},speechInputMode:'realtime'}));
    setStatus({kind:'info',text:'已选择当前连接的 fun-asr-realtime 和持续实时模式。请保存配置，再暂停并继续收音，或重新开始面试。'});
  }
  const filtered = provider?.models.filter(m => `${m.id} ${m.name}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  const assignedCount = AI_ROLES.filter(role => !!draft.routes[role]).length;

  return (
    <div className="flex flex-col gap-4" data-testid="ai-services">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="text-lg font-semibold tracking-tight">连接你的 AI</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">接入自己的云端密钥或本地模型，为不同任务选择合适的模型。</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">{dirty ? '有未保存的更改' : '配置已同步'}</span>
          <Button size="sm" variant="ghost" disabled={!dirty || !!busy} onClick={() => { setDraft(structuredClone(saved)); setExternalConflict(false); selectProvider(saved.providers[0]?.id ?? ''); }}>撤销更改</Button>
          <Button size="sm" onClick={() => void save()} disabled={!!busy || !dirty || !!loadError || externalConflict}>{busy === 'save' ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}保存配置</Button>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="AI 用途概览">
        {AI_ROLES.map(role => {
          const route = draft.routes[role], connection = draft.providers.find(provider => provider.id === route?.providerId);
          const label = route ? `${connection?.name || '连接待修复'} · ${route.modelId}` : role === 'tts' ? '系统默认语音' : role === 'vision' ? '跟随对话模型' : '尚未配置';
          return <button key={role} className="min-w-0 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-primary" onClick={() => document.getElementById(`ai-route-${role}`)?.focus()}>
            <span className="text-[11px] text-muted-foreground">{ROLE_LABELS[role]}</span><span className="mt-2 block truncate text-xs font-medium" title={label}>{label}</span>
          </button>;
        })}
      </div>
      {loadError && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
        配置读取失败，已阻止覆盖已有设置：{loadError}
        <Button size="sm" variant="outline" className="ml-2" onClick={() => void reloadAiSettings().then(() => { setDraft(structuredClone(getAiSettings())); setSelectedId(getAiSettings().providers[0]?.id ?? ''); })}>重新读取</Button>
      </div>}
      {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-xs text-destructive">{error}</p>}
      {externalConflict && <p role="alert" className="rounded-md border p-3 text-xs text-muted-foreground">其他窗口已更新 AI 配置。请点击「撤销更改」载入最新设置后再编辑，以免覆盖新配置。</p>}

      <Card className="overflow-hidden">
        <div className="grid min-[1120px]:grid-cols-[180px_minmax(0,1fr)]">
          <aside className="border-b bg-muted/30 p-3 min-[1120px]:border-b-0 min-[1120px]:border-r">
            <div className="mb-3 flex items-center justify-between px-1 text-xs font-medium">服务商连接<Badge variant="outline">{draft.providers.length}</Badge></div>
            <div className="flex flex-col gap-1" aria-label="服务商连接列表">
              {draft.providers.map(p => <button key={p.id} type="button" onClick={() => selectProvider(p.id)} disabled={busy === 'save'} aria-pressed={p.id === selectedId}
                className={`min-w-0 rounded-md border p-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${p.id === selectedId ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-accent'}`}>
                <span className="flex items-center gap-2 text-xs font-medium"><Server size={13} className="shrink-0" /><span className="truncate">{p.name}</span></span>
                <span className="mt-1 block truncate pl-[21px] text-[11px] text-muted-foreground">{p.models.length} 个模型 · {p.authMode === 'none' ? '免密' : 'API Key'}</span>
              </button>)}
              {!draft.providers.length && <p className="px-1 py-2 text-xs leading-relaxed text-muted-foreground">先添加一个连接。也可以同时接入云端作答和本地语音模型。</p>}
            </div>
            <div className="mt-4 border-t pt-3">
              <label className="text-[11px] text-muted-foreground" htmlFor="ai-preset">添加连接</label>
              <Select id="ai-preset" className="mt-1 h-8 text-xs" value={preset} onChange={e => setPreset(e.target.value)} disabled={busy === 'save'}>
                {PROVIDER_PRESETS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
              <Button size="sm" variant="outline" className="mt-2 w-full" onClick={addProvider} disabled={busy === 'save' || draft.providers.length >= 20}><Plus size={13} />添加连接</Button>
            </div>
          </aside>

          <div className="min-w-0 p-5">
            {!provider ? <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 text-center">
              <Unplug size={28} className="text-primary/60" /><h3 className="text-sm font-medium">从一个接口开始</h3>
              <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">添加连接后获取模型列表，或直接填写你自己的模型 ID。</p>
            </div> : <>
              <SectionHeader title="连接设置" desc="支持 OpenAI 兼容协议。地址可包含 /v1 或服务商的兼容路径。" right={
                <Button size="icon" variant="ghost" aria-label="删除当前连接" disabled={busy === 'save'} onClick={() => setRemoveId(provider.id)}><Trash2 size={14} /></Button>
              } />
              <div className="flex flex-col gap-3">
                <label className="text-xs font-medium" htmlFor="ai-provider-name">连接名称<Input id="ai-provider-name" className="mt-1" maxLength={80} value={provider.name} disabled={busy === 'save'} onChange={e => patchProvider({ name: e.target.value })} placeholder="例如：我的中转接口 / 本地语音" /></label>
                <label className="text-xs font-medium" htmlFor="ai-base-url">API 地址<Input id="ai-base-url" className="mt-1 font-mono text-xs" value={provider.baseUrl} disabled={busy === 'save'} onChange={e => patchProvider({ baseUrl: e.target.value, lastFetchedAt: null })} placeholder="https://api.example.com/v1" autoCapitalize="none" spellCheck={false} /></label>
                <div className="grid gap-3 min-[1120px]:grid-cols-[130px_minmax(0,1fr)]">
                  <label className="text-xs font-medium" htmlFor="ai-auth-mode">认证方式<Select id="ai-auth-mode" className="mt-1" value={provider.authMode} disabled={busy === 'save'} onChange={e => patchProvider({ authMode: e.target.value as AiProvider['authMode'] })}><option value="bearer">API Key</option><option value="none">无需密钥</option></Select></label>
                  <label className="min-w-0 text-xs font-medium" htmlFor="ai-api-key">API Key<div className="relative mt-1"><Input id="ai-api-key" className="pr-10 font-mono text-xs" type={revealKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={provider.apiKey} disabled={busy === 'save' || provider.authMode === 'none'} onChange={e => patchProvider({ apiKey: e.target.value })} placeholder={provider.authMode === 'none' ? '本地服务不发送认证头' : '粘贴服务商提供的密钥'} /><button type="button" aria-label={revealKey ? '隐藏密钥' : '显示密钥'} className="absolute inset-y-0 right-2 px-1 text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setRevealKey(v => !v)}>{revealKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">密钥在本机以当前 Windows 账户加密保存；请求直接发往你设置的接口。百炼官方地址会按地域查询官方模型目录；新加坡目录使用百炼新加坡公共域名。</p>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => void networkAction('discover')}><RefreshCw size={13} className={busy === 'discover' ? 'animate-spin' : ''} />{busy === 'discover' ? '正在获取模型…' : '连接并获取模型'}</Button>
                {(busy === 'discover' || busy === 'test') && <Button size="sm" variant="ghost" onClick={() => { cancel(); setStatus({ kind: 'info', text: '请求已取消，原模型列表保留。' }); }}>取消请求</Button>}
                {provider.lastFetchedAt && <span className="text-[11px] text-muted-foreground">上次获取 {new Date(provider.lastFetchedAt).toLocaleString()}</span>}
              </div>
              {status && <p role={status.kind === 'error' ? 'alert' : 'status'} className={`mt-3 break-words rounded-md border p-3 text-xs leading-relaxed ${status.kind === 'error' ? 'border-destructive/30 bg-destructive/5 text-destructive' : status.kind === 'success' ? 'border-primary/20 bg-primary/5 text-primary' : 'bg-muted/30 text-muted-foreground'}`}>{status.text}</p>}

              <div className="mt-6 border-t pt-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">模型库 <span className="ml-1 text-xs font-normal text-muted-foreground">{provider.models.length} 个</span></h3>
                  <div className="relative w-full max-w-[230px]"><Search size={13} className="absolute left-2.5 top-2.5 text-muted-foreground" /><Input className="h-8 pl-8 text-xs" aria-label="搜索模型" placeholder="搜索模型 ID 或名称" value={search} onChange={e => { setSearch(e.target.value); setLimit(30); }} /></div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">目录展示不代表当前账户已开通该模型，也不代表支持所有用途。对话测试只验证文字作答；实时语音请保存后在工作台测试。</p>
                <div className="mt-3 max-h-[280px] overflow-y-auto rounded-md border">
                  {!filtered.length && <p className="p-4 text-xs leading-relaxed text-muted-foreground">{search ? '没有匹配的模型。' : '还没有模型。获取接口模型列表，或在下方手动添加。'}</p>}
                  {filtered.slice(0, limit).map(model => <div key={model.id} className="flex items-center justify-between gap-2 border-b px-3 py-2 last:border-b-0">
                    <div className="min-w-0"><div className="truncate font-mono text-xs" title={model.id}>{model.id}</div><div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground"><span>{model.source === 'custom' ? '自定义' : '接口发现'}</span>{model.name !== model.id && <span className="truncate">{model.name}</span>}</div></div>
                    <div className="flex shrink-0 items-center"><Button size="sm" variant="ghost" disabled={!!busy || isSpeechRecognitionModel(model.id)} title={isRealtimeAsrModel(model.id) ? '实时语音模型：分配到语音转写、启用持续实时模式并保存后，在工作台开始收音验证字幕。' : isSpeechRecognitionModel(model.id) ? '语音识别模型不能进行文字对话测试。持续实时识别请选择已适配的 fun-asr-realtime。' : undefined} onClick={() => void networkAction('test', model.id)}>{isSpeechRecognitionModel(model.id) ? '语音专用' : busy === 'test' && testingId === model.id ? '测试中…' : '测试对话'}</Button><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`移除模型 ${model.id}`} disabled={!!busy} onClick={() => deleteModel(model.id)}><Trash2 size={12} /></Button></div>
                  </div>)}
                  {filtered.length > limit && <Button size="sm" variant="ghost" className="w-full" onClick={() => setLimit(v => v + 50)}>再显示 {Math.min(50, filtered.length - limit)} 个</Button>}
                </div>
                <p className="mt-2 text-[10px] text-muted-foreground">对话测试会发送一条短消息，服务商可能计费。语音识别模型不执行此测试。</p>
                {filtered.some(model => isSpeechRecognitionModel(model.id)) && <p className="mt-2 rounded-md border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">fun-asr、fun-asr-flash 是文件识别模型。持续实时识别请把 fun-asr-realtime 分配到「语音转写」，在「请求与语音选项」启用持续实时模式并保存，再到面试助手选择「模拟练习」开始收音、说话查看字幕。「测试麦克风」仅检查本地音量，不验证云端语音服务。</p>}
                <form className="mt-4 rounded-md bg-muted/35 p-3" onSubmit={e => { e.preventDefault(); addCustomModel(); }}>
                  <h4 className="text-xs font-medium">添加自定义模型</h4><p className="mt-1 text-[11px] text-muted-foreground">接口不提供模型列表，或列表中没有你的模型时，直接填写精确 ID。</p>
                  <div className="mt-3 grid gap-2 min-[1120px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input aria-label="自定义模型 ID" className="h-8 font-mono text-xs" placeholder="模型 ID（必填）" maxLength={256} value={customId} disabled={!!busy} onChange={e => setCustomId(e.target.value)} />
                    <Input aria-label="自定义模型显示名称" className="h-8 text-xs" placeholder="显示名称（可选）" maxLength={160} value={customName} disabled={!!busy} onChange={e => setCustomName(e.target.value)} />
                    <Button size="sm" type="submit" variant="outline" disabled={!!busy || !customId.trim()}><Plus size={13} />添加模型</Button>
                  </div>
                </form>
              </div>
            </>}
          </div>
        </div>
      </Card>

      <Card className="p-5">
        <SectionHeader title="按用途选择模型" desc="每项可使用不同的连接。添加到模型库后，在这里选择才会用于实际请求。" right={<Badge variant="outline">{assignedCount} / 4 已指定</Badge>} />
        <div className="divide-y">
          {AI_ROLES.map(role => <div key={role} className="grid items-center gap-2 py-3 min-[1120px]:grid-cols-[140px_minmax(0,1fr)]">
            <label htmlFor={`ai-route-${role}`}><span className="text-xs font-medium">{ROLE_LABELS[role]}</span><span className="mt-1 block text-[11px] leading-relaxed text-muted-foreground">{roleDescriptions[role]}</span></label>
            <Select id={`ai-route-${role}`} className="min-w-0 text-xs" value={draft.routes[role] ? JSON.stringify(draft.routes[role]) : ''} disabled={busy === 'save'} onChange={e => assignRoute(role,e.target.value)}>
              <option value="">{role === 'vision' ? '跟随对话模型（需支持图片输入）' : role === 'chat' ? '请选择作答模型' : role === 'tts' ? '系统默认语音（无需 API Key）' : '不启用'}</option>
              {draft.providers.map(p => <optgroup key={p.id} label={p.name}>{p.models.map(m => <option key={m.id} disabled={role==='stt'&&isUnsupportedBailianSpeechModel(p,m.id)} value={JSON.stringify({ providerId: p.id, modelId: m.id })}>{p.name} / {m.name === m.id ? m.id : `${m.name} · ${m.id}`}{role==='stt'&&isUnsupportedBailianSpeechModel(p,m.id)?'（文件识别接口未接入）':''}</option>)}</optgroup>)}
            </Select>
          </div>)}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 p-3 text-xs">
          <div className="min-w-0 flex-1"><p className="font-medium">面试官语音 · {draft.routes.tts ? '自定义语音服务' : '系统默认语音'}</p><p className="mt-1 text-muted-foreground">模拟面试窗口可用喇叭开关控制。自定义模型须支持 /audio/speech 接口；未配置时无需额外服务。</p></div>
          <Button size="sm" variant="outline" disabled={dirty || !!busy} onClick={() => voicePlaying ? voice.stop() : void voice.speak('你好，我是你的面试官。准备好后，我们开始。')}>{voicePlaying ? '停止试听' : '试听语音'}</Button>
          {dirty && <span className="text-muted-foreground">保存后可试听</span>}
        </div>
        {unsupportedSpeechSelected&&<div role="alert" data-testid="unsupported-speech-model" className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">当前语音转写选择了 {draft.routes.stt?.modelId}。本应用尚未接入此百炼文件识别接口，不能发送到 OpenAI 文件转写地址。请改用当前连接的实时模型并保存。<Button size="sm" variant="outline" className="mt-2" disabled={!!busy} onClick={useCurrentConnectionRealtime}>改用当前连接的实时识别</Button></div>}
        <details className="mt-3 border-t pt-3"><summary className="cursor-pointer text-xs font-medium text-muted-foreground">请求与语音选项</summary><div className="mt-3 grid grid-cols-2 gap-3">
          <label htmlFor="ai-speech-mode" className="col-span-2 text-xs">语音输入模式
            <Select id="ai-speech-mode" className="mt-1" value={realtimeSpeechSelected ? 'realtime' : draft.speechInputMode ?? 'auto'} disabled={busy === 'save'} onChange={e => setDraft(value => ({ ...value, speechInputMode: e.target.value as AiSettings['speechInputMode'] }))}>
              <option value="auto" disabled={realtimeSpeechSelected}>自动适配（按语音模型选择通道）</option>
              <option value="segmented" disabled={realtimeSpeechSelected}>分段实时字幕（约 2.5 秒一段）</option>
              <option value="realtime">持续实时音频（百炼 Fun-ASR / Paraformer）</option>
              <option value="file" disabled={realtimeSpeechSelected}>停顿后整句识别（减少请求）</option>
            </Select>
            <p className="mt-1 leading-relaxed text-muted-foreground">MiMo 支持音频文件输入和 SSE 输出。分段模式在说话时持续提交短音频，停顿后用整句校正；预览会增加转写用量。它与持续音频输入的 WebSocket ASR 不同。</p>
          </label>
          {(realtimeSpeechSelected || draft.speechInputMode === 'realtime') && <div className="col-span-2 space-y-2 rounded-md border p-3 text-xs">
            {realtimeSpeechSelected&&<p>当前模型需要持续实时音频，已自动选择正确通道。更换语音模型后可使用其他输入方式。</p>}
            <p>添加对应地域的百炼连接并填写同地域的 Key，将语音转写分配给 fun-asr-realtime。北京另支持 fun-asr-realtime-2026-02-28 和 paraformer-realtime-v2；新加坡请选择稳定版。已有连接可获取模型目录或手动添加模型 ID。持续连接可能按时长计费，暂停会断开连接。</p>
            <label className="block">实时 WSS 地址（留空自动匹配）<Input aria-label="实时 ASR WSS 地址" className="mt-1 font-mono text-xs" value={draft.realtimeEndpoint ?? ''} placeholder={automaticRealtimeEndpoint} onChange={event => setDraft(value => ({ ...value, realtimeEndpoint: event.target.value.trim() || undefined }))} /></label>
            <p className="break-all text-muted-foreground">自动地址：{automaticRealtimeEndpoint}。也可填写同地域的官方 WSS 地址；切换地域时清空旧地址，不要把 Key 放入 URL。</p>
            <label className="block">热词表 ID（可选）<Input aria-label="ASR 热词表 ID" className="mt-1" value={draft.realtimeVocabularyId ?? ''} placeholder="百炼已创建的 vocabulary_id" onChange={event => setDraft(value => ({ ...value, realtimeVocabularyId: event.target.value }))} /></label>
          </div>}
          <label htmlFor="ai-timeout" className="text-xs">请求超时（秒）<Input id="ai-timeout" className="mt-1" type="number" min={5} max={300} value={draft.timeoutMs / 1000} disabled={busy === 'save'} onChange={e => setDraft(value => ({ ...value, timeoutMs: Number(e.target.value) * 1000 }))} /></label>
          <label htmlFor="ai-tts-voice" className="text-xs">语音音色 ID<Input id="ai-tts-voice" className="mt-1" value={draft.ttsVoice} disabled={busy === 'save' || !draft.routes.tts} onChange={e => setDraft(value => ({ ...value, ttsVoice: e.target.value }))} /></label>
        </div></details>
      </Card>
      <ConfirmDialog open={removeId !== null} title="删除这个连接？" body="该连接的密钥、模型列表和用途分配会一起移除。保存配置后生效。" confirmText="删除连接" onCancel={() => setRemoveId(null)} onConfirm={() => {
        if (!removeId) return;
        const next = removeProvider(draft, removeId);
        setDraft(next); selectProvider(next.providers[0]?.id ?? ''); setRemoveId(null);
      }} />
    </div>
  );
}
