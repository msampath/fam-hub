// Keyless client-side weather for the Today card + idle screensaver (spec §7). Open-Meteo needs no
// API key and allows browser CORS. We reuse the PURE parsers from weatherFacts.ts (the same engine
// the copilot's server-side WEATHER FACTS injection uses) so the two surfaces stay consistent.
import { describeWeatherCode, usAqiLabel, dailyMaxFromHourly } from './weatherFacts';
import { C } from '../components/shell/theme';

export interface WeatherNow {
  tempF: number | null;
  condition: string;       // describeWeatherCode label, e.g. "Partly cloudy"
  wet: boolean;
  uv: number | null;
  aqi: number | null;
  precipPct: number | null;
  precipType: string;      // '', 'drizzle', 'light', 'moderate', 'heavy', 'snow', 'sleet'
}

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';

async function getJson(url: string, signal?: AbortSignal): Promise<any | null> {
  try {
    const r = await fetch(url, { signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// Coarse precipitation TYPE from the WMO code (spec §7 vocabulary). Empty when dry.
function precipTypeFromCode(code: number): string {
  const { label, wet } = describeWeatherCode(code);
  if (!wet) return '';
  const l = label.toLowerCase();
  if (l.includes('snow')) return 'snow';
  if (l.includes('freezing')) return 'sleet';
  if (l.includes('drizzle')) return 'drizzle';
  if (l.includes('heavy')) return 'heavy';
  if (l.includes('light')) return 'light';
  return 'moderate';
}

// Fetch current conditions + today's UV / precip-chance / AQI for a home location.
export async function fetchWeather(lat: number, lng: number, signal?: AbortSignal): Promise<WeatherNow | null> {
  const fUrl = `${FORECAST}?latitude=${lat}&longitude=${lng}`
    + `&current=temperature_2m,weather_code`
    + `&daily=uv_index_max,precipitation_probability_max`
    + `&temperature_unit=fahrenheit&timezone=auto&forecast_days=1`;
  const aUrl = `${AIR}?latitude=${lat}&longitude=${lng}&hourly=us_aqi&timezone=auto&forecast_days=1`;

  const [forecast, air] = await Promise.all([getJson(fUrl, signal), getJson(aUrl, signal)]);
  if (!forecast) return null;

  const code = Number(forecast?.current?.weather_code ?? NaN);
  const { label, wet } = describeWeatherCode(Number.isFinite(code) ? code : 0);
  const tRaw = Number(forecast?.current?.temperature_2m);
  const uvRaw = Number(forecast?.daily?.uv_index_max?.[0]);
  const popRaw = Number(forecast?.daily?.precipitation_probability_max?.[0]);

  let aqi: number | null = null;
  if (air?.hourly?.time && air?.hourly?.us_aqi) {
    const byDate = dailyMaxFromHourly(air.hourly.time, air.hourly.us_aqi);
    const today = Object.keys(byDate).sort()[0];
    if (today != null) aqi = Math.round(byDate[today]);
  }

  return {
    tempF: Number.isFinite(tRaw) ? Math.round(tRaw) : null,
    condition: label,
    wet,
    uv: Number.isFinite(uvRaw) ? Math.round(uvRaw) : null,
    aqi,
    precipPct: Number.isFinite(popRaw) ? Math.round(popRaw) : null,
    precipType: Number.isFinite(code) ? precipTypeFromCode(code) : '',
  };
}

// ── Color/label coding (spec §7) ── shared by the Today card and the screensaver chips.
export function aqiLabel(aqi: number): string {
  return usAqiLabel(aqi);
}
export function aqiColor(aqi: number): string {
  if (aqi <= 50) return C.emerald;
  if (aqi <= 100) return C.amber;
  if (aqi <= 150) return C.orange;
  return C.red;
}
export function uvLabel(uv: number): string {
  if (uv <= 2) return 'Low';
  if (uv <= 5) return 'Moderate';
  if (uv <= 7) return 'High';
  if (uv <= 10) return 'Very High';
  return 'Extreme';
}
export function uvColor(uv: number): string {
  if (uv <= 2) return C.emerald;
  if (uv <= 5) return C.amber;
  if (uv <= 7) return C.orange;
  if (uv <= 10) return C.red;
  return C.purple;
}
