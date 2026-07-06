// Web-page cache for the concierge's fetch_page tool (roadmap "Web cache") — the PURE half: URL
// normalization, hashing, TTL, the honest "as of <date> (cached)" framing, and the pack/unpack of a
// fetched page into one storage row. The I/O half lives with the household storage seams — the
// `web_cache` table on both backends, read/written by src/mcp/persistence.ts (webCacheGet/webCachePut)
// — so this module stays unit-testable with zero mocks.
//
// Server-side only (node:crypto): imported by the Express server bundle and the MCP child bundle,
// never by the React client.
import { createHash } from 'node:crypto';

// 7-day TTL — enforced on READ (a stale row is simply ignored, so an expired page can never be served),
// with a best-effort prune on WRITE keeping the table from accumulating dead rows. There is no cron.
export const WEB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Storage clamps. fetchPage already caps its extracted text (20k chars) and links (40) — these re-clamp
// at the storage boundary so a future fetcher change can't silently start writing megabyte rows.
export const WEB_CACHE_TEXT_CAP = 20000;
export const WEB_CACHE_LINK_CAP = 40;

// Normalize a URL so trivially-different spellings of the same page share ONE cache row:
//   - lowercase scheme + host (the URL parser does this), strip the default port (:80 / :443)
//   - drop the #fragment (never sent to the server — it can't change the fetched content)
//   - collapse a trailing "/" on a non-root path ("…/hours/" ≡ "…/hours")
//   - KEEP the query string as-is (it selects content; reordering/stripping it would be a lie)
// Returns null for anything that isn't a parseable http(s) URL — callers treat that as "uncacheable".
export function normalizeWebUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

// Cache key: sha256 hex of the NORMALIZED url. Hashing (vs the raw url as key) keeps the primary key
// short/uniform and dodges any per-backend index-length or case-collation quirks.
export function webUrlHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex');
}

// Is a cached row still servable? `fetchedAtIso` comes back as an ISO-8601 string from both backends
// (Postgres timestamptz via PostgREST, and the ISO string SQLite stores). Garbage dates are stale.
export function isCacheFresh(fetchedAtIso: string, nowMs: number, ttlMs: number = WEB_CACHE_TTL_MS): boolean {
  const t = Date.parse(String(fetchedAtIso || ''));
  return Number.isFinite(t) && nowMs - t < ttlMs;
}

// Honest framing for a cache hit — the tool result message carries this so the agent presents cached
// facts as DATED, never as live ("as of 2026-07-01 (cached) — verify live if it matters").
export function cachedFraming(fetchedAtIso: string): string {
  const t = Date.parse(String(fetchedAtIso || ''));
  const day = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'an earlier date';
  return `as of ${day} (cached) — verify live if it matters`;
}

// What one cache row holds: the SAME { text, links } shape fetchPage returns. Links ride along
// deliberately — the handoff provenance gate needs a fetched page's published Reserve/Book links, and a
// text-only cache hit would silently break that flow (the agent has no "re-fetch live" variant).
export interface CachedPage { text: string; links: { text: string; href: string }[] }

// Serialize a fetched page into the `content` text column (clamped). The row stores the RAW extracted
// page — sanitizeForPrompt runs on READ in the tool handler (same as the live path), so a sanitizer
// improvement applies to old rows too.
export function packCachedPage(page: CachedPage): string {
  const text = String(page?.text ?? '').slice(0, WEB_CACHE_TEXT_CAP);
  const links = (Array.isArray(page?.links) ? page.links : [])
    .slice(0, WEB_CACHE_LINK_CAP)
    .map(l => ({ text: String(l?.text ?? '').slice(0, 120), href: String(l?.href ?? '') }))
    .filter(l => l.href);
  return JSON.stringify({ text, links });
}

// Parse a stored `content` value back into a page; null on any garbage (treated as a cache miss, so a
// corrupt row degrades to a live fetch — never to a broken tool result).
export function unpackCachedPage(content: string): CachedPage | null {
  try {
    const parsed = JSON.parse(String(content ?? ''));
    if (!parsed || typeof parsed.text !== 'string' || !Array.isArray(parsed.links)) return null;
    return {
      text: parsed.text,
      links: parsed.links
        .filter((l: any) => l && typeof l.href === 'string' && l.href)
        .map((l: any) => ({ text: typeof l.text === 'string' ? l.text : '', href: l.href })),
    };
  } catch { return null; }
}
