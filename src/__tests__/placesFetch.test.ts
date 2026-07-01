import { describe, it, expect, vi, afterEach } from 'vitest';
import { findPlaces } from '../utils/placesFetch';

// Mock fetch by endpoint: Google Places Text Search → venues; Distance Matrix → drive times.
function mockGoogle() {
  return vi.spyOn(globalThis, 'fetch' as any).mockImplementation((url: any) => {
    const u = String(url);
    if (u.includes('places:searchText') || u.includes('places:searchNearby')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        places: [{
          displayName: { text: 'Woodland Park Zoo' }, types: ['zoo'], rating: 4.7, userRatingCount: 9000,
          location: { latitude: 47.6685, longitude: -122.3543 },
          googleMapsUri: 'https://maps.google.com/?cid=1', websiteUri: 'https://www.zoo.org',
        }],
      }) } as any);
    }
    if (u.includes('distancematrix')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({
        rows: [{ elements: [{ status: 'OK', duration: { value: 900 }, distance: { value: 16093 } }] }],
      }) } as any);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
  });
}

describe('placesFetch.findPlaces', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('returns real venues with the official URL and a drive time (Google path)', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    mockGoogle();
    const { places, destinationResolved } = await findPlaces(47.6163, -122.0356, 'zoo unique-query-1');
    expect(places.length).toBe(1);
    expect(places[0].name).toBe('Woodland Park Zoo');
    expect(places[0].url).toBe('https://www.zoo.org');   // official site (the "plan a visit" page), not a search
    expect(places[0].driveMinutes).toBe(15);             // 900s → 15 min
    expect(destinationResolved).toBe(true);              // no destination requested → home search "resolves"
  });

  it('returns [] (no throw) when every source fails', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch' as any).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as any);
    const { places } = await findPlaces(47.6163, -122.0356, 'zoo unique-query-2');
    expect(places).toEqual([]);
  });

  it('with a destination, geocodes it then searches AROUND it — drive time is still from home', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation((url: any, init: any) => {
      const u = String(url);
      if (u.includes('places:searchText')) {
        if (init?.body) bodies.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          places: [{
            displayName: { text: 'Paradise Inn' }, types: ['lodging'], rating: 4.5, userRatingCount: 1200,
            location: { latitude: 46.7857, longitude: -121.7363 },               // Mt Rainier (~90 mi from home)
            googleMapsUri: 'https://maps.google.com/?cid=2', websiteUri: 'https://www.mtrainierguestservices.com',
          }],
        }) } as any);
      }
      if (u.includes('distancematrix')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          rows: [{ elements: [{ status: 'OK', duration: { value: 8100 }, distance: { value: 152000 } }] }],
        }) } as any);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
    });
    const { places, destinationResolved } = await findPlaces(47.6163, -122.0356, 'lodge hotel unique-dest-1', 6, 'Mount Rainier National Park');
    // The destination was geocoded first (a single-result Text Search for the destination NAME)…
    expect(bodies.some(b => b.textQuery === 'Mount Rainier National Park' && b.maxResultCount === 1)).toBe(true);
    // …then venues were searched and the drive time was measured home → venue (8100s → 135 min).
    expect(places.length).toBe(1);
    expect(places[0].name).toBe('Paradise Inn');
    expect(places[0].driveMinutes).toBe(135);
    expect(destinationResolved).toBe(true);
  });

  it('a destination that fails to geocode → destinationResolved=false (falls back to a home search)', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    // Geocode (single-result Text Search) returns NO places; the venue search returns one home-area place.
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation((url: any, init: any) => {
      const u = String(url);
      if (u.includes('places:searchText')) {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.maxResultCount === 1) return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) } as any); // geocode MISS
        return Promise.resolve({ ok: true, status: 200, json: async () => ({
          places: [{ displayName: { text: 'Local Cafe' }, types: ['cafe'], location: { latitude: 47.6, longitude: -122.0 }, websiteUri: 'https://x.example' }],
        }) } as any);
      }
      if (u.includes('nominatim')) return Promise.resolve({ ok: true, status: 200, json: async () => ([]) } as any); // keyless fallback also misses
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
    });
    const { places, destinationResolved } = await findPlaces(47.6163, -122.0356, 'lodge unique-miss-1', 6, 'Nowhere Imaginary Place');
    expect(destinationResolved).toBe(false);  // the caller must NOT label these "around Nowhere Imaginary Place"
    expect(places.length).toBe(1);            // still returns the home-area fallback venues
  });

  it('without a destination, never issues a geocode (single-result) Text Search', async () => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
    const bodies: any[] = [];
    vi.spyOn(globalThis, 'fetch' as any).mockImplementation((url: any, init: any) => {
      const u = String(url);
      if (u.includes('places:searchText')) {
        if (init?.body) bodies.push(JSON.parse(init.body));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ places: [] }) } as any);
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
    });
    await findPlaces(47.6163, -122.0356, 'zoo unique-query-3');
    expect(bodies.every(b => b.maxResultCount !== 1)).toBe(true); // no geocode step on the home path
  });
});
