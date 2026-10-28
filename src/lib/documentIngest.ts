export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_MAX_CHARS = 150000;
export const DOCUMENT_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.txt,.md';
export interface ImportedDocument { name: string; text: string; pages: number; method: 'text' | 'pdf' | 'vision' | 'mixed'; importedAt: number }
export interface PdfPage { text: string; render: () => Promise<string> }
export interface DocumentServices {
  openPdf(data: Uint8Array, signal?: AbortSignal): Promise<{ pageCount: number; getPage(number: number): Promise<PdfPage>; close(): Promise<void> }>;
  recognizeImage(image: string, signal?: AbortSignal): Promise<string>;
  readImage?(file: DocumentFile, signal?: AbortSignal): Promise<string>;
}
export interface DocumentFile { name: string; type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface ImportOptions { allowVision?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void }
export class DocumentImportError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'DocumentImportError'; }
}
function checkSignal(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('导入已取消', 'AbortError'); }
function visionConsent(options: ImportOptions, pages: number) {
  if (!options.allowVision) throw new DocumentImportError('VISION_CONSENT_REQUIRED', `有 ${pages} 页图片或扫描内容需要发送给你配置的视觉模型识别，确认后才会发送。`);
}
function clean(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim(); }
function requireText(text: string) {
  if (!text.trim()) throw new DocumentImportError('EMPTY_DOCUMENT', '没有提取到正文，请检查文件、重新扫描，或粘贴文本。');
  if (text.length > DOCUMENT_MAX_CHARS) throw new DocumentImportError('TOO_MUCH_TEXT', '正文超过 15 万字，请拆分文件后导入。');
}

export async function parseDocument(file: DocumentFile, options: ImportOptions, services: DocumentServices): Promise<ImportedDocument> {
  checkSignal(options.signal);
  if (!file.size || file.size > DOCUMENT_MAX_BYTES) throw new DocumentImportError('FILE_SIZE', '请选择非空且不超过 20MB 的文件。');
  const extension = file.name.split('.').pop()?.toLowerCase();
  const result = (text: string, pages: number, method: ImportedDocument['method']) => {
    checkSignal(options.signal); requireText(text);
    return { name: file.name, text, pages, method, importedAt: Date.now() };
  };
  if (extension === 'txt' || extension === 'md') {
    const data = new Uint8Array(await file.arrayBuffer());
    checkSignal(options.signal);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new DocumentImportError('TEXT_ENCODING', '文本不是 UTF-8 编码，请另存为 UTF-8 后重试。'); }
    if (text.startsWith('%PDF-')) throw new DocumentImportError('WRONG_TYPE', '文件内容是 PDF，请使用正确的 .pdf 扩展名。');
    return result(clean(text), 1, 'text');
  }
  if (['jpg', 'jpeg', 'png', 'webp'].includes(extension || '')) {
    visionConsent(options, 1);
    if (!services.readImage) throw new DocumentImportError('IMAGE_UNAVAILABLE', '当前环境无法读取图片。');
    options.onProgress?.('正在识别图片正文…');
    const image = await services.readImage(file, options.signal);
    checkSignal(options.signal);
    return result(clean(await services.recognizeImage(image, options.signal)), 1, 'vision');
  }
  if (extension !== 'pdf') throw new DocumentImportError('UNSUPPORTED_TYPE', '仅支持 PDF、PNG/JPEG/WebP、TXT 和 Markdown。');
  const data = new Uint8Array(await file.arrayBuffer());
  checkSignal(options.signal);
  if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-') throw new DocumentImportError('INVALID_PDF', '文件不是有效的 PDF。');
  options.onProgress?.('正在本地解析 PDF…');
  const pdf = await services.openPdf(data, options.signal);
  try {
    if (pdf.pageCount > 30) throw new DocumentImportError('TOO_MANY_PAGES', 'PDF 超过 30 页，请按章节拆分后导入。');
    const pages: PdfPage[] = [];
    for (let number = 1; number <= pdf.pageCount; number++) {
      checkSignal(options.signal);
      options.onProgress?.(`正在本地解析第 ${number}/${pdf.pageCount} 页…`);
      pages.push(await pdf.getPage(number));
    }
    const scans = pages.filter(page => clean(page.text).length < 12).length;
    if (scans > 10) throw new DocumentImportError('TOO_MANY_SCANS', '扫描页超过 10 页，请拆分后导入，避免过多视觉请求。');
    if (scans) visionConsent(options, scans);
    const output: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      checkSignal(options.signal);
      let text = clean(pages[i].text);
      if (text.length < 12) {
        options.onProgress?.(`正在识别扫描页 ${i + 1}/${pdf.pageCount}…`);
        const image = await pages[i].render();
        checkSignal(options.signal);
        text = clean(await services.recognizeImage(image, options.signal));
      }
      if (!text) throw new DocumentImportError('EMPTY_PAGE', `第 ${i + 1} 页未能识别出正文，请检查后重试。`);
      output.push(`【第 ${i + 1} 页】\n${text}`);
      requireText(output.join('\n\n'));
    }
    return result(output.join('\n\n'), pdf.pageCount, scans ? scans === pages.length ? 'vision' : 'mixed' : 'pdf');
  } finally { await pdf.close(); }
}
