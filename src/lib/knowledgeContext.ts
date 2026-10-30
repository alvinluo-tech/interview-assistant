/** Local retrieval: short personal background stays whole; optional references must be relevant. */
export interface ContextSource {
    id: string;
    documentId?: string;
    title: string;
    kind: 'resume' | 'job' | 'material';
    excerpt: string;
    location: string;
    selection?: 'background' | 'retrieved';
    origin?: string;
}
export interface ContextResume {
    id: string;
    title: string;
    content?: string;
    summary?: string;
}
export interface ContextGoal {
    id: string;
    name: string;
    companyName?: string;
    description?: string;
}
export interface ContextMaterial {
    id: string;
    name: string;
    content: string;
    source?: string;
    entries: {
        id?: string;
        question: string;
        answer: string;
        origin?: string;
    }[];
}
export interface KnowledgeInput {
    resume?: ContextResume;
    goal?: ContextGoal;
    materials?: ContextMaterial[];
    query?: string;
    maxChars?: number;
}
export interface KnowledgeSnapshot {
    version: 1;
    capturedAt: number;
    resume?: ContextResume;
    goal?: ContextGoal;
    materials: ContextMaterial[];
}
export interface KnowledgeContext {
    text: string;
    sources: ContextSource[];
    totalChunks: number;
    truncated: boolean;
}
export function captureKnowledge(input: KnowledgeInput): KnowledgeSnapshot {
    return JSON.parse(JSON.stringify({ version: 1, capturedAt: Date.now(), resume: input.resume, goal: input.goal, materials: input.materials || [] }));
}
/** Deletion or deselection revokes access; editing retains the session's chosen document version. */
export function authorizedKnowledge(snapshot: KnowledgeSnapshot, current: KnowledgeInput): KnowledgeInput {
    const allowed = new Set((current.materials || []).map(material => material.id));
    return { resume: current.resume?.id === snapshot.resume?.id ? snapshot.resume : undefined,
        goal: current.goal?.id === snapshot.goal?.id ? snapshot.goal : undefined, materials: snapshot.materials.filter(material => allowed.has(material.id)) };
}
function terms(value: string): string[] {
    const tokens = new Set(value.toLowerCase().match(/[a-z0-9_+#.-]+/g) || []);
    for (const phrase of value.match(/[\u3400-\u9fff]+/g) || [])
        for (let i = 0; i < phrase.length - 1; i++)
            tokens.add(phrase.slice(i, i + 2));
    return [...tokens];
}
export function buildKnowledgeContext(input: KnowledgeInput): KnowledgeContext {
    const budget = Math.max(0, Math.min(24000, Math.floor(input.maxChars ?? 12000)));
    const documents: {
        id: string;
        documentId: string;
        title: string;
        kind: ContextSource['kind'];
        text: string;
        origin?: string;
    }[] = [];
    if (input.goal)
        documents.push({ id: 'J', documentId: input.goal.id, title: `岗位：${input.goal.name}${input.goal.companyName ? ` / ${input.goal.companyName}` : ''}`, kind: 'job', text: input.goal.description || input.goal.name });
    if (input.resume)
        documents.push({ id: 'R', documentId: input.resume.id, title: `简历：${input.resume.title}`, kind: 'resume', text: input.resume.content || input.resume.summary || '' });
    for (const material of input.materials || []) {
        const source = { documentId: material.id, kind: 'material' as const };
        if (material.content)
            documents.push({ ...source, id: `M:${material.id}:body:`, title: `资料：${material.name} / 正文`, text: material.content,
                origin: material.source === 'ai' ? 'model_generated' : material.source || 'legacy_unknown' });
        material.entries.forEach((entry, index) => documents.push({ ...source, id: `M:${material.id}:entry:${entry.id || index}:`, title: `资料：${material.name} / 问答 ${index + 1}`,
            origin: entry.origin || 'legacy_unknown', text: `问题：${entry.question}\n回答：${entry.answer}` }));
    }
    const query = terms(input.query || input.goal?.description || input.goal?.name || '');
    const candidates: (ContextSource & {
        score: number;
    })[] = [];
    for (const document of documents) {
        const text = document.text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
        const shortBackground = document.kind !== 'material' && text.length <= 3500;
        for (let start = 0, count = 0; start < text.length && count < 256; count++) {
            let end = shortBackground ? text.length : Math.min(text.length, start + 1100);
            if (end < text.length) {
                const boundary = text.lastIndexOf('\n\n', end);
                if (boundary > start + 300)
                    end = boundary;
            }
            const excerpt = text.slice(start, end), normalized = excerpt.toLowerCase();
            const score = query.reduce((sum, term) => sum + (normalized.includes(term) ? Math.min(4, term.length) : 0), 0);
            const background = shortBackground;
            candidates.push({ id: `${document.id}${count + 1}`, documentId: document.documentId, title: document.title, kind: document.kind, excerpt, origin: document.origin,
                location: `正文第 ${start + 1}–${end} 字`, selection: background ? 'background' : 'retrieved', score });
            if (end === text.length)
                break;
            start = Math.max(start + 1, end - 80);
        }
    }
    const selected = candidates.filter(candidate => candidate.selection === 'background' || candidate.score > 0)
        .sort((a, b) => Number(b.selection === 'background') - Number(a.selection === 'background') || b.score - a.score);
    const sources: ContextSource[] = [], blocks: string[] = [];
    let used = 0, shortened = false;
    for (const candidate of selected) {
        const provenance = candidate.origin === 'model_generated' ? ' · AI 生成参考建议，非已确认个人经历' : candidate.origin === 'legacy_unknown' ? ' · 旧资料，来源未逐条确认' : '';
        let location = candidate.location;
        let header = `【${candidate.id} · ${candidate.title} · ${location}${provenance}】\n`;
        const available = budget - used - header.length - (blocks.length ? 2 : 0);
        if (available < 50)
            continue;
        let excerpt = candidate.excerpt;
        if (excerpt.length > available) {
            const first = query.map(term => excerpt.toLowerCase().indexOf(term)).filter(index => index >= 0).sort((a, b) => a - b)[0] ?? 0;
            const start = Math.max(0, first - Math.floor(available / 3));
            excerpt = excerpt.slice(start, start + available);
            shortened = true;
            const originalStart = Number(/第 (\d+)/.exec(candidate.location)?.[1] || 1);
            for (let adjust = 0; adjust < 3; adjust++) {
                location = `正文第 ${originalStart + start}–${originalStart + start + excerpt.length - 1} 字`;
                header = `【${candidate.id} · ${candidate.title} · ${location}${provenance}】\n`;
                const allowed = Math.max(0, budget - used - header.length - (blocks.length ? 2 : 0));
                if (excerpt.length <= allowed)
                    break;
                excerpt = excerpt.slice(0, allowed);
            }
        }
        if (sources.some(source => source.documentId === candidate.documentId && source.excerpt === excerpt))
            continue;
        blocks.push(header + excerpt);
        used += header.length + excerpt.length + (blocks.length > 1 ? 2 : 0);
        const { score: _score, ...source } = candidate;
        sources.push({ ...source, excerpt, location });
    }
    return { text: blocks.join('\n\n'), sources, totalChunks: candidates.length, truncated: shortened || sources.length < selected.length };
}
