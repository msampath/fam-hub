// Pure WEATHER FACTS builder for the copilot harness. The server pre-fetches the Open-Meteo
// forecast (Pattern 1 — pre-fetch + inject) and hands the model an authoritative block instead of
// letting a weak local model search/guess the weather (agentic search proved unreliable).
// The model only reads it to choose indoor vs outdoor. Pure/testable.
import { weekdayOf } from './copilotHarness';

// WMO weather-interpretation codes → a short label + whether it's "wet" (rain/snow/storm/fog →
// prefer indoor). https://open-meteo.com/en/docs
const WMO: Record<number, { label: string; wet: boolean }> = {
  0: { label: 'Clear', wet: false },
  1: { label: 'Mainly clear', wet: false },
  2: { label: 'Partly cloudy', wet: false },
  3: { label: 'Overcast', wet: false },
  45: { label: 'Fog', wet: true }, 48: { label: 'Fog', wet: true },
  51: { label: 'Light drizzle', wet: true }, 53: { label: 'Drizzle', wet: true }, 55: { label: 'Heavy drizzle', wet: true },
  56: { label: 'Freezing drizzle', wet: true }, 57: { label: 'Freezing drizzle', wet: true },
  61: { label: 'Light rain', wet: true }, 63: { label: 'Rain', wet: true }, 65: { label: 'Heavy rain', wet: true },
  66: { label: 'Freezing rain', wet: true }, 67: { label: 'Freezing rain', wet: true },
  71: { label: 'Light snow', wet: true }, 73: { label: 'Snow', wet: true }, 75: { label: 'Heavy snow', wet: true },
  77: { label: 'Snow grains', wet: true },
  80: { label: 'Rain showers', wet: true }, 81: { label: 'Rain showers', wet: true }, 82: { label: 'Heavy rain showers', wet: true },
  85: { label: 'Snow showers', wet: true }, 86: { label: 'Snow showers', wet: true },
  95: { label: 'Thunderstorm', wet: true }, 96: { label: 'Thunderstorm with hail', wet: true }, 99: { label: 'Thunderstorm with hail', wet: true },
};

export function describeWeatherCode(code: number): { label: string; wet: boolean } {
  return WMO[code] ?? { label: 'Unknown', wet: false };
}

// US AQI bucket label. Drives both the displayed label and the kid-safety guidance (101+ limits
// strenuous outdoor play; 151+ steers indoor — relevant for wildfire-smoke days).
export function usAqiLabel(aqi: number): string {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

// Open-Meteo air-quality returns HOURLY arrays; collapse parallel time/value arrays to a per-date
// MAX (the worst hour of the day — what matters for "is it safe to be outside"). Pure.
export function dailyMaxFromHourly(time: any, values: any): Record<string, number> {
  const t = Array.isArray(time) ? time : [];
  const v = Array.isArray(values) ? values : [];
  const out: Record<string, number> = {};
  for (let i = 0; i < t.length; i++) {
    const date = String(t[i]).slice(0, 10);
    const n = Number(v[i]);
    if (!date || !Number.isFinite(n)) continue;
    out[date] = out[date] == null ? n : Math.max(out[date], n);
  }
  return out;
}

// Google Pollen API `forecast:lookup` → per-date DOMINANT pollen { label, category } (the highest-
// index of GRASS/TREE/WEED that day). Days with no/zero pollen are omitted. Pure.
export function parseGooglePollen(json: any): Record<string, { label: string; category: string }> {
  const days = Array.isArray(json?.dailyInfo) ? json.dailyInfo : [];
  const out: Record<string, { label: string; category: string }> = {};
  for (const d of days) {
    const dt = d?.date;
    if (!dt || dt.year == null || dt.month == null || dt.day == null) continue;
    const iso = `${dt.year}-${String(dt.month).padStart(2, '0')}-${String(dt.day).padStart(2, '0')}`;
    const types = Array.isArray(d?.pollenTypeInfo) ? d.pollenTypeInfo : [];
    let best: { label: string; category: string; value: number } | null = null;
    for (const p of types) {
      const value = Number(p?.indexInfo?.value);
      if (!Number.isFinite(value)) continue;
      if (!best || value > best.value) {
        best = { label: String(p?.displayName || p?.code || 'Pollen'), category: String(p?.indexInfo?.category || ''), value };
      }
    }
    if (best && best.value > 0) out[iso] = { label: best.label, category: best.category };
  }
  return out;
}

// Open-Meteo daily forecast arrays (parallel arrays indexed by day).
export interface DailyForecast {
  time?: string[];
  weather_code?: number[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
  uv_index_max?: number[];
}

// Build the WEATHER FACTS block from Open-Meteo daily arrays. Reuses weekdayOf so weekdays match
// DATE FACTS. Returns '' when there's no usable forecast (so no block is injected).
export function buildWeatherFacts(
  homeLabel: string,
  daily: DailyForecast | null | undefined,
  maxDays = 10,
  opts?: { aqiByDate?: Record<string, number>; pollenByDate?: Record<string, { label: string; category: string }> },
): string {
  const dates = Array.isArray(daily?.time) ? daily!.time : [];
  if (!dates.length) return '';
  const codes = daily!.weather_code || [];
  const tmax = daily!.temperature_2m_max || [];
  const tmin = daily!.temperature_2m_min || [];
  const pop = daily!.precipitation_probability_max || [];
  const uv = daily!.uv_index_max || [];
  const aqiByDate = opts?.aqiByDate || {};
  const pollenByDate = opts?.pollenByDate || {};

  const lines: string[] = [];
  let hasUv = false, hasAqi = false, hasHighPollen = false;
  for (let i = 0; i < dates.length && i < maxDays; i++) {
    const date = String(dates[i]).slice(0, 10);
    if (!date) continue;
    const { label, wet } = describeWeatherCode(Number(codes[i]));
    const hi = Number.isFinite(tmax[i]) ? Math.round(Number(tmax[i])) : null;
    const lo = Number.isFinite(tmin[i]) ? Math.round(Number(tmin[i])) : null;
    const p = Number.isFinite(pop[i]) ? Math.round(Number(pop[i])) : null;
    const u = Number.isFinite(uv[i]) ? Math.round(Number(uv[i])) : null;
    if (u != null) hasUv = true;
    const temp = hi != null && lo != null ? `, ${hi}°F/${lo}°F` : '';
    const precip = p != null ? `, ${p}% precip` : '';
    const uvStr = u != null ? `, UV ${u}` : '';
    // Air quality (Open-Meteo, free) — show the US AQI + label; poor air steers indoor like rain.
    const aqi = aqiByDate[date];
    const aqiStr = Number.isFinite(aqi) ? `, AQI ${Math.round(aqi)} (${usAqiLabel(aqi)})` : '';
    if (aqiStr) hasAqi = true;
    const poorAir = Number.isFinite(aqi) && aqi >= 151;
    // Pollen (Google Pollen API) — only surface when High/Very High (the actionable, allergy days).
    const pollen = pollenByDate[date];
    const pollenHigh = !!pollen && /high/i.test(pollen.category);
    const pollenStr = pollenHigh ? `, ${pollen!.label} pollen ${pollen!.category}` : '';
    if (pollenHigh) hasHighPollen = true;
    // Wet code, a high precipitation chance, OR unhealthy air → steer indoor.
    const hint = wet || (p != null && p >= 50) || poorAir ? 'prefer indoor' : 'good for outdoor';
    lines.push(`- ${weekdayOf(date)} ${date}: ${label}${temp}${precip}${uvStr}${aqiStr}${pollenStr} → ${hint}`);
  }
  if (!lines.length) return '';
  // Sanitize the (client-supplied) label before it lands in the prompt: strip newlines and cap
  // length so it can't break out of the WEATHER FACTS block / inject instructions.
  const safeLabel = (String(homeLabel || '').replace(/[\r\n]+/g, ' ').trim() || 'home').slice(0, 80);
  return [
    `WEATHER FACTS (authoritative forecast for ${safeLabel}; use to pick indoor vs outdoor AND for kid-safety tips (sun, air quality, pollen) — do NOT guess):`,
    ...lines,
    ...(hasUv ? ['UV index scale: 0–2 low, 3–5 moderate, 6–7 high, 8–10 very high, 11+ extreme.'] : []),
    ...(hasAqi ? ['US AQI: 0–50 good, 51–100 moderate, 101–150 limit prolonged/strenuous outdoor play (esp. kids), 151+ keep activities indoor.'] : []),
    ...(hasHighPollen ? ['High/Very High pollen → bring allergy meds; consider indoor for allergy-sensitive kids.'] : []),
    "If a date isn't listed, you don't have its forecast — say so rather than guessing.",
  ].join('\n');
}

// One-line TODAY weather + air-quality summary for the daily-briefing EMAIL (the in-app card carries the full
// multi-day forecast; the email just needs today's). Returns '' when there's no forecast for today. Reuses the
// same describeWeatherCode / usAqiLabel the WEATHER FACTS block uses, so the wording matches.
export function buildBriefingWeather(
  daily: DailyForecast | null | undefined,
  aqiByDate: Record<string, number> | undefined,
  today: string,
): string {
  const dates = Array.isArray(daily?.time) ? daily!.time : [];
  const i = dates.findIndex(d => String(d).slice(0, 10) === today);
  if (i < 0) return '';
  const { label } = describeWeatherCode(Number((daily!.weather_code || [])[i]));
  const hi = Number((daily!.temperature_2m_max || [])[i]);
  const lo = Number((daily!.temperature_2m_min || [])[i]);
  const p = Number((daily!.precipitation_probability_max || [])[i]);
  const temp = Number.isFinite(hi) && Number.isFinite(lo) ? `, ${Math.round(hi)}°/${Math.round(lo)}°F` : '';
  const precip = Number.isFinite(p) && p > 0 ? `, ${Math.round(p)}% precip` : '';
  const aqi = (aqiByDate || {})[today];
  const aqiStr = Number.isFinite(aqi) ? ` · AQI ${Math.round(aqi)} (${usAqiLabel(aqi)})` : '';
  return `🌤 Weather: ${label}${temp}${precip}${aqiStr}`;
}

// Heuristic: does this query call for weather-grounded planning (worth fetching the forecast) vs a
// direct lookup that doesn't ("what's on tomorrow?")? Errs toward true on uncertainty since the
// fetch is cached and cheap. Used to skip pointless fetches/latency on non-planning queries (D9).
// Stems (no trailing boundary) so inflections match too: "plan"→planning, "activit"→activities,
// "rain"→raining, "hik"→hike/hiking.
const PLANNING_RE = /\b(plan|free|weekend|weeknight|outing|activit|hik|park|beach|trip|zoo|museum|aquarium|weather|rain|snow|sunny|outdoor|outside|indoor|fun|suggest|recommend|idea|where can|what (?:can|should|to)|things to do|go out)/i;
export function isPlanningQuery(prompt: string): boolean {
  return PLANNING_RE.test(String(prompt || ''));
}
