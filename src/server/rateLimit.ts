export function checkRateWindow(
  entry: { count: number; resetAt: number } | undefined,
  now: number, max: number, windowMs: number,
): { allowed: boolean; entry: { count: number; resetAt: number } } {
  if (!entry || now >= entry.resetAt) return { allowed: true, entry: { count: 1, resetAt: now + windowMs } };
  if (entry.count >= max) return { allowed: false, entry };
  return { allowed: true, entry: { count: entry.count + 1, resetAt: entry.resetAt } };
}

let _lastPrune = 0;
const PRUNE_INTERVAL_MS = 60_000;
export function pruneExpired(map: Map<string, { count: number; resetAt: number }>, now: number): void {
  if (map.size < 256 || now - _lastPrune < PRUNE_INTERVAL_MS) return;
  _lastPrune = now;
  for (const [k, v] of map) if (now >= v.resetAt) map.delete(k);
}
export function resetPruneTimer(): void { _lastPrune = 0; }
