// Kroger API — pure builders/validators (step 1 of the cart integration). Everything here is
// side-effect-free and unit-tested; server.ts owns the actual HTTP. Two hard-won design facts:
//   · Kroger's fuzzy product search ranks frying PANS above paneer for "paneer" (verified live), so
//     term→first-result is unusable — matching is a schema-enforced LLM pick among shaped candidates,
//     validated here so a weak model can only ever select a REAL candidate index or none.
//   · Kroger's public API has NO checkout/payment endpoint — adding to the cart is the ceiling, so the
//     app's no-payment invariant holds by API contract, not just by our tool registry.
import { Type } from '@google/genai';

export const KROGER_API = 'https://api.kroger.com/v1';
export const KROGER_AUTH_SCOPES = 'cart.basic:write profile.compact';

// ── OAuth ────────────────────────────────────────────────────────────────────────────────────────

export function buildKrogerAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    scope: KROGER_AUTH_SCOPES, state,
  });
  return `${KROGER_API}/connect/oauth2/authorize?${q.toString()}`;
}

// Bodies for the three grant types (x-www-form-urlencoded strings).
export function authCodeTokenBody(code: string, redirectUri: string): string {
  return new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString();
}
export function refreshTokenBody(refreshToken: string): string {
  return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString();
}
export function clientCredentialsBody(scope: string): string {
  return new URLSearchParams({ grant_type: 'client_credentials', scope }).toString();
}

// ── Locations ────────────────────────────────────────────────────────────────────────────────────

export interface KrogerStore { locationId: string; chain: string; name: string; address: string }

export function shapeLocations(apiJson: any): KrogerStore[] {
  const rows = Array.isArray(apiJson?.data) ? apiJson.data : [];
  return rows.map((l: any) => ({
    locationId: String(l?.locationId || ''),
    chain: String(l?.chain || ''),
    name: String(l?.name || ''),
    address: [l?.address?.addressLine1, l?.address?.city].filter(Boolean).join(', '),
  })).filter((s: KrogerStore) => s.locationId && s.name);
}

// ── Store ↔ list bindings ────────────────────────────────────────────────────────────────────────

export type StoreBindings = Record<string, { locationId: string; name: string }>;

// The ONE reader for "which Kroger store does this LIST send to". Prefers the explicit bindings;
// falls back to the legacy single-store config (pre-bindings households) as a 'Grocery Store'
// binding — a pure view, no data migration/rewrite needed.
export function effectiveBindings(settings?: {
  storeBindings?: StoreBindings; krogerStoreId?: string; krogerStoreName?: string;
} | null): StoreBindings {
  if (settings?.storeBindings && Object.keys(settings.storeBindings).length) return settings.storeBindings;
  if (settings?.krogerStoreId) {
    // Legacy names were saved as "CHAIN name" ("FRED Fred Meyer - Issaquah") — strip the leading
    // all-caps chain code for display; freshly-bound stores save the API name alone.
    const legacy = (settings.krogerStoreName || 'Kroger').replace(/^[A-Z0-9]{2,8}\s+(?=\S)/, '');
    return { 'Grocery Store': { locationId: settings.krogerStoreId, name: legacy } };
  }
  return {};
}

// ── Search terms ─────────────────────────────────────────────────────────────────────────────────

// Root cause of the 2026-07-06 all-unmatched failure: our own buy-unit parentheticals poison Kroger's
// filter.term — "Garlic (1 bulb)" returns green ONION bulbs (matched on "bulb") and "Paneer (400g
// pack)" returns NOTHING, while the bare nouns return the right products (probe-verified live at Fred
// Meyer Issaquah 70100658). So: SEARCH with the clean noun; the parenthetical stays only in the
// human-facing item text.
export function krogerSearchTerm(text: string): string {
  return String(text ?? '')
    .replace(/\([^)]*\)/g, ' ')  // strip (…) buy-units wherever they sit
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 60);
}

// Second-pass term when the full cleaned term finds nothing: the LAST TWO words usually carry the
// product noun ("green cardamom pods" → "cardamom pods", "kashmiri red chili powder" → "chili
// powder"). Null when there's no simpler form to try (≤2 words) — two passes max, no cleverness.
export function krogerFallbackTerm(term: string): string | null {
  const words = String(term ?? '').split(' ').filter(Boolean);
  return words.length > 2 ? words.slice(-2).join(' ') : null;
}

// ── Product candidates ───────────────────────────────────────────────────────────────────────────

export interface ProductCandidate {
  upc: string;
  description: string;
  size: string;
  price: number | null;      // regular price when known
  stock: string;             // HIGH | LOW | TEMPORARILY_OUT_OF_STOCK | '' (unknown)
}

export function shapeProductCandidates(apiJson: any, cap = 5): ProductCandidate[] {
  const rows = Array.isArray(apiJson?.data) ? apiJson.data : [];
  return rows.slice(0, cap).map((p: any) => {
    const item = Array.isArray(p?.items) && p.items[0] ? p.items[0] : {};
    const price = item?.price?.promo || item?.price?.regular;
    return {
      upc: String(p?.productId || ''),
      description: String(p?.description || ''),
      size: String(item?.size || ''),
      price: Number.isFinite(Number(price)) && Number(price) > 0 ? Number(price) : null,
      stock: String(item?.inventory?.stockLevel || ''),
    };
  }).filter((c: ProductCandidate) => c.upc && c.description);
}

// ── LLM match (model picks; code validates) ──────────────────────────────────────────────────────

// One selection per shopping item: the index of the right candidate, or -1 for "none of these is
// actually the item" (the frying-pan case). Schema-enforced so even a weak model can only choose.
export const KROGER_MATCH_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    selections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING, description: 'The shopping-list item text, VERBATIM.' },
          candidateIndex: { type: Type.NUMBER, description: '0-based index of the matching candidate, or -1 if none of the candidates is really this item.' },
        },
        required: ['item', 'candidateIndex'],
      },
    },
  },
  required: ['selections'],
};

export function buildMatchPrompt(items: string[], candidates: Record<string, ProductCandidate[]>): string {
  const blocks = items.map(it => {
    const cands = candidates[it] || [];
    const lines = cands.length
      ? cands.map((c, i) => `  [${i}] ${c.description} — ${c.size}${c.price != null ? ` — $${c.price.toFixed(2)}` : ''}${c.stock ? ` — stock ${c.stock}` : ''}`).join('\n')
      : '  (no candidates found)';
    return `ITEM: "${it}"\n${lines}`;
  }).join('\n\n');
  return `For each shopping-list ITEM below, pick the candidate that IS that grocery item (right product type;
sensible size for a family). Pick -1 when none of the candidates is truly the item — e.g. cookware,
unrelated brands, prepared meals when the item is an ingredient. Never guess: -1 beats a wrong add.

${blocks}`;
}

export interface MatchedItem { text: string; upc: string; description: string; size: string; price: number | null }
// Why an item DIDN'T match — so the Approvals summary can be honest instead of a flat "couldn't
// match": 'no-products' = the store's search found nothing; 'search-failed' = the search REQUEST
// failed (transient — retry later); 'rejected' = candidates existed but none truly was the item
// (the frying-pan defense) or the only pick was out of stock.
export type UnmatchedReason = 'no-products' | 'search-failed' | 'rejected';
export interface MatchResult { matched: MatchedItem[]; unmatched: string[]; reasons?: Record<string, UnmatchedReason> }

// Deterministic validation of the model's selections: only REAL indexes for REAL items count; every
// item ends up exactly once in matched or unmatched (dupes/hallucinated items are ignored).
// `searchFailed` (from the server's per-item fetch loop) distinguishes a transient search failure
// from a genuine no-products store.
export function validateMatchSelections(
  parsed: any,
  items: string[],
  candidates: Record<string, ProductCandidate[]>,
  searchFailed?: Set<string>,
): MatchResult {
  const byItem = new Map<string, number>();
  for (const s of Array.isArray(parsed?.selections) ? parsed.selections : []) {
    const item = String(s?.item || '');
    if (items.includes(item) && !byItem.has(item)) byItem.set(item, Number(s?.candidateIndex));
  }
  const matched: MatchedItem[] = [];
  const unmatched: string[] = [];
  const reasons: Record<string, UnmatchedReason> = {};
  for (const item of items) {
    const idx = byItem.get(item);
    const cands = candidates[item] || [];
    const c = idx != null && Number.isInteger(idx) && idx >= 0 && idx < cands.length ? cands[idx] : null;
    if (c && c.stock !== 'TEMPORARILY_OUT_OF_STOCK') {
      matched.push({ text: item, upc: c.upc, description: c.description, size: c.size, price: c.price });
    } else {
      unmatched.push(item);
      reasons[item] = searchFailed?.has(item) ? 'search-failed' : cands.length ? 'rejected' : 'no-products';
    }
  }
  return { matched, unmatched, reasons };
}

// ── Cart ─────────────────────────────────────────────────────────────────────────────────────────

// PUT /v1/cart/add body. Quantity clamped 1..10 — a garbled quantity must never bulk-buy.
export function buildCartAddBody(items: { upc: string; quantity?: number }[]): { items: { upc: string; quantity: number }[] } {
  return {
    items: (Array.isArray(items) ? items : [])
      .filter(i => i && typeof i.upc === 'string' && /^\d{6,14}$/.test(i.upc))
      .map(i => ({ upc: i.upc, quantity: Math.min(10, Math.max(1, Math.round(Number(i.quantity) || 1))) })),
  };
}

// Human summary for the confirm-tier Approvals card — the parent approves EXACTLY this text.
// Unmatched items are grouped by their honest reason ("no match at this store" ≠ "search failed —
// try again"); everything unmatched stays on the lists either way.
export function buildCartDraftSummary(store: string, matched: MatchedItem[], unmatched: string[], reasons?: Record<string, UnmatchedReason>): string {
  const total = matched.reduce((a, m) => a + (m.price || 0), 0);
  const lines = matched.map(m => `${m.text} → ${m.description} (${m.size}${m.price != null ? `, $${m.price.toFixed(2)}` : ''})`);
  let s = `Add ${matched.length} item${matched.length === 1 ? '' : 's'} to your ${store} cart (~$${total.toFixed(2)}): ${lines.join('; ')}`;
  // Presence-model flag (owner decision): the list carries generic buy-units, not counts — say so
  // exactly where the parent approves the cart.
  if (matched.length) s += '. Quantities default to 1 of each — bump any in the Kroger cart before checkout';
  if (unmatched.length) {
    const failed = unmatched.filter(i => reasons?.[i] === 'search-failed');
    const noMatch = unmatched.filter(i => reasons?.[i] !== 'search-failed');
    if (noMatch.length) s += ` — no match at this store: ${noMatch.join(', ')} (left on your lists)`;
    if (failed.length) s += ` — search failed for: ${failed.join(', ')} (try again in a bit)`;
  }
  return s.slice(0, 900);
}
