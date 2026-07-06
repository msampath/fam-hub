// Weak-model guard for the calendar-extraction endpoints (/api/parse-url | parse-pdf | parse-text).
// The schema ASKS for ISO dates, but a weak local model can still emit "next Tuesday", "2119-09-31",
// or a date years away — and an invalid import is worse than a smaller one (Phase-3 treatment:
// validator tightening, no critic pass). Pure + tested; server.ts wraps each endpoint's results.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(T(\d{2}):(\d{2}))?/;

// Real calendar date (round-trip check kills 2026-02-31) with an optional valid HH:mm.
function parseISO(s: string): { y: number; m: number; d: number } | null {
  const m = ISO_DATE.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (m[4] && (Number(m[5]) > 23 || Number(m[6]) > 59)) return null;
  return { y, m: mo, d };
}

const dayNumber = (s: string): number | null => {
  const p = parseISO(s);
  return p ? Date.UTC(p.y, p.m - 1, p.d) / 86400000 : null;
};

export const EXTRACTION_WINDOW_DAYS = 366; // ±1 year around today — school years + early-bird registrations fit

/**
 * Keep only events a calendar can actually hold: non-empty title, a REAL ISO start date within
 * ±1yr of `todayISO`. A bad `end` (unparseable or before start) is dropped from the event rather
 * than dropping the event. Long free-text fields are clamped. Everything else passes through.
 */
export function validateExtractedEvents<T extends { title?: unknown; start?: unknown; end?: unknown; description?: unknown; location?: unknown }>(
  events: T[], todayISO: string,
): T[] {
  const today = dayNumber(todayISO);
  const out: T[] = [];
  for (const evt of Array.isArray(events) ? events : []) {
    if (!evt || typeof evt !== 'object') continue;
    const title = String(evt.title ?? '').trim();
    const start = String(evt.start ?? '').trim();
    const startDay = dayNumber(start);
    if (!title || startDay === null) continue;
    if (today !== null && Math.abs(startDay - today) > EXTRACTION_WINDOW_DAYS) continue;
    const cleaned: T = { ...evt, title: title.slice(0, 200), start };
    const end = String(evt.end ?? '').trim();
    const endDay = end ? dayNumber(end) : null;
    if (!end || endDay === null || endDay < startDay) delete (cleaned as Record<string, unknown>).end;
    if (typeof evt.description === 'string') (cleaned as Record<string, unknown>).description = evt.description.slice(0, 1000);
    if (typeof evt.location === 'string') (cleaned as Record<string, unknown>).location = evt.location.slice(0, 200);
    out.push(cleaned);
  }
  return out;
}
