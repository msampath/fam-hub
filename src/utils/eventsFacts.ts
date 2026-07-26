// Pure EVENTS FACTS builder for the copilot harness. Real dated events near home (concerts, fairs,
// family shows, sports) are SERVER-fetched from the Ticketmaster Discovery API and injected so the
// model can recommend a REAL event on a REAL date instead of inventing "check for a festival"
// (Pattern 1 — the fetch lives in server.ts). This file is PURE: the response PARSER + the block
// FORMATTER. Unit-tested. EVENTS are not places — maps APIs don't provide them, hence a separate
// source/block.
import { weekdayOf, addDaysISO } from './copilotHarness';
import { sanitizeForPrompt } from './promptSafety';

export interface LocalEvent {
  name: string;
  date: string;     // YYYY-MM-DD (local)
  venue?: string;
  category?: string; // Ticketmaster classification segment, e.g. Music / Family / Sports
  url?: string;
}

// Parse a Ticketmaster Discovery `events.json` response → events within [today, windowEndISO],
// sorted by date. Family/child segments float to the top (most relevant for this app) but other
// segments are kept too. Dedupes by name+date so a multi-showtime event lists once.
export function parseTicketmasterEvents(json: any, today: string, windowEndISO: string, max = 12): LocalEvent[] {
  const arr = json?._embedded?.events;
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const events: LocalEvent[] = [];
  for (const e of arr) {
    const name = sanitizeForPrompt(e?.name, 80);
    const date = String(e?.dates?.start?.localDate || '').slice(0, 10);
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (date < today || date >= windowEndISO) continue; // outside the planning window
    const key = `${date}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const venue = sanitizeForPrompt(e?._embedded?.venues?.[0]?.name, 60) || undefined;
    const seg = e?.classifications?.[0]?.segment?.name;
    const category = typeof seg === 'string' ? sanitizeForPrompt(seg, 24) : undefined;
    // The Ticketmaster event page — a real link carried through to the suggestion (never model-written).
    const url = typeof e?.url === 'string' && /^https?:\/\//i.test(e.url) ? e.url : undefined;
    events.push({ name, date, venue, category, url });
  }
  const isFamily = (c?: string) => /family|children/i.test(c || '');
  events.sort((a, b) =>
    (Number(isFamily(b.category)) - Number(isFamily(a.category))) || a.date.localeCompare(b.date));
  return events.slice(0, max);
}

// The ONE Ticketmaster Discovery request both consumers share — the Express copilot's grounding
// (src/server/grounding.ts, which adds its cache + silent-[] edge) and the agent's find_events MCP
// tool (which adds honest rejected messages) — so radius/size/sort/date encoding can never drift
// between the two paths. The HTTP window is widened ±1 day around the requested civil-local window:
// start/endDateTime are UTC INSTANTS, so without the widening a west-of-UTC household loses its
// `to`-day evening events (Sun 7pm PDT starts Mon 02:00Z) and an east-of-UTC one loses early-morning
// `from`-day events. parseTicketmasterEvents' localDate filter [fromISO, windowEndExclISO) does the
// precise trim, so callers see exactly the civil window they asked for.
export function ticketmasterEventsUrl(apiKey: string, lat: number, lng: number, fromISO: string, windowEndExclISO: string): string {
  return `https://app.ticketmaster.com/discovery/v2/events.json?latlong=${lat},${lng}`
    + `&radius=50&unit=miles&size=40&sort=date,asc`
    + `&startDateTime=${encodeURIComponent(`${addDaysISO(fromISO, -1)}T00:00:00Z`)}`
    + `&endDateTime=${encodeURIComponent(`${addDaysISO(windowEndExclISO, 1)}T00:00:00Z`)}&apikey=${apiKey}`;
}

// Fetch + parse in one step (8s abort). Throws on HTTP failure/timeout with the status in the message —
// each caller decides whether that's a silent [] (grounding) or an honest rejection (find_events).
export async function fetchTicketmasterEvents(
  apiKey: string, lat: number, lng: number, fromISO: string, windowEndExclISO: string, timeoutMs = 8000,
): Promise<LocalEvent[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(ticketmasterEventsUrl(apiKey, lat, lng, fromISO, windowEndExclISO), { signal: ctrl.signal });
    if (!r.ok) throw new Error(`Ticketmaster HTTP ${r.status}`);
    return parseTicketmasterEvents(await r.json(), fromISO, windowEndExclISO);
  } finally {
    clearTimeout(timer);
  }
}

// The capped, id-tagged event list ([E1]…[En]) — SHARED by buildEventsFacts and the server's
// suggestion resolver so the [E#] ids never drift (mirrors indexedPlaces). A suggestion referencing
// [E#] is validated against this list and given the event's real name + date + URL.
export function indexedEvents(events: LocalEvent[], maxItems = 12): Array<{ id: string; event: LocalEvent }> {
  return (Array.isArray(events) ? events : [])
    .filter(e => e && e.name && e.date)
    .slice(0, maxItems)
    .map((event, i) => ({ id: `E${i + 1}`, event }));
}

// Build the EVENTS FACTS block. Each line is tagged with an [E#] id (cited in a "place"-type
// suggestion's `ref`). Returns '' when there are no events (so no block is injected). The event URL is
// kept server-side (resolved by id), not printed here.
export function buildEventsFacts(homeLabel: string, events: LocalEvent[], maxItems = 12): string {
  const indexed = indexedEvents(events, maxItems);
  if (!indexed.length) return '';
  const safeLabel = (String(homeLabel || '').replace(/[\r\n]+/g, ' ').trim() || 'home').slice(0, 80);
  const lines = indexed.map(({ id, event: e }) => {
    const venue = e.venue ? ` at ${e.venue}` : '';
    const cat = e.category ? ` [${e.category}]` : '';
    return `- [${id}] ${weekdayOf(e.date)} ${e.date}: ${e.name}${venue}${cat}`;
  });
  return [
    `EVENTS FACTS (real, dated, ticketed events near ${safeLabel} in the planning window, server-provided — you MAY recommend these by their [E#] id with their exact date; do NOT invent events):`,
    ...lines,
    'Only these dated events are verified. Do not claim any other event is happening on a given day.',
  ].join('\n');
}
