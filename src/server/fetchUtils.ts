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

// Bounded-concurrency map: runs `fn` over `items` with at most `limit` in flight at once, preserving
// input order in the result array (a slot's result lands at its own index regardless of finish order).
// Used to replace a strictly-serial `for...of await` loop (Gmail message hydration, Kroger product
// match) with parallel fetches, without unboundedly firing all of them at once (respects per-user API
// quotas — Gmail, Kroger — better than an uncapped Promise.all over the whole list).
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Drop entries older than their TTL so a multi-household server can't accumulate grounding cache entries
// forever. No-op below the small floor, so the single-household path (a handful of keys) pays nothing.
export function pruneByAge<V extends { at: number }>(map: Map<string, V>, ttlMs: number, now: number): void {
  if (map.size < 256) return;
  for (const [k, v] of map) if (now - v.at >= ttlMs) map.delete(k);
}
