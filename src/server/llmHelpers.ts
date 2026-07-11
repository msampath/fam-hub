export function parseGeminiJSON(text: string): any {
  let cleaned = (text || '').trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const objStart = cleaned.indexOf('{'), objEnd = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('['), arrEnd = cleaned.lastIndexOf(']');
    const useArr = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const start = useArr ? arrStart : objStart;
    const end = useArr ? arrEnd : objEnd;
    if (start !== -1 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* fall through to malformed */ }
    }
    console.error('Failed to parse Gemini JSON:', cleaned);
    const e: any = new Error('The AI response structure was unexpectedly formatted. Please try again.');
    e.malformedResponse = true;
    throw e;
  }
}

export function repairTruncatedJson(raw: string): any | null {
  if (typeof raw !== 'string') return null;
  const objStart = raw.indexOf('{');
  const arrStart = raw.indexOf('[');
  const start = arrStart !== -1 && (objStart === -1 || arrStart < objStart) ? arrStart : objStart;
  if (start < 0) return null;
  let s = raw.slice(start);
  let inStr = false, esc = false;
  const closers: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') closers.push('}');
    else if (c === '[') closers.push(']');
    else if (c === '}' || c === ']') closers.pop();
  }
  if (inStr) s += '"';
  s = s.replace(/[,\s]*$/, '');
  while (closers.length) s += closers.pop();
  try { return JSON.parse(s); } catch { /* fall through to reply-only salvage */ }
  const m = raw.match(/"reply"\s*:\s*("(?:[^"\\]|\\.)*")/);
  if (m) { try { return { reply: JSON.parse(m[1]), suggestions: [], actions: [] }; } catch { /* unparseable */ } }
  return null;
}

export function isTextOnlyContents(contents: any): boolean {
  if (typeof contents === 'string') return true;
  const parts = Array.isArray(contents?.parts) ? contents.parts : Array.isArray(contents) ? contents : null;
  if (!parts) return false;
  return parts.every((p: any) => typeof p === 'string' || (p && typeof p.text === 'string' && !p.inlineData && !p.fileData));
}

export function contentsToText(contents: any): string {
  if (typeof contents === 'string') return contents;
  const parts = Array.isArray(contents?.parts) ? contents.parts : Array.isArray(contents) ? contents : [];
  return parts.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).filter(Boolean).join('\n');
}

export function isTransientError(err: any): boolean {
  const code = err?.status ?? err?.code;
  if (typeof code === 'number' && [429, 500, 503].includes(code)) return true;
  const msg = String(err?.message || err || '').toUpperCase();
  return /\b(429|500|503)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|INTERNAL|OVERLOADED|ECONNRESET|ETIMEDOUT|FETCH FAILED|ABORT/.test(msg);
}

export function isRecoverableError(err: any): boolean {
  return isTransientError(err) || !!err?.malformedResponse;
}

export function orderFallbackModels(names: string[]): string[] {
  const rank = (n: string) => {
    const s = n.toLowerCase();
    if (s.includes('flash-lite') || s.includes('lite')) return 0;
    if (s.includes('flash')) return 1;
    if (s.includes('pro')) return 3;
    return 2;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

const NON_TEXT_MODEL_RE = /imag|tts|audio|music|embedding|veo|learnlm|vision|aqa/i;

export function isLikelyTextModel(name: string): boolean {
  return !!name && !NON_TEXT_MODEL_RE.test(name);
}

export function resolveFallbackChain(manual: string[], discovered: string[], primary: string): string[] {
  const chain = manual.length ? manual : discovered;
  return chain.filter(m => m && m !== primary);
}

const LOCAL_TOKEN_RE = /^(local|ollama)$/i;
export function isLocalToken(s: string): boolean {
  return LOCAL_TOKEN_RE.test(String(s || '').trim());
}

export function buildAttemptChain(primary: string, fallbacks: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]) {
    const id = String(m || '').trim();
    if (!id) continue;
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}
