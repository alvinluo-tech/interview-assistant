/**
 * Semantic retrieval through the configured provider's /embeddings endpoint.
 * Everything here is optional: no embedding model or a failing endpoint simply
 * returns null and the caller keeps its lexical ranking.
 */
import { getAiSettings } from './aiSettings';
import { aiFetch } from './aiTransport';
import { aiHeaders, withAiRequest } from './aiProtocol';
import type { AiProvider } from './aiConfig';

/** Providers cap batch size differently; batching keeps requests small and predictable. */
export const EMBED_BATCH = 16;
const CACHE_LIMIT = 600;
const SIMILARITY_FLOOR = 0.32;
const cache = new Map<string, Float64Array>();

export interface SemanticHit { id: string; score: number }

function route(): { provider: AiProvider; modelId: string; timeoutMs: number } | null {
  const settings = getAiSettings();
  const modelId = settings.embeddingModel?.trim();
  const chat = settings.routes.chat;
  if (!modelId || !chat) return null;
  const provider = settings.providers.find(item => item.id === chat.providerId);
  return provider ? { provider, modelId, timeoutMs: settings.timeoutMs } : null;
}

export function embeddingsReady(): boolean {
  return route() !== null;
}

export function resetEmbeddingCache(): void {
  cache.clear();
}

function remember(key: string, vector: Float64Array): void {
  cache.delete(key);
  cache.set(key, vector);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Requests vectors for a batch; returns null when the provider cannot serve them. */
async function embedBatch(provider: AiProvider, modelId: string, timeoutMs: number, texts: string[], signal?: AbortSignal): Promise<Float64Array[] | null> {
  const payload: unknown = await withAiRequest(provider, 'embeddings', {
    method: 'POST', headers: aiHeaders(provider, true), body: JSON.stringify({ model: modelId, input: texts, encoding_format: 'float' }),
  }, timeoutMs, response => response.json(), aiFetch, signal);
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data) || data.length !== texts.length) return null;
  const vectors: Float64Array[] = [];
  let size = 0;
  for (const item of data) {
    const embedding = (item as { embedding?: unknown })?.embedding;
    if (!Array.isArray(embedding) || !embedding.length) return null;
    const vector = Float64Array.from(embedding as number[], value => Number.isFinite(value) ? value : 0);
    if (!vector.some(value => value !== 0)) return null;
    if (!size) size = vector.length;
    else if (vector.length !== size) return null;
    vectors.push(vector);
  }
  return vectors;
}

async function embedTexts(texts: string[], signal?: AbortSignal): Promise<Float64Array[] | null> {
  const target = route();
  if (!target) return null;
  const missing = texts.filter(text => !cache.has(`${target.modelId}\u0000${text}`));
  const unique = [...new Set(missing)];
  for (let start = 0; start < unique.length; start += EMBED_BATCH) {
    const batch = unique.slice(start, start + EMBED_BATCH);
    const vectors = await embedBatch(target.provider, target.modelId, target.timeoutMs, batch, signal);
    if (!vectors) return null;
    batch.forEach((text, index) => remember(`${target.modelId}\u0000${text}`, vectors[index]));
  }
  return texts.map(text => cache.get(`${target.modelId}\u0000${text}`) ?? null)
    .filter((vector): vector is Float64Array => vector !== null);
}

export function cosine(a: Float64Array, b: Float64Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, left = 0, right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    left += a[index] * a[index];
    right += b[index] * b[index];
  }
  if (!left || !right) return 0;
  return dot / Math.sqrt(left * right);
}

/**
 * Ranks chunks against one query. Returns null whenever the feature is off or
 * the provider fails, so callers never have to distinguish "off" from "empty".
 */
export async function rankChunks(query: string, chunks: { id: string; text: string }[], signal?: AbortSignal): Promise<Map<string, number> | null> {
  const question = query.trim().slice(0, 2000);
  if (!question || !chunks.length) return null;
  try {
    const texts = [question, ...chunks.map(chunk => chunk.text.slice(0, 2000))];
    const vectors = await embedTexts(texts, signal);
    if (!vectors || vectors.length !== texts.length) return null;
    const [queryVector, ...chunkVectors] = vectors;
    const ranking = new Map<string, number>();
    chunks.forEach((chunk, index) => {
      const score = cosine(queryVector, chunkVectors[index]);
      if (score >= SIMILARITY_FLOOR) ranking.set(chunk.id, score);
    });
    return ranking;
  } catch {
    return null;
  }
}
