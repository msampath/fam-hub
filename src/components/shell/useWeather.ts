import { useEffect, useState } from 'react';
import { fetchWeather, type WeatherNow } from '../../utils/weatherClient';

const TTL_MS = 10 * 60 * 1000;       // weather changes slowly — 10 min cache
const REFRESH_MS = 15 * 60 * 1000;   // background refresh for the always-on display

const cache = new Map<string, { at: number; data: WeatherNow }>();

/**
 * Live weather for a home location (spec §7). Returns null until the first fetch resolves, or if no
 * home is set / the fetch fails. Cached per-coordinate with a 10-min TTL and refreshed every 15 min
 * so the kitchen display stays current without hammering Open-Meteo. Cancels in-flight on unmount.
 */
export function useWeather(lat?: number, lng?: number): WeatherNow | null {
  const key = lat != null && lng != null ? `${lat.toFixed(3)},${lng.toFixed(3)}` : '';
  const [weather, setWeather] = useState<WeatherNow | null>(() => {
    const c = key ? cache.get(key) : null;
    return c && Date.now() - c.at < TTL_MS ? c.data : null; // honor the TTL on the initial seed too, not just the effect
  });

  useEffect(() => {
    if (!key || lat == null || lng == null) { setWeather(null); return; }

    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < TTL_MS) {
      setWeather(cached.data);
      return;
    }

    const ctrl = new AbortController();
    let active = true;
    const load = async () => {
      // Consult the cache before every fetch (incl. the interval ticks): if another hook instance for the same
      // coords (DarkShell + TodayPage mount concurrently) already refreshed within the TTL, reuse it instead of
      // re-hitting Open-Meteo.
      const c = cache.get(key);
      if (c && Date.now() - c.at < TTL_MS) { setWeather(c.data); return; }
      const data = await fetchWeather(lat, lng, ctrl.signal);
      if (!active) return;
      if (data) { cache.set(key, { at: Date.now(), data }); setWeather(data); }
    };
    load();
    const iv = setInterval(load, REFRESH_MS);
    return () => { active = false; ctrl.abort(); clearInterval(iv); };
  }, [key, lat, lng]);

  return weather;
}
