// Pure PLACES FACTS builder for the copilot harness. Real venues near the family's home are
// SERVER-fetched (Google Places primary, OpenStreetMap Overpass fallback) and injected so the weak
// local model recommends from REAL, specific places with drive times instead of vague categories or
// invented venues (Pattern 1 — same as WEATHER/DATE FACTS; agentic search proved unreliable).
// This file is PURE: the response PARSERS + the block FORMATTER.
// The network fetch + travel-time merge live in server.ts (mirroring fetchWeatherDaily). Unit-tested.
import { sanitizeForPrompt } from './promptSafety';
import { shiftDateStr } from './dates';

export interface Place {
  name: string;
  category: string;       // normalized short label: zoo|museum|park|aquarium|attraction|garden|…
  lat: number;
  lng: number;
  rating?: number;        // 0..5 when known (Google)
  userRatingCount?: number; // review count (Google) — low+well-rated = under-the-radar "gem"
  notable?: boolean;      // OSM: tagged with wikidata/wikipedia → well-known (used to rank fallback)
  gem?: boolean;          // flagged by flagHiddenGems: highly-rated but not-yet-popular (creative pick)
  driveMinutes?: number;  // filled in after a travel-time lookup (server.ts)
  driveMiles?: number;
  url?: string;           // a real link: official website → else a Google Maps link (NEVER model-written)
}

// Google Places API (New) `searchNearby` includedTypes for family outings (ranked by POPULARITY).
export const GOOGLE_PLACE_TYPES = [
  'zoo', 'aquarium', 'amusement_park', 'museum', 'park', 'national_park',
  'tourist_attraction', 'art_gallery', 'hiking_area', 'botanical_garden',
];

// OSM Overpass tag values we treat as family venues, with a normalized display category. Keyed by
// "<key>=<value>" (the Overpass tags we query for below).
const OSM_CATEGORY: Record<string, string> = {
  'tourism=zoo': 'zoo',
  'tourism=museum': 'museum',
  'tourism=aquarium': 'aquarium',
  'tourism=theme_park': 'amusement park',
  'tourism=attraction': 'attraction',
  'tourism=gallery': 'art gallery',
  'tourism=artwork': 'attraction',
  'leisure=park': 'park',
  'leisure=nature_reserve': 'nature reserve',
  'leisure=garden': 'garden',
  'leisure=playground': 'playground',
};
// The Overpass tag filters (regex value lists) the server queries with — exported so the fetch and
// the parser agree on the set without drifting.
export const OVERPASS_TOURISM = 'zoo|museum|aquarium|theme_park|attraction|gallery';
export const OVERPASS_LEISURE = 'park|nature_reserve|garden|playground';

// Map a Google place `type` to a short display category (first known type wins).
function googleTypeLabel(types: any): string {
  const list = Array.isArray(types) ? types.map(String) : [];
  const pretty: Record<string, string> = {
    zoo: 'zoo', aquarium: 'aquarium', amusement_park: 'amusement park', museum: 'museum',
    park: 'park', national_park: 'national park', tourist_attraction: 'attraction',
    art_gallery: 'art gallery', hiking_area: 'hiking', botanical_garden: 'garden',
    childrens_museum: "children's museum", science_museum: 'science center',
  };
  for (const t of list) if (pretty[t]) return pretty[t];
  return list[0] ? String(list[0]).replace(/_/g, ' ') : 'place';
}

// A Google Maps search link for a venue — used when there's no official website (and for the keyless
// OSM fallback, which has none) so EVERY place fact still carries a real, openable URL the parent can
// tap, instead of a model-fabricated link. Prefers the name; falls back to coordinates if name is empty.
export function googleMapsSearchUrl(name: string, lat?: number, lng?: number): string {
  const q = (name || '').trim() || (Number.isFinite(lat) && Number.isFinite(lng) ? `${lat},${lng}` : '');
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Parse a Google Places (New) searchNearby response → normalized Place[] (API order = popularity).
export function parseGooglePlaces(json: any, max = 12): Place[] {
  const arr = Array.isArray(json?.places) ? json.places : [];
  const out: Place[] = [];
  for (const p of arr) {
    const name = String(p?.displayName?.text || '').trim();
    const lat = Number(p?.location?.latitude);
    const lng = Number(p?.location?.longitude);
    if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const rating = Number.isFinite(Number(p?.rating)) ? Number(p.rating) : undefined;
    const userRatingCount = Number.isFinite(Number(p?.userRatingCount)) ? Number(p.userRatingCount) : undefined;
    // Prefer the official site; else Google's Maps URL (returned for every place); else a constructed
    // Maps link — so every venue carries a real link, never one the model wrote (it would hallucinate).
    const website = typeof p?.websiteUri === 'string' && /^https?:\/\//i.test(p.websiteUri) ? p.websiteUri : '';
    const maps = typeof p?.googleMapsUri === 'string' && /^https?:\/\//i.test(p.googleMapsUri) ? p.googleMapsUri : '';
    const url = website || maps || googleMapsSearchUrl(name, lat, lng);
    out.push({ name, category: googleTypeLabel(p?.types), lat, lng, rating, userRatingCount, url });
    if (out.length >= max) break;
  }
  return out;
}

// Parse an Overpass response → normalized Place[]. Keeps only named venues, derives a category from
// the tags, and marks `notable` when the element has a wikidata/wikipedia tag (a strong "well-known"
// signal). Sorts notable-first so the famous venues lead. Dedupes by lowercased name.
export function parseOverpassPlaces(json: any, max = 12): Place[] {
  const els = Array.isArray(json?.elements) ? json.elements : [];
  const seen = new Set<string>();
  const places: Place[] = [];
  for (const el of els) {
    const tags = el?.tags || {};
    const name = String(tags.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    // node has lat/lon; way/relation has center.{lat,lon} (Overpass `out center`).
    const lat = Number(el.lat ?? el.center?.lat);
    const lng = Number(el.lon ?? el.center?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    let category = 'place';
    for (const k of ['tourism', 'leisure']) {
      const v = tags[k];
      if (v && OSM_CATEGORY[`${k}=${v}`]) { category = OSM_CATEGORY[`${k}=${v}`]; break; }
    }
    const notable = !!(tags.wikidata || tags.wikipedia);
    // OSM rarely carries a usable website; fall back to a Google Maps search link so the fact still
    // links out (the "a Maps link is acceptable when there's no website" guardrail).
    const website = String(tags.website || tags['contact:website'] || '').trim();
    const url = /^https?:\/\//i.test(website) ? website : googleMapsSearchUrl(name, lat, lng);
    seen.add(key);
    places.push({ name, category, lat, lng, notable, url });
  }
  // Notable (wikidata-tagged) first, then alphabetical for stability.
  places.sort((a, b) => Number(b.notable) - Number(a.notable) || a.name.localeCompare(b.name));
  return places.slice(0, max);
}

// Detect a PROXIMITY constraint in a planning prompt — by DISTANCE ("within 6 miles", "5-6 mi") or
// by DRIVE TIME ("within 20 minutes", "30 min drive", "half-hour away"), plus vague phrases ("near
// me", "walking distance"). Returns the max drive miles OR minutes to filter to, or null for an
// open-ended query. The server uses this to switch the fetch from POPULARITY to DISTANCE (closest
// first) + a tighter radius (estimated from minutes when given), and to filter by the actual drive.
// Range → upper bound. Mile/minute UNIT required, so bare years/counts don't match. Pure/tested.
export function parseDistanceConstraint(prompt: string): { maxMiles?: number; maxMinutes?: number } | null {
  const s = String(prompt || '').toLowerCase();
  const mi = s.match(/(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s*(?:mi|mile|miles)\b/);
  if (mi) {
    const hi = mi[2] ? Number(mi[2]) : Number(mi[1]);
    if (Number.isFinite(hi) && hi > 0 && hi <= 200) return { maxMiles: hi };
  }
  if (/\bhalf[\s-]?hour\b/.test(s)) return { maxMinutes: 30 };
  const mn = s.match(/(\d{1,3})(?:\s*(?:-|–|to)\s*(\d{1,3}))?\s*(?:min|mins|minute|minutes)\b/);
  if (mn) {
    const hi = mn[2] ? Number(mn[2]) : Number(mn[1]);
    if (Number.isFinite(hi) && hi > 0 && hi <= 240) return { maxMinutes: hi };
  }
  if (/walking distance|within walking|walkable/.test(s)) return { maxMiles: 2 };
  if (/\b(near me|nearby|near here|close by|close to home|around here|right here)\b/.test(s)) return { maxMiles: 10 };
  return null;
}

// Does this query need PLACES grounding even if it lacks generic planning keywords? True for a
// proximity/drive-time constraint ("within 15 min", "near me") or a food/cafe intent ("vegan
// restaurant", "coffee"). Used (alongside isPlanningQuery) to gate the copilot's grounding fetch, so
// the home location + venue list are injected for these — otherwise the model has no location and
// asks the user for their ZIP. Pure/tested.
export function isPlacesQuery(prompt: string): boolean {
  return !!parseDistanceConstraint(prompt) || !!detectPlacesIntent(prompt);
}

// Food/drink INTENT → a Google Text Search query (cafes/restaurants/cuisines aren't in the
// family-outing includedTypes, so the default Nearby Search never surfaces them). Returns null for a
// non-food query (→ keep the default family Nearby Search). The matched term drives a clean query;
// novelty ("new"/"different") is handled by the gem score + visited-exclusion, NOT the query text.
// Pure/tested.
const CUISINES = [
  'vegan', 'vegetarian', 'thai', 'indian', 'italian', 'mexican', 'chinese', 'korean', 'japanese',
  'vietnamese', 'mediterranean', 'greek', 'ethiopian', 'sushi', 'ramen', 'pho', 'pizza', 'barbecue',
  'bbq', 'burger', 'taco', 'noodle', 'seafood', 'steak', 'dim sum',
];
export function detectPlacesIntent(prompt: string): { textQuery: string } | null {
  const s = String(prompt || '').toLowerCase();
  if (/\b(coffee|caf[eé]|espresso|latte|cappuccino)\b/.test(s)) return { textQuery: 'coffee shop' };
  if (/\b(boba|bubble tea)\b/.test(s)) return { textQuery: 'boba tea shop' };
  if (/\b(bakery|bakeries|pastr(?:y|ies)|donut|doughnut|dessert|ice cream|gelato|cupcake)\b/.test(s)) return { textQuery: 'bakery and dessert' };
  if (/\b(brunch|breakfast)\b/.test(s)) return { textQuery: 'brunch spot' };
  for (const c of CUISINES) if (new RegExp(`\\b${c}\\b`).test(s)) return { textQuery: `${c} restaurant` };
  if (/\b(restaurant|dinner|lunch|dine|eat out|grab a bite|food|takeout|take-?out|takeaway|where to eat)\b/.test(s)) return { textQuery: 'restaurant' };
  return null;
}

// Flag highly-rated but NOT-yet-popular venues — the "creative / something different" picks. A strong
// rating with a modest review count = legit but under-the-radar. Mutates + returns the list. Pure
// aside from the flag; thresholds tunable.
export function flagHiddenGems(places: Place[], opts?: { minRating?: number; minReviews?: number; maxReviews?: number }): Place[] {
  const minRating = opts?.minRating ?? 4.2;
  const minReviews = opts?.minReviews ?? 15;
  const maxReviews = opts?.maxReviews ?? 600;
  for (const p of Array.isArray(places) ? places : []) {
    p.gem = typeof p.rating === 'number' && p.rating >= minRating
      && typeof p.userRatingCount === 'number' && p.userRatingCount >= minReviews && p.userRatingCount <= maxReviews;
  }
  return places;
}

// Drop venues the family visited within `days` (so "a DIFFERENT vegan restaurant" excludes the one
// they just went to). Matches by case-insensitive name against the visit log's labels. Pure.
export function filterRecentlyVisited(
  places: Place[],
  visitLog: Array<{ label?: string; lastVisited?: string }>,
  today: string,
  days = 90,
): Place[] {
  const log = Array.isArray(visitLog) ? visitLog : [];
  const list = Array.isArray(places) ? places : [];
  if (!log.length) return list;
  const cutoff = shiftDateStr(today, -days);
  const recent = new Set(
    log.filter(v => v?.label && (!v.lastVisited || v.lastVisited >= cutoff))
      .map(v => String(v.label).trim().toLowerCase()),
  );
  if (!recent.size) return list;
  return list.filter(p => !recent.has(p.name.trim().toLowerCase()));
}

// The capped, id-tagged place list ([P1]…[Pn]) — SHARED by buildPlacesFacts (the lines the model
// sees) and the server's suggestion resolver, so the [P#] ids never drift from the facts. A suggestion
// that references [P#] is validated against this list and given its real name + URL from it.
export function indexedPlaces(places: Place[], maxItems = 10): Array<{ id: string; place: Place }> {
  return (Array.isArray(places) ? places : [])
    .filter(p => p && p.name)
    .slice(0, maxItems)
    .map((place, i) => ({ id: `P${i + 1}`, place }));
}

// Build the PLACES FACTS block. Each line is tagged with a [P#] id (the model cites it in a "place"
// suggestion's `ref`), then names a real venue, its category, rating (Google) and drive time (when a
// travel lookup filled it in). `opts.withinMiles` reflects a distance-constrained query in the header
// so the model frames it correctly. Returns '' when there are no places. The venue URL is NOT printed
// here (kept server-side, resolved by id) — it only bloats the prompt and the weak model would mangle it.
export function buildPlacesFacts(homeLabel: string, places: Place[], maxItems = 10, opts?: { withinMiles?: number; withinMinutes?: number }): string {
  const indexed = indexedPlaces(places, maxItems);
  if (!indexed.length) return '';
  const safeLabel = (String(homeLabel || '').replace(/[\r\n]+/g, ' ').trim() || 'home').slice(0, 80);
  const scope = typeof opts?.withinMiles === 'number'
    ? `within ~${opts.withinMiles} miles of ${safeLabel} (closest first)`
    : typeof opts?.withinMinutes === 'number'
    ? `within ~${opts.withinMinutes} minutes' drive of ${safeLabel} (closest first)`
    : `near ${safeLabel}`;
  const lines = indexed.map(({ id, place: p }) => {
    // Show the review count only on gems (signals "newer / under-the-radar"); keep marquee lines lean.
    const reviews = p.gem && typeof p.userRatingCount === 'number' ? ` (${p.userRatingCount} reviews)` : '';
    const rating = typeof p.rating === 'number' && p.rating > 0 ? `, ${p.rating.toFixed(1)}★${reviews}` : '';
    const drive = typeof p.driveMinutes === 'number'
      ? ` — ~${p.driveMinutes} min drive${typeof p.driveMiles === 'number' ? ` (${p.driveMiles} mi)` : ''}`
      : '';
    // Sanitize third-party (Google/OSM) names + categories — strip control chars + cap — so a
    // crafted venue name can't inject instructions into the prompt (matches eventsFacts.ts).
    const safeName = sanitizeForPrompt(p.name, 80);
    const safeCategory = sanitizeForPrompt(p.category, 30);
    const tag = p.gem ? ' · lesser-known gem' : '';
    return `- [${id}] ${safeName} (${safeCategory}${rating})${drive}${tag}`;
  });
  const gemNote = indexed.some(({ place: p }) => p.gem)
    ? "Venues marked 'lesser-known gem' are highly rated but not yet popular — use one (by its id) for the creative / 'something different' pick."
    : '';
  return [
    `PLACES FACTS (real, currently-open venues ${scope}, server-provided — recommend ONLY venues from THIS list, by their [P#] id; do NOT invent other places):`,
    ...lines,
    'Prefer closer and higher-rated venues, and match indoor/outdoor to WEATHER FACTS. If none fit the day, say so rather than inventing a place.',
    gemNote,
  ].filter(Boolean).join('\n');
}
