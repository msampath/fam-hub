// Web research grounding for the concierge (agentic upgrade A1). Two capabilities behind one module:
//   - searchWeb(query): a provider CHAIN (Tavily → Google CSE → Brave → keyless DuckDuckGo-HTML), trying
//     each CONFIGURED provider in order and ending on the keyless scrape so it ALWAYS returns something.
//   - fetchPageText(url): SSRF-guarded fetch + HTML→text, capped, so the agent can read a result page.
// Server-side only — imported by the Express server (local copilot 2-phase) and the MCP server child
// (web_search / fetch_page tools). The SSRF guard is now the SHARED src/utils/ssrfGuard.ts (esbuild inlines it
// into the standalone MCP bundle), so server.ts and this module read the SAME guard and can't drift.
import net from 'node:net';
import { safeFetch } from './ssrfGuard';

export interface WebResult { title: string; url: string; snippet: string }
export interface WebSearchOutcome { provider: string; results: WebResult[] }

// (SSRF guard — isBlockedIp / assertSafeUrl / pinnedDispatcher / safeFetch — now lives in the shared
// src/utils/ssrfGuard.ts, imported above. One implementation for both server.ts and this module.)

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// ── HTML → readable text (mirrors server.ts cleanHTML, with a tighter cap for tool output) ──
export function htmlToText(html: string, cap = 20000): string {
  let s = html;
  s = s.replace(/<head[\s\S]*?<\/head>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<svg[\s\S]*?<\/svg>/gi, '');
  s = s.replace(/<\/(div|p|tr|h[1-6])>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '\n - ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"');
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return s.length > cap ? s.slice(0, cap) + '\n… [truncated]' : s;
}

// ── Providers (each returns [] on miss / not-configured / error — the chain moves on) ──
async function tavily(query: string, max: number): Promise<WebResult[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  const { signal, done } = withTimeout(8000);
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: max, search_depth: 'basic' }),
    });
    if (!r.ok) return [];
    const d: any = await r.json();
    return (Array.isArray(d?.results) ? d.results : []).map((x: any) => ({
      title: String(x.title || '').slice(0, 200), url: String(x.url || ''), snippet: String(x.content || '').slice(0, 500),
    })).filter((x: WebResult) => x.url);
  } catch { return []; } finally { done(); }
}

async function googleCse(query: string, max: number): Promise<WebResult[]> {
  const key = process.env.GOOGLE_CSE_KEY, cx = process.env.GOOGLE_CSE_ID;
  if (!key || !cx) return [];
  const { signal, done } = withTimeout(8000);
  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=${Math.min(max, 10)}&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { signal });
    if (!r.ok) return [];
    const d: any = await r.json();
    return (Array.isArray(d?.items) ? d.items : []).map((x: any) => ({
      title: String(x.title || '').slice(0, 200), url: String(x.link || ''), snippet: String(x.snippet || '').slice(0, 500),
    })).filter((x: WebResult) => x.url);
  } catch { return []; } finally { done(); }
}

async function brave(query: string, max: number): Promise<WebResult[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) return [];
  const { signal, done } = withTimeout(8000);
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?count=${Math.min(max, 10)}&q=${encodeURIComponent(query)}`;
    const r = await fetch(url, { signal, headers: { Accept: 'application/json', 'X-Subscription-Token': key } });
    if (!r.ok) return [];
    const d: any = await r.json();
    return (Array.isArray(d?.web?.results) ? d.web.results : []).map((x: any) => ({
      title: String(x.title || '').slice(0, 200), url: String(x.url || ''), snippet: String(x.description || '').slice(0, 500),
    })).filter((x: WebResult) => x.url);
  } catch { return []; } finally { done(); }
}

// Keyless fallback: scrape DuckDuckGo's HTML endpoint. Fragile by nature (no API contract), so it's purely
// best-effort — but it means web research works with ZERO keys configured. Pure parser is unit-tested.
export function parseDuckDuckGoHtml(html: string, max: number): WebResult[] {
  const out: WebResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    let url = m[1];
    // DDG wraps targets as /l/?uddg=<encoded> — unwrap to the real URL.
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) { try { url = decodeURIComponent(wrapped[1]); } catch { /* keep as-is */ } }
    if (url.startsWith('//')) url = 'https:' + url;
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (/^https?:\/\//i.test(url) && title) out.push({ title: title.slice(0, 200), url, snippet: '' });
  }
  return out;
}

async function duckduckgo(query: string, max: number): Promise<WebResult[]> {
  const { signal, done } = withTimeout(9000);
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FamilyHubConcierge/1.0)' },
    });
    if (!r.ok) return [];
    return parseDuckDuckGoHtml(await r.text(), max);
  } catch { return []; } finally { done(); }
}

// Run the provider chain: first provider to return ≥1 result wins. `provider` names who answered (or
// 'none' when even the keyless scrape came up empty) so callers/tests can see which tier responded.
export async function searchWeb(query: string, max = 5): Promise<WebSearchOutcome> {
  const q = (query || '').trim();
  if (!q) return { provider: 'none', results: [] };
  const chain: Array<[string, (query: string, max: number) => Promise<WebResult[]>]> = [
    ['tavily', tavily], ['google_cse', googleCse], ['brave', brave], ['duckduckgo', duckduckgo],
  ];
  for (const [name, fn] of chain) {
    const results = await fn(q, max);
    if (results.length) return { provider: name, results: results.slice(0, max) };
  }
  return { provider: 'none', results: [] };
}

// Fetch a page and return readable text (SSRF-guarded, capped). Throws on a blocked/invalid URL.
// A real browser UA — many venue/booking pages alter or gate their HTML for non-browser agents, so a
// bot-flagging UA gets less (or blocked). The link we need (a Yelp/OpenTable "Reserve" href) is in the
// browser HTML.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Registrable domain (eTLD+1 approximation) of a host — "book.venue.co.uk" → "venue.co.uk",
// "www.opentable.com" → "opentable.com". Used to tie handoff provenance to an ORIGIN the agent actually
// SEARCHED/FETCHED rather than to any link text on a page. NOTE: heuristic (last two labels + a short
// multi-part-TLD list), not the full Public Suffix List — good enough to gate same-site vs cross-site links.
const MULTIPART_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'co.jp', 'co.nz', 'co.in', 'com.au', 'com.br', 'co.za',
]);
export function registrableDomain(host: string): string | null {
  let h = (host || '').toLowerCase().trim().replace(/\.$/, '');
  if (!h) return null;
  if (net.isIP(h)) return h; // an IP literal is its own "domain"
  h = h.replace(/^www\./, '');
  const parts = h.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.') || null;
  const lastTwo = parts.slice(-2).join('.');
  return MULTIPART_TLDS.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

// Third-party booking platforms a venue legitimately links OUT to. A handoff link is trusted if it's on the
// SAME registrable domain as a page the agent fetched, OR on one of these. Any OTHER cross-domain href merely
// present in a fetched page (e.g. an attacker-planted phishing link) is NOT trusted just for appearing in HTML.
export const BOOKING_PROVIDERS = new Set([
  'opentable.com', 'resy.com', 'tock.com', 'exploretock.com', 'yelp.com',
  'eventbrite.com', 'ticketmaster.com', 'recreation.gov', 'sevenrooms.com',
]);
function hostOf(u: string): string { try { return new URL(u).hostname; } catch { return ''; } }
// From a page fetched at `pageUrl`, keep only the hrefs safe to make stageable for a handoff: same
// registrable domain as the page, or a known booking provider. This is the provenance-poisoning fix —
// a fetched page can no longer whitelist an arbitrary cross-domain link just by linking to it.
export function trustedBookingLinks(pageUrl: string, hrefs: string[]): string[] {
  const pageDomain = registrableDomain(hostOf(pageUrl));
  return (Array.isArray(hrefs) ? hrefs : []).filter(href => {
    const d = registrableDomain(hostOf(href));
    return !!d && (d === pageDomain || BOOKING_PROVIDERS.has(d));
  });
}

// Pull anchor links (absolute href + visible text) from raw HTML, booking-ish links first. fetch_page returns
// these so the agent can SEE a venue's published "Reserve"/"Book" link (Yelp/OpenTable/Resy/Tock) instead of a
// stripped text blob — and so the handoff gate can confirm a booking URL was actually published, not invented.
export function extractLinks(html: string, baseUrl: string, max = 40): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(html)) && guard++ < 2000) {
    const raw = (m[1] || '').trim();
    if (!raw || /^(#|javascript:|mailto:|tel:)/i.test(raw)) continue;
    let href: string;
    try { href = new URL(raw, baseUrl).toString(); } catch { continue; }
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = (m[2] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    out.push({ text, href });
  }
  const isBooking = (l: { text: string; href: string }) =>
    /reserv|book|opentable|resy|tock|yelp\.com\/reservation|ticket/i.test(`${l.href} ${l.text}`);
  return [...out.filter(isBooking), ...out.filter(l => !isBooking(l))].slice(0, max);
}

// Fetch a page as a browser: cleaned text PLUS its links. fetchPageText keeps the old text-only contract.
export async function fetchPage(url: string, cap = 20000): Promise<{ text: string; links: { text: string; href: string }[] }> {
  const { signal, done } = withTimeout(10000);
  try {
    const res = await safeFetch(url, { signal, headers: { 'User-Agent': BROWSER_UA } });
    if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    const isHtml = /html|xml|^$/i.test(ct) || body.includes('<');
    const text = /json/i.test(ct) ? body.slice(0, cap) : (isHtml ? htmlToText(body, cap) : body.slice(0, cap));
    const links = isHtml ? extractLinks(body, url) : [];
    return { text, links };
  } finally { done(); }
}

export async function fetchPageText(url: string, cap = 20000): Promise<string> {
  return (await fetchPage(url, cap)).text;
}
