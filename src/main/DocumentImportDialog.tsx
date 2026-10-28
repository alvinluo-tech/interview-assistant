import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogTitle, Textarea } from '@/ui/primitives';
import { importDocument } from '@/lib/documentImport';
import { DocumentImportError, DOCUMENT_MAX_CHARS, type ImportedDocument } from '@/lib/documentIngest';
import { useAiReady, useAiSettings } from '@/lib/aiSettings';

export function DocumentImportDialog({ file, initial, title = '检查文档正文', onClose, onSave }: {
  file?: File; initial?: ImportedDocument; title?: string; onClose(): void; onSave(document: ImportedDocument): Promise<void>;
}) {
  const [document, setDocument] = useState<ImportedDocument | undefined>(initial);
  const [text, setText] = useState(initial?.text || '');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [needsVision, setNeedsVision] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const visionReady = useAiReady('vision');
  const ai = useAiSettings();
  const vision = ai.providers.find(provider => provider.id === ai.routes.vision?.providerId);

  async function read(allowVision = false) {
    if (!file) return;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setReading(true); setError(''); setNeedsVision(false); setProgress('正在读取文件…');
    try {
      const result = await importDocument(file, { allowVision, signal: request.signal,
        onProgress: message => { if (!request.signal.aborted) setProgress(message); } });
      if (request.signal.aborted) return;
      setDocument(result); setText(result.text);
    } catch (failure) {
      if (request.signal.aborted) return;
      setNeedsVision(failure instanceof DocumentImportError && failure.code === 'VISION_CONSENT_REQUIRED');
      setError(String((failure as Error).message || failure));
    } finally { if (!request.signal.aborted) { setReading(false); setProgress(''); } }
  }
  useEffect(() => { if (file) void read(); return () => controller.current?.abort(); }, [file]);

  return <Dialog open onClose={onClose} dismissable={!saving} className="max-w-2xl">
    <DialogTitle>{title}</DialogTitle>
    <p className="mb-3 text-xs text-muted-foreground">{file?.name || document?.name} · 文本 PDF 在本地解析；图片或扫描页需经确认后发送至你配置的视觉服务。原始文件不随正文保存。</p>
    {reading && <p role="status" className="my-3 text-sm">{progress}</p>}
    {error && <p role="alert" className="my-3 rounded border border-amber-500/40 p-3 text-sm">{error}</p>}
    {needsVision && <div className="mb-3 space-y-2 text-xs">
      <p>{visionReady ? `将发送至「${vision?.name}」的 ${ai.routes.vision?.modelId}，可能产生服务调用费用。` : '请先到「设置 → AI 服务」配置支持图片输入的视觉模型，再回来重试。'}</p>
      <Button size="sm" disabled={!visionReady || reading} onClick={() => void read(true)}>确认发送图片/扫描页并识别</Button>
    </div>}
    {document && <>
      <div className="mb-2 text-xs text-muted-foreground">{document.pages} 页 · {text.length.toLocaleString()} 字 · 请检查数字、姓名和项目经历；可直接修改正文。</div>
      <Textarea aria-label="文档正文" rows={15} maxLength={DOCUMENT_MAX_CHARS} value={text} disabled={reading || saving} onChange={event => setText(event.target.value)} />
    </>}
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="outline" disabled={saving} onClick={onClose}>取消</Button>
      <Button disabled={!document || reading || saving || !text.trim()} onClick={async () => {
        if (!document || !text.trim()) return;
        setSaving(true); setError('');
        try { await onSave({ ...document, text: text.trim() }); onClose(); }
        catch (failure) { setError(`保存失败：${String((failure as Error).message || failure)}`); }
        finally { setSaving(false); }
      }}>{saving ? '正在保存…' : '确认正文并保存'}</Button>
    </div>
  </Dialog>;
}
