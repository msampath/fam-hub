import { fetchWithTimeout, pruneByAge } from './fetchUtils';
import { checkRateWindow, pruneExpired } from './rateLimit';
import { dailyMaxFromHourly, parseGooglePollen } from '../utils/weatherFacts';
import {
  parseGooglePlaces, parseOverpassPlaces, filterKeylessPlacesByName,
  GOOGLE_PLACE_TYPES, OVERPASS_TOURISM, OVERPASS_LEISURE, type Place,
} from '../utils/placesFacts';
import { parseTicketmasterEvents, type LocalEvent } from '../utils/eventsFacts';

// ── Per-user data-fetch quota ─────────────────────────────────────────────────────
const DATA_FETCH_MAX_PER_HOUR = 60;
const dataFetchHits = new Map<string, { count: number; resetAt: number }>();
export function withinDataFetchQuota(key: string): boolean {
  const now = Date.now();
  pruneExpired(dataFetchHits, now);
  const e = dataFetchHits.get(key);
  if (!e || now >= e.resetAt) { dataFetchHits.set(key, { count: 1, resetAt: now + 3600_000 }); return true; }
  if (e.count >= DATA_FETCH_MAX_PER_HOUR) return false;
  e.count++;
  return true;
}

// ── Weather forecast (Open-Meteo, keyless) ────────────────────────────────────────
const weatherCache = new Map<string, { at: number; daily: any }>();
const WEATHER_TTL_MS = 3 * 3600_000;
export async function fetchWeatherDaily(lat: number, lng: number): Promise<any | null> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = weatherCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.daily;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}`
    + `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max`
    + `&temperature_unit=fahrenheit&timezone=auto&forecast_days=16`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const data: any = await r.json();
    const daily = data?.daily || null;
    if (daily) { pruneByAge(weatherCache, WEATHER_TTL_MS, Date.now()); weatherCache.set(key, { at: Date.now(), daily }); }
    return daily;
  } catch (err: any) {
    console.warn('Weather fetch failed (proceeding ungrounded):', err?.message || err);
    return null;
  }
}

// ── Air quality (Open-Meteo, keyless) ─────────────────────────────────────────────
const airCache = new Map<string, { at: number; aqi: Record<string, number> }>();
export async function fetchAirQualityDaily(lat: number, lng: number): Promise<Record<string, number>> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = airCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.aqi;
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}`
    + `&hourly=us_aqi&forecast_days=7&timezone=auto`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) return {};
    const data: any = await r.json();
    const aqi = dailyMaxFromHourly(data?.hourly?.time, data?.hourly?.us_aqi);
    pruneByAge(airCache, WEATHER_TTL_MS, Date.now());
    airCache.set(key, { at: Date.now(), aqi });
    return aqi;
  } catch (err: any) {
    console.warn('Air-quality fetch failed (proceeding without):', err?.message || err);
    return {};
  }
}

// ── Pollen (Google Pollen API, key-gated) ─────────────────────────────────────────
const pollenCache = new Map<string, { at: number; pollen: Record<string, { label: string; category: string }> }>();
export async function fetchPollenDaily(lat: number, lng: number): Promise<Record<string, { label: string; category: string }>> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return {};
  const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = pollenCache.get(key);
  if (cached && Date.now() - cached.at < WEATHER_TTL_MS) return cached.pollen;
  const url = `https://pollen.googleapis.com/v1/forecast:lookup?key=${apiKey}`
    + `&location.latitude=${lat}&location.longitude=${lng}&days=5`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) { console.warn('Google Pollen non-200 (no pollen shown):', r.status); return {}; }
    const pollen = parseGooglePollen(await r.json());
    pruneByAge(pollenCache, WEATHER_TTL_MS, Date.now());
    pollenCache.set(key, { at: Date.now(), pollen });
    return pollen;
  } catch (err: any) {
    console.warn('Pollen fetch failed (proceeding without):', err?.message || err);
    return {};
  }
}

// ── Places + travel-time grounding (Google primary, free OSM fallback) ─────────────
const PLACES_RADIUS_M = Number(process.env.PLACES_RADIUS_M) || 40000;
const placesCache = new Map<string, { at: number; places: Place[] }>();
const PLACES_TTL_MS = 24 * 3600_000;

export async function fetchNearbyPlaces(lat: number, lng: number, opts?: { radiusM?: number; rank?: 'POPULARITY' | 'DISTANCE'; textQuery?: string }): Promise<Place[]> {
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
    if (places.length) { pruneByAge(placesCache, PLACES_TTL_MS, Date.now()); placesCache.set(cacheKey, { at: Date.now(), places }); }
    return places;
  } catch (err: any) {
    console.warn('Places fetch failed (proceeding without):', err?.message || err);
    return [];
  }
}

export async function attachTravelTimes(homeLat: number, homeLng: number, places: Place[]): Promise<void> {
  const targets = places.slice(0, 12);
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

// ── Local events (Ticketmaster, key-gated) ────────────────────────────────────────
const eventsCache = new Map<string, { at: number; events: LocalEvent[] }>();
const EVENTS_TTL_MS = 6 * 3600_000;
export async function fetchLocalEvents(lat: number, lng: number, today: string, windowEndExcl: string): Promise<LocalEvent[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return [];
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}|${today}`;
  const cached = eventsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EVENTS_TTL_MS) return cached.events;
  try {
    const url = `https://app.ticketmaster.com/discovery/v2/events.json?latlong=${lat},${lng}`
      + `&radius=50&unit=miles&size=40&sort=date,asc`
      + `&startDateTime=${encodeURIComponent(`${today}T00:00:00Z`)}`
      + `&endDateTime=${encodeURIComponent(`${windowEndExcl}T00:00:00Z`)}&apikey=${apiKey}`;
    const r = await fetchWithTimeout(url, 8000);
    if (!r.ok) return [];
    const events = parseTicketmasterEvents(await r.json(), today, windowEndExcl);
    pruneByAge(eventsCache, EVENTS_TTL_MS, Date.now());
    eventsCache.set(cacheKey, { at: Date.now(), events });
    return events;
  } catch (err: any) {
    console.warn('Events fetch failed (proceeding without):', err?.message || err);
    return [];
  }
}

export function parseUsZip(q: string): string | null {
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(String(q || ''));
  return m ? m[1] : null;
}
