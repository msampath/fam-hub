// Real-venue discovery for the CONCIERGE AGENT (the MCP `find_places` tool).
//
// This is the same grounding the in-app copilot uses (Google Places New → OSM Overpass fallback, with
// Distance Matrix → OSRM drive times), so the agent can recommend a REAL named venue and surface its real
// "plan a visit" URL instead of improvising. It reuses the PURE parsers/constants from placesFacts.ts;
// only the HTTP orchestration lives here.
//
// NOTE (dedup follow-up): server.ts has near-identical `fetchNearbyPlaces`/`attachTravelTimes` for the
// copilot path. They're kept separate for now so adding the agent's discovery can't touch the working
// copilot; a later cleanup can point server.ts at this module.
import {
  parseGooglePlaces, parseOverpassPlaces, filterKeylessPlacesByName,
  GOOGLE_PLACE_TYPES, OVERPASS_TOURISM, OVERPASS_LEISURE, type Place,
} from './placesFacts';

const PLACES_RADIUS_M = Number(process.env.PLACES_RADIUS_M) || 40000; // ~25 mi
// A getaway is searched AROUND the destination (not home), so use a wider circle — venues (lodging,
// food, trailheads) sprawl around a park/town far more than the tight home radius.
const DEST_RADIUS_M = Number(process.env.PLACES_DEST_RADIUS_M) || 60000; // ~37 mi
const PLACES_TTL_MS = 24 * 3600_000; // venues barely change day-to-day
const placesCache = new Map<string, { at: number; places: Place[] }>();

async function fetchWithTimeout(url: string, timeoutMs = 8000, init?: any) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(init || {}), signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Real nearby venues. With GOOGLE_MAPS_API_KEY: Google Places (New) — Text Search for a specific query
// (e.g. "zoo"), else Nearby Search over family types. Without a key: keyless OSM Overpass. Best-effort:
// any failure returns []. Cached per (coords, radius, rank, query). Each Place carries a resolved `url`
// (official website → Google Maps) from the parsers — never a model-written link.
export async function fetchNearbyPlaces(
  lat: number, lng: number,
  opts?: { radiusM?: number; rank?: 'POPULARITY' | 'DISTANCE'; textQuery?: string },
): Promise<Place[]> {
  const radiusM = Math.round(opts?.radiusM || PLACES_RADIUS_M);
  const rank = opts?.rank || 'POPULARITY';
  const textQuery = opts?.textQuery?.trim() || '';
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}|${radiusM}|${rank}|${textQuery}`;
  const cached = placesCache.get(cacheKey);
  if (cached && Date.now() - cached.at < PLACES_TTL_MS) return cached.places;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const fieldMask = 'places.displayName,places.types,places.rating,places.userRatingCount,places.location,places.googleMapsUri,places.websiteUri';
  try {
    let places: Place[] = [];
    if (apiKey && textQuery) {
      const r = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchText', 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
        body: JSON.stringify({
          textQuery,
          maxResultCount: 15,
          locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM } },
        }),
      });
      if (r.ok) places = parseGooglePlaces(await r.json());
      else console.warn('Google Text Search non-200 (falling back to OSM):', r.status);
    } else if (apiKey) {
      const r = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchNearby', 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
        body: JSON.stringify({
          includedTypes: GOOGLE_PLACE_TYPES,
          maxResultCount: 15,
          rankPreference: rank,
          locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM } },
        }),
      });
      if (r.ok) places = parseGooglePlaces(await r.json());
      else console.warn('Google Places non-200 (falling back to OSM):', r.status);
    }
    if (!places.length && textQuery) {
      const q = `[out:json][timeout:20];(`
        + `node["amenity"~"cafe|restaurant|fast_food"]["name"](around:${radiusM},${lat},${lng});`
        + `way["amenity"~"cafe|restaurant|fast_food"]["name"](around:${radiusM},${lat},${lng});`
        + `);out center tags 60;`;
      const r = await fetchWithTimeout('https://overpass-api.de/api/interpreter', 12000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      // Overpass is CATEGORY-only — honesty filter: a name ask keeps only name-matching venues
      // (empty = honest miss), never six arbitrary cafés dressed as the answer.
      if (r.ok) places = filterKeylessPlacesByName(parseOverpassPlaces(await r.json()), textQuery).places;
    }
    if (!places.length && !textQuery) {
      const q = `[out:json][timeout:20];(`
        + `node["tourism"~"${OVERPASS_TOURISM}"](around:${radiusM},${lat},${lng});`
        + `way["tourism"~"${OVERPASS_TOURISM}"](around:${radiusM},${lat},${lng});`
        + `node["leisure"~"${OVERPASS_LEISURE}"]["name"](around:${radiusM},${lat},${lng});`
        + `way["leisure"~"${OVERPASS_LEISURE}"]["name"](around:${radiusM},${lat},${lng});`
        + `);out center tags 60;`;
      const r = await fetchWithTimeout('https://overpass-api.de/api/interpreter', 12000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (r.ok) places = parseOverpassPlaces(await r.json());
    }
    if (places.length) placesCache.set(cacheKey, { at: Date.now(), places });
    return places;
  } catch (err: any) {
    console.warn('Places fetch failed (proceeding without):', err?.message || err);
    return [];
  }
}

// Fill driveMinutes/driveMiles from home (Google Distance Matrix → keyless OSRM fallback). Best-effort:
// mutates in place; on any failure the places simply carry no drive time.
export async function attachTravelTimes(homeLat: number, homeLng: number, places: Place[]): Promise<void> {
  const targets = places.slice(0, 12); // cap the matrix size
  if (!targets.length) return;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  try {
    if (apiKey) {
      const dest = targets.map(p => `${p.lat},${p.lng}`).join('|');
      const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${homeLat},${homeLng}`
        + `&destinations=${encodeURIComponent(dest)}&mode=driving&units=imperial&key=${apiKey}`;
      const r = await fetchWithTimeout(url, 8000);
      if (r.ok) {
        const data: any = await r.json();
        const elements = data?.rows?.[0]?.elements;
        if (Array.isArray(elements)) {
          targets.forEach((p, i) => {
            const el = elements[i];
            if (el?.status === 'OK') {
              if (Number.isFinite(el.duration?.value)) p.driveMinutes = Math.round(el.duration.value / 60);
              if (Number.isFinite(el.distance?.value)) p.driveMiles = Math.round(el.distance.value / 1609.34);
            }
          });
          return;
        }
      } else {
        console.warn('Distance Matrix non-200 (falling back to OSRM):', r.status);
      }
    }
    const coords = [[homeLng, homeLat], ...targets.map(p => [p.lng, p.lat])].map(c => `${c[0]},${c[1]}`).join(';');
    const url = `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
    const r = await fetchWithTimeout(url, 10000);
    if (!r.ok) return;
    const data: any = await r.json();
    const durations = data?.durations?.[0];
    const distances = data?.distances?.[0];
    if (Array.isArray(durations)) {
      targets.forEach((p, i) => {
        const sec = durations[i + 1];
        if (Number.isFinite(sec)) p.driveMinutes = Math.round(Number(sec) / 60);
        const m = distances?.[i + 1];
        if (Number.isFinite(m)) p.driveMiles = Math.round(Number(m) / 1609.34);
      });
    }
  } catch (err: any) {
    console.warn('Travel-time fetch failed (places without drive times):', err?.message || err);
  }
}

// Geocode a destination NAME → coords, so a FAR getaway can be searched AROUND the destination instead
// of the home radius (find_places otherwise never reaches a place ~90 mi away). Google Text Search with
// NO location bias (best global match) when a key is present; keyless OSM Nominatim fallback otherwise.
// Best-effort: null on any failure (caller then falls back to a home-radius search).
async function geocodeDestination(name: string): Promise<{ lat: number; lng: number } | null> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  try {
    if (apiKey) {
      const r = await fetchWithTimeout('https://places.googleapis.com/v1/places:searchText', 8000, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': 'places.location,places.displayName' },
        body: JSON.stringify({ textQuery: name, maxResultCount: 1 }),
      });
      if (r.ok) {
        const j: any = await r.json();
        const loc = j?.places?.[0]?.location;
        if (Number.isFinite(loc?.latitude) && Number.isFinite(loc?.longitude)) return { lat: loc.latitude, lng: loc.longitude };
      } else {
        console.warn('Geocode (Text Search) non-200, trying Nominatim:', r.status);
      }
    }
    // Keyless fallback (Overpass needs coords; Nominatim turns a name into them). Nominatim requires a UA.
    const r = await fetchWithTimeout(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(name)}`,
      8000, { headers: { 'User-Agent': 'family-hub-concierge/1.0' } },
    );
    if (r.ok) {
      const arr: any[] = await r.json();
      const hit = arr?.[0];
      if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lon))) return { lat: Number(hit.lat), lng: Number(hit.lon) };
    }
  } catch (err: any) {
    console.warn('Geocode failed (no destination centroid):', err?.message || err);
  }
  return null;
}

/**
 * Find real venues for the agent. `query` is a free-text intent ("zoo", "lodge hotel", "restaurants");
 * omit it for marquee family venues. By default searches near (homeLat, homeLng). When `destination` is
 * given (a far getaway — e.g. "Mount Rainier National Park"), it geocodes that and searches AROUND the
 * destination instead, while STILL reporting drive time from home. Returns up to `max` places (each with a
 * resolved `url`) PLUS `destinationResolved`: false means a destination was requested but couldn't be
 * geocoded, so these are HOME-area venues — the caller MUST NOT label them "around <destination>".
 */
export async function findPlaces(
  homeLat: number, homeLng: number, query?: string, max = 6, destination?: string,
): Promise<{ places: Place[]; destinationResolved: boolean; keylessNameMiss: boolean }> {
  const textQuery = (query || '').trim();
  const dest = (destination || '').trim();
  // Default: search around home. With a destination, geocode it and search around THERE (wider radius).
  let searchLat = homeLat, searchLng = homeLng, radiusM: number | undefined;
  let destinationResolved = !dest; // no destination requested → nothing to resolve (home search)
  if (dest) {
    const geo = await geocodeDestination(dest);
    if (geo) { searchLat = geo.lat; searchLng = geo.lng; radiusM = DEST_RADIUS_M; destinationResolved = true; }
    // Geocode miss → destinationResolved stays false; fall through to a home-radius search (best-effort).
  }
  const places = await fetchNearbyPlaces(searchLat, searchLng, {
    ...(textQuery ? { textQuery } : {}),
    ...(radiusM ? { radiusM } : {}),
  });
  const top = places.slice(0, max);
  // Drive time is ALWAYS home → venue (so a getaway shows the real distance from home).
  await attachTravelTimes(homeLat, homeLng, top);
  // Keyless + a text ask + nothing survived the name filter → the caller should say a precise name
  // lookup needs a Maps key instead of presenting an empty (or wrong) result as a plain miss.
  const keylessNameMiss = !process.env.GOOGLE_MAPS_API_KEY && !!textQuery && top.length === 0;
  return { places: top, destinationResolved, keylessNameMiss };
}
