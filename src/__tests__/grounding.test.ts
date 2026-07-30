import { describe, it, expect, vi, beforeEach } from 'vitest';

// groundingAdmin (src/server/grounding.ts) is computed at module load — the service-role key must be
// present and LOCAL_MODE false BEFORE the module is imported below, so it initializes the cloud path.
// Plain top-level statements run AFTER hoisted static imports (ES module semantics), so a bare
// `process.env.X = ...` here would be too late — vi.hoisted runs before those imports, like vi.mock.
vi.hoisted(() => { process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'; });

vi.mock('../server/config', () => ({
  LOCAL_MODE: false,
  SUPABASE_URL: 'https://example.supabase.co',
}));

const cacheRow: { current: { value: unknown; fetched_at: string } | null } = { current: null };

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cacheRow.current }) }) }),
      upsert: async (row: { cache_key: string; value: unknown; fetched_at: string }) => {
        cacheRow.current = { value: row.value, fetched_at: row.fetched_at };
        return { data: null, error: null };
      },
    }),
  }),
}));

import { fetchWeatherDaily } from '../server/grounding';

describe('grounding.ts shared cache (cloud mode — groundingAdmin backed by grounding_cache)', () => {
  beforeEach(() => { cacheRow.current = null; });

  it('cache miss: fetches live and writes the result through to the shared store', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ daily: { temperature_2m_max: [70] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const daily = await fetchWeatherDaily(47.62, -122.35);
      expect(daily).toEqual({ temperature_2m_max: [70] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cacheRow.current?.value).toEqual({ temperature_2m_max: [70] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cache hit (fresh row): skips the external API call entirely', async () => {
    cacheRow.current = { value: { temperature_2m_max: [55] }, fetched_at: new Date().toISOString() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const daily = await fetchWeatherDaily(47.62, -122.35);
      expect(daily).toEqual({ temperature_2m_max: [55] });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cache hit (stale row past the TTL): treats it as a miss and re-fetches', async () => {
    cacheRow.current = { value: { temperature_2m_max: [40] }, fetched_at: new Date(Date.now() - 4 * 3600_000).toISOString() }; // WEATHER_TTL_MS is 3h
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ daily: { temperature_2m_max: [80] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const daily = await fetchWeatherDaily(47.62, -122.35);
      expect(daily).toEqual({ temperature_2m_max: [80] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
