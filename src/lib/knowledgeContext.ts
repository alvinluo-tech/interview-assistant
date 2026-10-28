/** Local, bounded retrieval over the user's selected documents. No external index is required. */
export interface ContextSource { id: string; title: string; kind: 'resume' | 'job' | 'material'; excerpt: string; location: string }
interface ContextResume { id: string; title: string; content?: string; summary?: string }
interface ContextGoal { id: string; name: string; companyName?: string; description?: string }
interface ContextMaterial { id: string; name: string; content: string; entries: { question: string; answer: string }[] }
export interface KnowledgeContext { text: string; sources: ContextSource[]; totalChunks: number; truncated: boolean }

function terms(value: string): string[] {
  const result = new Set(value.toLowerCase().match(/[a-z0-9_+#.-]{2,}/g) ?? []);
  for (const phrase of value.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (phrase.length === 1) continue;
    for (let i = 0; i < phrase.length - 1; i++) result.add(phrase.slice(i, i + 2));
  }
  return [...result];
}

export function buildKnowledgeContext(input: { resume?: ContextResume; goal?: ContextGoal; materials?: ContextMaterial[]; query?: string; maxChars?: number }): KnowledgeContext {
  const budget = Math.max(0, Math.min(24000, Math.floor(input.maxChars ?? 18000)));
  const documents: { id: string; title: string; kind: ContextSource['kind']; text: string }[] = [];
  if (input.goal) documents.push({ id: 'J', title: `岗位：${input.goal.name}${input.goal.companyName ? ` / ${input.goal.companyName}` : ''}`, kind: 'job', text: input.goal.description || input.goal.name });
  if (input.resume) documents.push({ id: 'R', title: `简历：${input.resume.title}`, kind: 'resume', text: input.resume.content || input.resume.summary || '' });
  (input.materials ?? []).forEach((material, i) => documents.push({ id: `M${i + 1}-`, title: `资料：${material.name}`, kind: 'material',
    text: [material.content, ...material.entries.map(entry => `问题：${entry.question}\n回答：${entry.answer}`)].join('\n\n') }));
  const query = terms(input.query || input.goal?.description || input.goal?.name || '');
  const groups = documents.map(document => {
    const text = document.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
    const chunks: (ContextSource & { score: number })[] = [];
    for (let start = 0; start < text.length && chunks.length < 256; start += 1000) {
      const excerpt = text.slice(start, start + 1100);
      const normalized = excerpt.toLowerCase();
      const score = query.reduce((sum, term) => sum + (normalized.includes(term) ? Math.min(4, term.length) : 0), 0);
      chunks.push({ id: `${document.id}${chunks.length + 1}`, title: document.title, kind: document.kind, excerpt,
        location: `正文第 ${start + 1}–${Math.min(text.length, start + 1100)} 字`, score });
      if (start + 1100 >= text.length) break;
    }
    return chunks.sort((a, b) => b.score - a.score);
  });
  const ordered = [...groups.flatMap(group => group.slice(0, 1)), ...groups.flatMap(group => group.slice(1)).sort((a, b) => b.score - a.score)];
  const sources: ContextSource[] = [];
  const blocks: string[] = [];
  let used = 0;
  let shortened = false;
  for (const candidate of ordered) {
    const header = `【${candidate.id} · ${candidate.title} · ${candidate.location}】\n`;
    const available = budget - used - header.length - (blocks.length ? 2 : 0);
    if (available < 50) continue;
    const excerpt = candidate.excerpt.slice(0, available);
    shortened ||= excerpt.length < candidate.excerpt.length;
    blocks.push(header + excerpt);
    used += header.length + excerpt.length + (blocks.length > 1 ? 2 : 0);
    const { score: _score, ...source } = candidate;
    sources.push({ ...source, excerpt });
  }
  return { text: blocks.join('\n\n'), sources, totalChunks: ordered.length, truncated: sources.length < ordered.length || shortened };
}
