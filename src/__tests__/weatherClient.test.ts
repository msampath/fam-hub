import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWeather, aqiColor, aqiLabel, uvColor, uvLabel } from '../utils/weatherClient';

describe('weatherClient color/label coding (spec §7)', () => {
  it('buckets AQI into the right label + color', () => {
    expect(aqiLabel(40)).toBe('Good');
    expect(aqiColor(40)).toBe('#34d399');   // emerald
    expect(aqiColor(80)).toBe('#fbbf24');   // amber
    expect(aqiColor(130)).toBe('#fb923c');  // orange
    expect(aqiColor(180)).toBe('#f87171');  // red
  });

  it('buckets UV into the right label + color', () => {
    expect(uvLabel(1)).toBe('Low');
    expect(uvLabel(4)).toBe('Moderate');
    expect(uvLabel(6)).toBe('High');
    expect(uvLabel(9)).toBe('Very High');
    expect(uvLabel(12)).toBe('Extreme');
    expect(uvColor(6)).toBe('#fb923c');     // orange
    expect(uvColor(12)).toBe('#c084fc');    // purple
  });
});

describe('fetchWeather', () => {
  beforeEach(() => {
    global.fetch = vi.fn((url: string) => {
      const isAir = String(url).includes('air-quality');
      const body = isAir
        ? { hourly: { time: ['2026-06-23T00:00', '2026-06-23T01:00'], us_aqi: [40, 42] } }
        : { current: { temperature_2m: 72.4, weather_code: 2 }, daily: { uv_index_max: [6.2], precipitation_probability_max: [20] } };
      return Promise.resolve({ ok: true, json: async () => body }) as any;
    }) as any;
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('parses current conditions, daily UV/precip, and the day-max AQI', async () => {
    const w = await fetchWeather(47.6, -122.0);
    expect(w).not.toBeNull();
    expect(w!.tempF).toBe(72);          // rounded
    expect(w!.condition).toBe('Partly cloudy'); // WMO code 2
    expect(w!.uv).toBe(6);              // rounded
    expect(w!.precipPct).toBe(20);
    expect(w!.precipType).toBe('');     // code 2 is dry
    expect(w!.aqi).toBe(42);            // max of [40, 42]
  });

  it('returns null when the forecast request fails', async () => {
    global.fetch = vi.fn(() => Promise.resolve({ ok: false }) as any) as any;
    expect(await fetchWeather(47.6, -122.0)).toBeNull();
  });
});
