// Small fetch wrapper with an abort timeout, shared across Kroger, Open-Meteo, Places, and email-scan calls.
export async function fetchWithTimeout(url: string, timeoutMs = 8000, init?: any) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Drop entries older than their TTL so a multi-household server can't accumulate grounding cache entries
// forever. No-op below the small floor, so the single-household path (a handful of keys) pays nothing.
export function pruneByAge<V extends { at: number }>(map: Map<string, V>, ttlMs: number, now: number): void {
  if (map.size < 256) return;
  for (const [k, v] of map) if (now - v.at >= ttlMs) map.delete(k);
}
