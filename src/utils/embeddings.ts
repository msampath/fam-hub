// Local, offline embeddings for semantic retrieval (the RAG upgrade over keyword matching). Uses Ollama's
// `nomic-embed-text` (no quota, no cloud) when reachable; callers fall back to keyword retrieval when it
// isn't. The cosine math is pure + unit-tested; the fetch is best-effort and never throws to the caller.

const EMBED_URL = process.env.LOCAL_LLM_URL || 'http://localhost:11434';
const EMBED_MODEL = process.env.RAG_EMBED_MODEL || 'nomic-embed-text';
// Embeddings are opt-in: keyword retrieval is the default until the owner pulls the model + enables this.
export const embeddingsEnabled = (): boolean => process.env.RAG_EMBEDDINGS_ENABLED === 'true';

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || a.length !== b?.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Embed one string via Ollama. Returns null on any failure (model not pulled, server down, bad shape) so
// the caller transparently falls back to keyword retrieval. `fetchImpl` is injectable for tests.
export async function embedViaOllama(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number[] | null> {
  try {
    const res = await fetchImpl(`${EMBED_URL.replace(/\/+$/, '')}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text || '').slice(0, 8000) }),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const v = data?.embedding;
    return Array.isArray(v) && v.length && v.every((n: any) => typeof n === 'number') ? v : null;
  } catch {
    return null;
  }
}
