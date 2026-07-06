// Photos screensaver selection (W6): date-window WEIGHTED picks over the local photo corpus — the
// owner's chosen memory mix: RECENT (last 90 days) shows most, plus "this time N years ago" windows
// (1–5 years back, ±30 days around today's date) for the anniversary feel; everything else still
// appears, just less often. Pure + deterministic with an injected rand — the shuffle logic is what
// makes or breaks the wall-tablet feel, so it's tested, not vibes.
export interface PhotoMeta { name: string; createTime: string } // ISO date-time (file mtime or a sidecar's real createTime)

const DAY_MS = 86400000;

export const RECENT_WINDOW_DAYS = 90;
export const ANNIVERSARY_YEARS = [1, 2, 3, 4, 5];
export const ANNIVERSARY_SPREAD_DAYS = 30;
const WEIGHT_RECENT = 3;       // last 90 days — the default stream
const WEIGHT_ANNIVERSARY = 2;  // "this week, N years ago"
const WEIGHT_OTHER = 1;        // the long tail still surfaces

export function photoWeight(createTime: string, nowISO: string): number {
  const t = Date.parse(createTime);
  const now = Date.parse(nowISO);
  if (!Number.isFinite(t) || !Number.isFinite(now)) return WEIGHT_OTHER;
  const ageDays = (now - t) / DAY_MS;
  if (ageDays >= 0 && ageDays <= RECENT_WINDOW_DAYS) return WEIGHT_RECENT;
  for (const y of ANNIVERSARY_YEARS) {
    const anchor = new Date(now);
    anchor.setFullYear(anchor.getFullYear() - y);
    if (Math.abs(t - anchor.getTime()) <= ANNIVERSARY_SPREAD_DAYS * DAY_MS) return WEIGHT_ANNIVERSARY;
  }
  return WEIGHT_OTHER;
}

/**
 * Build a weighted playback ORDER over the corpus: every photo appears exactly once per cycle
 * (no photo starves), but heavier-weighted photos surface earlier on average. Weighted sampling
 * WITHOUT replacement, deterministic under the injected rand.
 */
export function buildPhotoOrder(photos: PhotoMeta[], nowISO: string, rand: () => number = Math.random): PhotoMeta[] {
  const pool = (photos || []).filter(p => p && p.name).map(p => ({ p, w: photoWeight(p.createTime, nowISO) }));
  const out: PhotoMeta[] = [];
  while (pool.length) {
    const total = pool.reduce((s, e) => s + e.w, 0);
    let roll = rand() * total;
    let idx = 0;
    for (; idx < pool.length - 1; idx++) {
      roll -= pool[idx].w;
      if (roll <= 0) break;
    }
    out.push(pool[idx].p);
    pool.splice(idx, 1);
  }
  return out;
}
