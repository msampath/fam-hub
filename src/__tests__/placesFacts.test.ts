import { describe, it, expect } from 'vitest';
import { parseGooglePlaces, parseOverpassPlaces, buildPlacesFacts, indexedPlaces, parseDistanceConstraint, detectPlacesIntent, isPlacesQuery, flagHiddenGems, filterRecentlyVisited, filterKeylessPlacesByName, type Place } from '../utils/placesFacts';

describe('parseGooglePlaces', () => {
  it('normalizes name/category/rating/coords and skips entries missing a name or coords', () => {
    const json = {
      places: [
        { displayName: { text: 'Woodland Park Zoo' }, types: ['zoo', 'tourist_attraction'], rating: 4.6, location: { latitude: 47.66, longitude: -122.35 } },
        { displayName: { text: 'Pacific Science Center' }, types: ['science_museum', 'museum'], rating: 4.5, location: { latitude: 47.62, longitude: -122.35 } },
        { displayName: { text: '' }, types: ['park'], location: { latitude: 1, longitude: 2 } }, // no name → skip
        { displayName: { text: 'No coords' }, types: ['park'] },                                   // no coords → skip
      ],
    };
    const places = parseGooglePlaces(json);
    expect(places).toHaveLength(2);
    expect(places[0]).toMatchObject({ name: 'Woodland Park Zoo', category: 'zoo', rating: 4.6 });
    expect(places[1].category).toBe('science center'); // science_museum → friendly label
  });
  it('is null-safe', () => {
    expect(parseGooglePlaces(null)).toEqual([]);
    expect(parseGooglePlaces({})).toEqual([]);
  });
});

describe('parseOverpassPlaces', () => {
  it('keeps named venues, maps categories, ranks notable (wikidata) first, dedupes by name', () => {
    const json = {
      elements: [
        { type: 'node', lat: 47.66, lon: -122.35, tags: { name: 'Woodland Park Zoo', tourism: 'zoo', wikidata: 'Q123' } },
        { type: 'way', center: { lat: 47.5, lon: -122.2 }, tags: { name: 'Marymoor Park', leisure: 'park' } },
        { type: 'node', lat: 1, lon: 2, tags: { tourism: 'museum' } },                            // no name → skip
        { type: 'node', lat: 47.66, lon: -122.35, tags: { name: 'Woodland Park Zoo', tourism: 'zoo' } }, // dup → skip
      ],
    };
    const places = parseOverpassPlaces(json);
    expect(places.map(p => p.name)).toEqual(['Woodland Park Zoo', 'Marymoor Park']); // notable first
    expect(places[0]).toMatchObject({ category: 'zoo', notable: true });
    expect(places[1]).toMatchObject({ category: 'park', notable: false });
  });
});

describe('buildPlacesFacts', () => {
  it('formats venues with rating + drive time and an authoritative header', () => {
    const block = buildPlacesFacts('Sammamish, WA', [
      { name: 'Woodland Park Zoo', category: 'zoo', lat: 0, lng: 0, rating: 4.6, driveMinutes: 15, driveMiles: 8 },
      { name: 'Marymoor Park', category: 'park', lat: 0, lng: 0 },
    ]);
    expect(block).toMatch(/^PLACES FACTS/);
    expect(block).toContain('recommend ONLY venues from THIS list');
    expect(block).toContain('- [P1] Woodland Park Zoo (zoo, 4.6★) — ~15 min drive (8 mi)');
    expect(block).toContain('- [P2] Marymoor Park (park)'); // no rating/drive → bare; [P#] id tags every line
  });
  it('returns "" when there are no places', () => {
    expect(buildPlacesFacts('home', [])).toBe('');
  });
  it('reflects a distance constraint in the header when withinMiles is given', () => {
    const block = buildPlacesFacts('Sammamish, WA', [
      { name: 'Pine Lake Park', category: 'park', lat: 0, lng: 0, driveMinutes: 8, driveMiles: 4 },
    ], 10, { withinMiles: 6 });
    expect(block).toContain('within ~6 miles of Sammamish, WA (closest first)');
  });
  it('reflects a drive-time constraint in the header when withinMinutes is given', () => {
    const block = buildPlacesFacts('Sammamish, WA', [
      { name: 'Pine Lake Park', category: 'park', lat: 0, lng: 0, driveMinutes: 8, driveMiles: 4 },
    ], 10, { withinMinutes: 20 });
    expect(block).toContain("within ~20 minutes' drive of Sammamish, WA (closest first)");
  });
});

describe('parseDistanceConstraint', () => {
  it('extracts an explicit mile limit (range → upper bound)', () => {
    expect(parseDistanceConstraint('Is there something within 5-6 mi of Sammamish?')).toEqual({ maxMiles: 6 });
    expect(parseDistanceConstraint('anything within 3 miles?')).toEqual({ maxMiles: 3 });
    expect(parseDistanceConstraint('places 10 to 12 miles away')).toEqual({ maxMiles: 12 });
  });
  it('maps vague proximity phrases to a default radius', () => {
    expect(parseDistanceConstraint('something fun near me')).toEqual({ maxMiles: 10 });
    expect(parseDistanceConstraint('a coffee shop within walking distance')).toEqual({ maxMiles: 2 });
    expect(parseDistanceConstraint('close by please')).toEqual({ maxMiles: 10 });
  });
  it('returns null for open-ended queries (keeps the marquee/popularity list)', () => {
    expect(parseDistanceConstraint('what should we do this weekend?')).toBeNull();
    expect(parseDistanceConstraint('ideas for tomorrow')).toBeNull();
  });
  it('does not match bare numbers without a mile unit (e.g. years, counts)', () => {
    expect(parseDistanceConstraint('give me 4 ideas for 2026')).toBeNull();
    expect(parseDistanceConstraint('plans for the next 12 days')).toBeNull();
  });
  it('extracts a DRIVE-TIME limit (minutes / half-hour; range → upper bound)', () => {
    expect(parseDistanceConstraint('anything within 20 minutes?')).toEqual({ maxMinutes: 20 });
    expect(parseDistanceConstraint('a 30 min drive is fine')).toEqual({ maxMinutes: 30 });
    expect(parseDistanceConstraint('somewhere a half-hour away')).toEqual({ maxMinutes: 30 });
    expect(parseDistanceConstraint('15-20 minutes out')).toEqual({ maxMinutes: 20 });
  });
  it('prefers miles when both a mile and minute unit appear', () => {
    expect(parseDistanceConstraint('within 5 miles, say 15 minutes')).toEqual({ maxMiles: 5 });
  });
  it('does not read "20 minutes" as 20 miles', () => {
    expect(parseDistanceConstraint('within 20 minutes')).toEqual({ maxMinutes: 20 });
  });
});

describe('detectPlacesIntent', () => {
  it('maps coffee / cafe to a coffee-shop Text Search', () => {
    expect(detectPlacesIntent('know a new coffee shop to try?')).toEqual({ textQuery: 'coffee shop' });
    expect(detectPlacesIntent('somewhere for an espresso')).toEqual({ textQuery: 'coffee shop' });
  });
  it('maps a cuisine to a "<cuisine> restaurant" query', () => {
    expect(detectPlacesIntent('a different vegan restaurant nearby')).toEqual({ textQuery: 'vegan restaurant' });
    expect(detectPlacesIntent('craving thai tonight')).toEqual({ textQuery: 'thai restaurant' });
  });
  it('maps generic dining words to "restaurant", and bakery/brunch to their own', () => {
    expect(detectPlacesIntent('where should we eat dinner?')).toEqual({ textQuery: 'restaurant' });
    expect(detectPlacesIntent('a good brunch place')).toEqual({ textQuery: 'brunch spot' });
    expect(detectPlacesIntent('best bakery for cupcakes')).toEqual({ textQuery: 'bakery and dessert' });
  });
  it('returns null for non-food queries (keeps the family Nearby Search)', () => {
    expect(detectPlacesIntent('what should we do with the kids tomorrow?')).toBeNull();
    expect(detectPlacesIntent('any parks within 5 miles?')).toBeNull();
  });
});

describe('isPlacesQuery (grounding gate for proximity/food queries that miss isPlanningQuery)', () => {
  it('is true for proximity / drive-time / food queries', () => {
    expect(isPlacesQuery('give me something in a 15 min drive away')).toBe(true); // the reported bug
    expect(isPlacesQuery('a vegan restaurant within 20 minutes')).toBe(true);
    expect(isPlacesQuery('coffee shop near me')).toBe(true);
    expect(isPlacesQuery('anything within 5 miles?')).toBe(true);
  });
  it('is false for non-place queries (those rely on isPlanningQuery instead)', () => {
    expect(isPlacesQuery("what's on my calendar tomorrow?")).toBe(false);
    expect(isPlacesQuery('mark the laundry chore done')).toBe(false);
  });
});

describe('flagHiddenGems', () => {
  const p = (over: Partial<Place> & { name: string }): Place => ({ category: 'cafe', lat: 0, lng: 0, ...over });
  it('flags highly-rated venues with a modest review count', () => {
    const out = flagHiddenGems([
      p({ name: 'New Cafe', rating: 4.7, userRatingCount: 80 }),     // gem
      p({ name: 'Institution', rating: 4.7, userRatingCount: 50000 }), // too popular
      p({ name: 'Mediocre', rating: 3.5, userRatingCount: 60 }),     // rating too low
      p({ name: 'Brand New', rating: 4.8, userRatingCount: 3 }),     // too few reviews
    ]);
    expect(out.map(x => x.gem)).toEqual([true, false, false, false]);
  });
});

describe('filterRecentlyVisited', () => {
  const p = (name: string): Place => ({ name, category: 'restaurant', lat: 0, lng: 0 });
  it('drops venues whose name matches a recent visit (case-insensitive)', () => {
    const out = filterRecentlyVisited(
      [p('Araya\'s Place'), p('Plum Bistro'), p('Cafe Flora')],
      [{ label: 'araya\'s place', lastVisited: '2026-06-01' }],
      '2026-06-19',
    );
    expect(out.map(x => x.name)).toEqual(['Plum Bistro', 'Cafe Flora']);
  });
  it('keeps venues visited longer ago than the window', () => {
    const out = filterRecentlyVisited([p('Plum Bistro')], [{ label: 'Plum Bistro', lastVisited: '2025-01-01' }], '2026-06-19', 90);
    expect(out.map(x => x.name)).toEqual(['Plum Bistro']);
  });
  it('is a no-op with an empty visit log', () => {
    expect(filterRecentlyVisited([p('X')], [], '2026-06-19').map(x => x.name)).toEqual(['X']);
  });
});

describe('buildPlacesFacts — gems', () => {
  it('tags gems, shows their review count, and adds the creative-pick note', () => {
    const block = buildPlacesFacts('Sammamish, WA', [
      { name: 'Hidden Bean', category: 'coffee shop', lat: 0, lng: 0, rating: 4.7, userRatingCount: 90, gem: true, driveMinutes: 6, driveMiles: 3 },
      { name: 'Big Chain', category: 'coffee shop', lat: 0, lng: 0, rating: 4.1, userRatingCount: 9000 },
    ]);
    expect(block).toContain('- [P1] Hidden Bean (coffee shop, 4.7★ (90 reviews)) — ~6 min drive (3 mi) · lesser-known gem');
    expect(block).toContain("Venues marked 'lesser-known gem'");
    expect(block).toContain('- [P2] Big Chain (coffee shop, 4.1★)'); // non-gem: no review count, no tag
  });
});

describe('place URLs + ids (honest links, never model-written)', () => {
  it('parseGooglePlaces prefers websiteUri, falls back to googleMapsUri', () => {
    const json = {
      places: [
        { displayName: { text: 'Has Site' }, types: ['museum'], location: { latitude: 47, longitude: -122 }, websiteUri: 'https://museum.example', googleMapsUri: 'https://maps.google/?cid=1' },
        { displayName: { text: 'Maps Only' }, types: ['park'], location: { latitude: 47, longitude: -122 }, googleMapsUri: 'https://maps.google/?cid=2' },
        { displayName: { text: 'No Links' }, types: ['zoo'], location: { latitude: 47.6, longitude: -122.3 } },
      ],
    };
    const [a, b, c] = parseGooglePlaces(json);
    expect(a.url).toBe('https://museum.example');           // official site wins
    expect(b.url).toBe('https://maps.google/?cid=2');        // else the Maps URL
    expect(c.url).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/.*No%20Links/); // else a built Maps link
  });

  it('parseOverpassPlaces uses the OSM website tag, else a Google Maps link (no link-less place)', () => {
    const json = {
      elements: [
        { type: 'node', lat: 47.66, lon: -122.35, tags: { name: 'Tagged Site', leisure: 'park', website: 'https://park.example' } },
        { type: 'node', lat: 47.5, lon: -122.2, tags: { name: 'No Website', leisure: 'park' } },
      ],
    };
    const places = parseOverpassPlaces(json);
    const byName = Object.fromEntries(places.map(p => [p.name, p.url]));
    expect(byName['Tagged Site']).toBe('https://park.example');
    expect(byName['No Website']).toMatch(/^https:\/\/www\.google\.com\/maps\/search\/.*No%20Website/);
  });

  it('indexedPlaces tags P1..Pn in order, capped, name-filtered', () => {
    const idx = indexedPlaces([
      { name: 'A', category: 'park', lat: 0, lng: 0 },
      { name: '', category: 'park', lat: 0, lng: 0 } as Place, // no name → skipped
      { name: 'B', category: 'zoo', lat: 0, lng: 0 },
    ], 10);
    expect(idx.map(x => [x.id, x.place.name])).toEqual([['P1', 'A'], ['P2', 'B']]);
  });
});

// Keyless-fallback honesty (Phase-3): Overpass is category-only, so a NAME ask must never come back
// as six arbitrary cafés dressed as a success — root-caused live 2026-07-05 ("The Pink Door").
describe('filterKeylessPlacesByName', () => {
  const cafes: Place[] = [
    { name: 'Din Tai Fung', category: 'restaurant', lat: 0, lng: 0 },
    { name: 'The Pink Door', category: 'restaurant', lat: 0, lng: 0 },
    { name: "Joe's Donuts", category: 'cafe', lat: 0, lng: 0 },
    { name: 'Random Coffee House', category: 'cafe', lat: 0, lng: 0 },
  ];

  it('pure category asks pass through untouched (every result IS a category match)', () => {
    for (const q of ['coffee shops', 'restaurants', 'places to eat', 'best cafes']) {
      const r = filterKeylessPlacesByName(cafes, q);
      expect(r.places).toHaveLength(4);
      expect(r.nameMiss).toBe(false);
    }
  });

  it('a name ask keeps ONLY name-matching venues', () => {
    const r = filterKeylessPlacesByName(cafes, 'din tai fung');
    expect(r.places.map(p => p.name)).toEqual(['Din Tai Fung']);
    expect(r.nameMiss).toBe(false);
    const pink = filterKeylessPlacesByName(cafes, 'the pink door restaurant');
    expect(pink.places.map(p => p.name)).toEqual(['The Pink Door']);
  });

  it('a name ask with NO matching venue returns empty + nameMiss (honest miss, not wrong success)', () => {
    const r = filterKeylessPlacesByName(cafes, 'canlis');
    expect(r.places).toHaveLength(0);
    expect(r.nameMiss).toBe(true);
  });

  it('cuisine-qualified asks filter on the qualifier (honest miss beats unrelated cafés)', () => {
    const r = filterKeylessPlacesByName(cafes, 'indian restaurants');
    expect(r.places).toHaveLength(0);
    expect(r.nameMiss).toBe(true);
  });

  it('empty/stopword-only queries pass through', () => {
    expect(filterKeylessPlacesByName(cafes, '').places).toHaveLength(4);
    expect(filterKeylessPlacesByName(cafes, 'the best').places).toHaveLength(4);
  });
});
