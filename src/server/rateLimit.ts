export function checkRateWindow(
  entry: { count: number; resetAt: number } | undefined,
  now: number, max: number, windowMs: number,
): { allowed: boolean; entry: { count: number; resetAt: number } } {
  if (!entry || now >= entry.resetAt) return { allowed: true, entry: { count: 1, resetAt: now + windowMs } };
  if (entry.count >= max) return { allowed: false, entry };
  return { allowed: true, entry: { count: entry.count + 1, resetAt: entry.resetAt } };
}

// Keyed by the Map INSTANCE (there are ~5 independent rate-limit maps: preAuthHits, aiRateHits,
// stepUpHits, stepUpSetHits, dataFetchHits) — a single shared timestamp would let whichever map
// prunes first "use up" the interval for every other map too, starving their eviction.
const _lastPrune = new WeakMap<Map<string, { count: number; resetAt: number }>, number>();
const PRUNE_INTERVAL_MS = 60_000;
export function pruneExpired(map: Map<string, { count: number; resetAt: number }>, now: number): void {
  if (map.size < 256 || now - (_lastPrune.get(map) ?? 0) < PRUNE_INTERVAL_MS) return;
  _lastPrune.set(map, now);
  for (const [k, v] of map) if (now >= v.resetAt) map.delete(k);
}
export function resetPruneTimer(): void {
  // WeakMap has no .clear() — but every production map is a module-level singleton passed in fresh by
  // tests, so a never-seen Map instance already reads as "never pruned" (the ?? 0 default above). This
  // no-op-looking function is kept only so existing call sites don't need to change.
}
