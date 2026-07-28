import { fetchWithTimeout, pruneByAge } from './fetchUtils';
import { pruneExpired } from './rateLimit';
import { dailyMaxFromHourly, parseGooglePollen } from '../utils/weatherFacts';
import { fetchTicketmasterEvents, type LocalEvent } from '../utils/eventsFacts';

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

// ── Places + travel-time grounding — ONE implementation (src/utils/placesFetch.ts, shared with the
// MCP find_places tool). This module re-exports it so server.ts keeps its import surface; the twin
// copy that used to live here (115 near-identical lines) drifted once (prune-before-cache) and is gone.
export { fetchNearbyPlaces, attachTravelTimes } from '../utils/placesFetch';

// ── Local events (Ticketmaster, key-gated) ────────────────────────────────────────
const eventsCache = new Map<string, { at: number; events: LocalEvent[] }>();
const EVENTS_TTL_MS = 6 * 3600_000;
export async function fetchLocalEvents(lat: number, lng: number, today: string, windowEndExcl: string): Promise<LocalEvent[]> {
  const apiKey = process.env.TICKETMASTER_API_KEY;
  if (!apiKey) return [];
  // windowEndExcl is part of the identity — with only |today| a second caller with a different window
  // would silently get the first caller's cached span (latent trap; today's sole caller is constant).
  const cacheKey = `${lat.toFixed(2)},${lng.toFixed(2)}|${today}|${windowEndExcl}`;
  const cached = eventsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < EVENTS_TTL_MS) return cached.events;
  try {
    const events = await fetchTicketmasterEvents(apiKey, lat, lng, today, windowEndExcl);
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
