// Pure web-cache logic (src/utils/webCache.ts): URL normalization, hashing, the 7-day TTL, the honest
// "as of <date> (cached)" framing, and the pack/unpack of a fetched page into one storage row. The I/O
// halves (persistence.ts / sqlite.ts) are thin over these — the invariants live here.
import { describe, it, expect } from 'vitest';
import {
  normalizeWebUrl, webUrlHash, isCacheFresh, cachedFraming, packCachedPage, unpackCachedPage,
  WEB_CACHE_TTL_MS, WEB_CACHE_TEXT_CAP, WEB_CACHE_LINK_CAP,
} from '../utils/webCache';

describe('webCache — normalizeWebUrl (one row per page, not per spelling)', () => {
  it('lowercases scheme + host but PRESERVES path case (paths are case-sensitive)', () => {
    expect(normalizeWebUrl('HTTPS://Example.COM/Visit/Hours')).toBe('https://example.com/Visit/Hours');
  });

  it('strips the default port, keeps a real one', () => {
    expect(normalizeWebUrl('https://zoo.org:443/hours')).toBe('https://zoo.org/hours');
    expect(normalizeWebUrl('http://zoo.org:80/hours')).toBe('http://zoo.org/hours');
    expect(normalizeWebUrl('http://zoo.org:8080/hours')).toBe('http://zoo.org:8080/hours');
  });

  it('drops the #fragment (never sent to the server — same fetched content)', () => {
    expect(normalizeWebUrl('https://zoo.org/hours#today')).toBe(normalizeWebUrl('https://zoo.org/hours'));
  });

  it('collapses a trailing slash on a non-root path; root stays canonical', () => {
    expect(normalizeWebUrl('https://zoo.org/hours/')).toBe(normalizeWebUrl('https://zoo.org/hours'));
    // Both bare-origin spellings share the canonical root form.
    expect(normalizeWebUrl('https://zoo.org')).toBe(normalizeWebUrl('https://zoo.org/'));
  });

  it('KEEPS the query string — it selects content, so it must stay part of the identity', () => {
    expect(normalizeWebUrl('https://zoo.org/tickets?day=sat&kids=2')).toBe('https://zoo.org/tickets?day=sat&kids=2');
    expect(normalizeWebUrl('https://zoo.org/tickets?day=sat')).not.toBe(normalizeWebUrl('https://zoo.org/tickets?day=sun'));
  });

  it('returns null for non-http(s) / unparseable input (uncacheable, never a throw)', () => {
    expect(normalizeWebUrl('not a url')).toBeNull();
    expect(normalizeWebUrl('ftp://zoo.org/file')).toBeNull();
    expect(normalizeWebUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeWebUrl('')).toBeNull();
  });
});

describe('webCache — webUrlHash', () => {
  it('is a stable sha256 hex, equal exactly when the normalized urls are', () => {
    const a = webUrlHash(normalizeWebUrl('HTTPS://Zoo.org/hours/#x')!);
    const b = webUrlHash(normalizeWebUrl('https://zoo.org/hours')!);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(webUrlHash('https://zoo.org/tickets')).not.toBe(b);
  });
});

describe('webCache — isCacheFresh (7-day TTL, enforced on read)', () => {
  const fetched = '2026-06-30T12:00:00.000Z';
  const fetchedMs = Date.parse(fetched);

  it('fresh strictly inside the TTL, stale at and past the boundary', () => {
    expect(isCacheFresh(fetched, fetchedMs + WEB_CACHE_TTL_MS - 1)).toBe(true);
    expect(isCacheFresh(fetched, fetchedMs + WEB_CACHE_TTL_MS)).toBe(false);     // exactly 7d old → stale
    expect(isCacheFresh(fetched, fetchedMs + WEB_CACHE_TTL_MS + 60_000)).toBe(false);
  });

  it('treats a garbage/absent date as stale (a corrupt row can never be served)', () => {
    expect(isCacheFresh('not-a-date', fetchedMs)).toBe(false);
    expect(isCacheFresh('', fetchedMs)).toBe(false);
  });
});

describe('webCache — cachedFraming (honest dated presentation)', () => {
  it('carries the fetch DATE, the cached marker, and the verify-live steer', () => {
    const s = cachedFraming('2026-06-30T12:34:56.000Z');
    expect(s).toContain('as of 2026-06-30');
    expect(s).toContain('(cached)');
    expect(s).toContain('verify live');
  });

  it('degrades honestly on a garbage date instead of inventing one', () => {
    expect(cachedFraming('nope')).toContain('an earlier date');
  });
});

describe('webCache — packCachedPage / unpackCachedPage (the storage row)', () => {
  const page = { text: 'Zoo hours: 9–5 daily.', links: [{ text: 'Reserve', href: 'https://zoo.org/reserve' }] };

  it('round-trips text + links', () => {
    expect(unpackCachedPage(packCachedPage(page))).toEqual(page);
  });

  it('clamps oversized text and caps the link list at the storage boundary', () => {
    const big = {
      text: 'x'.repeat(WEB_CACHE_TEXT_CAP + 5000),
      links: Array.from({ length: WEB_CACHE_LINK_CAP + 10 }, (_, i) => ({ text: `l${i}`, href: `https://z.org/${i}` })),
    };
    const out = unpackCachedPage(packCachedPage(big))!;
    expect(out.text.length).toBe(WEB_CACHE_TEXT_CAP);
    expect(out.links.length).toBe(WEB_CACHE_LINK_CAP);
  });

  it('drops href-less links on pack, and coerces a missing link text on unpack', () => {
    const out = unpackCachedPage(packCachedPage({ text: 't', links: [{ text: 'dead', href: '' }, { text: '', href: 'https://z.org' }] }))!;
    expect(out.links).toEqual([{ text: '', href: 'https://z.org' }]);
  });

  it('unpack returns null on garbage / wrong shapes (a corrupt row degrades to a live fetch)', () => {
    expect(unpackCachedPage('not json')).toBeNull();
    expect(unpackCachedPage('"a string"')).toBeNull();
    expect(unpackCachedPage(JSON.stringify({ text: 42, links: [] }))).toBeNull();
    expect(unpackCachedPage(JSON.stringify({ text: 'ok', links: 'nope' }))).toBeNull();
  });
});
