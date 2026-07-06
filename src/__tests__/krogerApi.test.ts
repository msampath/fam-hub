import { describe, it, expect } from 'vitest';
import {
  buildKrogerAuthUrl, authCodeTokenBody, refreshTokenBody, clientCredentialsBody,
  shapeLocations, shapeProductCandidates, buildMatchPrompt, validateMatchSelections, mergeMatchRetry,
  buildCartAddBody, buildCartDraftSummary, krogerSearchTerm, krogerFallbackTerm, effectiveBindings, effectiveKrogerConnection, type ProductCandidate,
} from '../utils/krogerApi';

const PANEER_CANDS: ProductCandidate[] = [
  { upc: '0007675306136', description: 'Goodcook Nonstick Ceramic Frying Pan', size: '11.75 in', price: 21.99, stock: 'HIGH' },
  { upc: '0001111000093', description: 'Private Selection Palak Paneer', size: '22 oz', price: 7.99, stock: 'HIGH' },
  { upc: '0001111060903', description: 'Nanak Paneer Cubes', size: '14 oz', price: 6.49, stock: 'LOW' },
];

describe('oauth builders', () => {
  it('builds the authorize URL with cart+profile scopes and state', () => {
    const u = new URL(buildKrogerAuthUrl('cid', 'http://localhost:4894/api/kroger/callback', 'nonce9'));
    expect(u.origin + u.pathname).toBe('https://api.kroger.com/v1/connect/oauth2/authorize');
    expect(u.searchParams.get('scope')).toBe('cart.basic:write profile.compact');
    expect(u.searchParams.get('state')).toBe('nonce9');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:4894/api/kroger/callback');
  });

  it('builds the three grant bodies', () => {
    expect(authCodeTokenBody('c0de', 'http://x/cb')).toBe('grant_type=authorization_code&code=c0de&redirect_uri=http%3A%2F%2Fx%2Fcb');
    expect(refreshTokenBody('rt')).toBe('grant_type=refresh_token&refresh_token=rt');
    expect(clientCredentialsBody('product.compact')).toBe('grant_type=client_credentials&scope=product.compact');
  });
});

// The 2026-07-06 all-unmatched failure: raw buy-unit parentheticals in filter.term returned zero/junk
// candidates at the real store. These pin the cleaner + the one-retry fallback + the honest reasons.
describe('search terms (the parenthetical bug)', () => {
  it('strips buy-unit parentheticals, collapses, lowercases', () => {
    expect(krogerSearchTerm('Garlic (1 bulb)')).toBe('garlic');
    expect(krogerSearchTerm('Heavy cream (500 ml carton)')).toBe('heavy cream');
    expect(krogerSearchTerm('Kashmiri red chili powder (small pack)')).toBe('kashmiri red chili powder');
    expect(krogerSearchTerm('  Paneer   (400g pack) ')).toBe('paneer');
    expect(krogerSearchTerm('')).toBe('');
  });

  it('fallback = last two words, only when the term has more than two', () => {
    expect(krogerFallbackTerm('green cardamom pods')).toBe('cardamom pods');
    expect(krogerFallbackTerm('kashmiri red chili powder')).toBe('chili powder');
    expect(krogerFallbackTerm('heavy cream')).toBeNull();
    expect(krogerFallbackTerm('garlic')).toBeNull();
  });

  it('validateMatchSelections carries honest per-item reasons', () => {
    const items = ['paneer', 'unicorn fruit', 'butter'];
    const candidates = { paneer: PANEER_CANDS, 'unicorn fruit': [], butter: PANEER_CANDS };
    const searchFailed = new Set(['butter']); // the butter SEARCH failed (HTTP error), not the store
    const r = validateMatchSelections(
      { selections: [{ item: 'paneer', candidateIndex: -1 }] }, // model rejected all paneer candidates
      items, candidates, searchFailed,
    );
    expect(r.unmatched).toEqual(items);
    expect(r.reasons).toEqual({ paneer: 'rejected', 'unicorn fruit': 'no-products', butter: 'search-failed' });
  });

  it('buildCartDraftSummary separates "no match" / "couldn\'t confidently match" / "search failed"', () => {
    const matched = [{ text: 'garlic', upc: '0001', description: 'Garlic Bulbs', size: '1 ct', price: 0.99 }];
    const s = buildCartDraftSummary('Fred Meyer - Issaquah', matched, ['unicorn fruit', 'ginger', 'butter'],
      { 'unicorn fruit': 'no-products', ginger: 'rejected', butter: 'search-failed' });
    expect(s).toContain('No match at this store: unicorn fruit');
    // 'rejected' must NOT claim the store lacks it — candidates existed, confidence didn't.
    expect(s).toContain("Couldn't confidently match: ginger (still on your lists — try Send again)");
    expect(s).toContain('Search failed for: butter');
    // Presence-model flag: the parent is told quantities default to 1 exactly where they approve.
    expect(s).toContain('Quantities default to 1 of each');
    // Legacy no-reasons callers keep the old bucket (unknown reason reads as no-products).
    expect(buildCartDraftSummary('QFC', matched, ['kasuri methi'])).toContain('No match at this store: kasuri methi');
    // One fact per line: header + a • line per item + one line per note group (readability, owner ask).
    expect(s.split('\n')).toHaveLength(6);
    expect(s).toContain('\n• garlic → Garlic Bulbs (1 ct, $0.99)\n');
  });

  it('mergeMatchRetry folds second-pass wins into matched and clears their reasons', () => {
    const first = {
      matched: [{ text: 'garlic', upc: '0001', description: 'Garlic Bulbs', size: '1 ct', price: 0.99 }],
      unmatched: ['ginger', 'butter', 'unicorn fruit'],
      reasons: { ginger: 'rejected', butter: 'rejected', 'unicorn fruit': 'no-products' } as const,
    };
    const retry = {
      matched: [{ text: 'butter', upc: '0002', description: 'Challenge Unsalted Butter', size: '16 oz', price: 4.79 }],
      unmatched: ['ginger'],
      reasons: { ginger: 'rejected' } as const,
    };
    const merged = mergeMatchRetry(first, retry);
    expect(merged.matched.map(m => m.text)).toEqual(['garlic', 'butter']);
    expect(merged.unmatched).toEqual(['ginger', 'unicorn fruit']); // first-pass order kept
    expect(merged.reasons).toEqual({ ginger: 'rejected', 'unicorn fruit': 'no-products' });
    // A retry with no wins is a strict no-op (same object back — nothing to rebuild).
    expect(mergeMatchRetry(first, { matched: [], unmatched: ['ginger', 'butter'], reasons: {} })).toBe(first);
  });
});

// The two-level model's resolved view: listLinks × krogerConnection composes first; the transitional
// storeBindings shape reads through next; then the legacy single-store config; else empty.
describe('effectiveBindings (two-level compose + read-throughs)', () => {
  const LOC = { locationId: '70100658', name: 'Fred Meyer - Issaquah' };

  it('composes listLinks × the connection — many lists per connection, location changes once', () => {
    const s = { krogerConnection: LOC, listLinks: { 'Grocery Store': 'kroger' as const, 'Costco': 'kroger' as const } };
    expect(effectiveBindings(s)).toEqual({ 'Grocery Store': LOC, 'Costco': LOC });
    // Links without a connection location resolve to nothing (falls through the chain).
    expect(effectiveBindings({ listLinks: { 'Grocery Store': 'kroger' } })).toEqual({});
  });

  it('reads the transitional storeBindings shape through, then legacy, else empty', () => {
    const transitional = { 'Indian Store': { locationId: '123', name: 'Apna Bazar' } };
    expect(effectiveBindings({ storeBindings: transitional, krogerStoreId: '999', krogerStoreName: 'Old' })).toEqual(transitional);
    // The legacy stored name carried the chain-code prefix ("FRED …") — the read-through strips it.
    expect(effectiveBindings({ krogerStoreId: '70100658', krogerStoreName: 'FRED Fred Meyer - Issaquah' }))
      .toEqual({ 'Grocery Store': LOC });
    expect(effectiveBindings({})).toEqual({});
    expect(effectiveBindings(null)).toEqual({});
    expect(effectiveBindings({ storeBindings: {} })).toEqual({}); // empty object ≠ configured
  });

  it('effectiveKrogerConnection surfaces the step-2 location through the same chain', () => {
    expect(effectiveKrogerConnection({ krogerConnection: LOC })).toEqual(LOC);
    expect(effectiveKrogerConnection({ storeBindings: { 'Grocery Store': LOC } })).toEqual(LOC);
    expect(effectiveKrogerConnection({ krogerStoreId: '70100658', krogerStoreName: 'FRED Fred Meyer - Issaquah' })).toEqual(LOC);
    expect(effectiveKrogerConnection({})).toBeNull();
  });
});

describe('shapers', () => {
  it('shapes locations and drops rows without id/name', () => {
    const out = shapeLocations({ data: [
      { locationId: '70500824', chain: 'QFC', name: 'QFC Pine Lake', address: { addressLine1: '3050 Issaquah Pine Lake Rd', city: 'Sammamish' } },
      { locationId: '', name: 'ghost' },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ locationId: '70500824', chain: 'QFC', address: '3050 Issaquah Pine Lake Rd, Sammamish' });
  });

  it('shapes product candidates: promo wins, junk price → null, caps at 5', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      productId: `000${i}`, description: `Item ${i}`,
      items: [{ size: '1 lb', price: i === 0 ? { regular: 4, promo: 3.5 } : i === 1 ? { regular: 0 } : { regular: 2 }, inventory: { stockLevel: 'HIGH' } }],
    }));
    const out = shapeProductCandidates({ data: rows });
    expect(out).toHaveLength(5);
    expect(out[0].price).toBe(3.5);
    expect(out[1].price).toBeNull();
  });
});

describe('match validation (the frying-pan defense)', () => {
  const items = ['paneer', 'kasuri methi'];
  const candidates = { paneer: PANEER_CANDS, 'kasuri methi': [] as ProductCandidate[] };

  it('prompt lists candidates with prices and demands -1 over guessing', () => {
    const p = buildMatchPrompt(items, candidates);
    expect(p).toMatch(/\[2\] Nanak Paneer Cubes — 14 oz — \$6\.49/);
    expect(p).toMatch(/-1 beats a wrong add/);
    expect(p).toMatch(/\(no candidates found\)/);
  });

  it('honors a valid pick, forces unmatched for -1 / no candidates / hallucinated items', () => {
    const r = validateMatchSelections(
      { selections: [
        { item: 'paneer', candidateIndex: 2 },
        { item: 'kasuri methi', candidateIndex: 0 },        // no candidates exist → unmatched
        { item: 'unicorn dust', candidateIndex: 1 },        // not on the list → ignored
      ] },
      items, candidates,
    );
    expect(r.matched).toEqual([{ text: 'paneer', upc: '0001111060903', description: 'Nanak Paneer Cubes', size: '14 oz', price: 6.49 }]);
    expect(r.unmatched).toEqual(['kasuri methi']);
  });

  it('clamps out-of-range indexes to unmatched and drops OOS picks', () => {
    const oos = { paneer: [{ ...PANEER_CANDS[2], stock: 'TEMPORARILY_OUT_OF_STOCK' }] };
    expect(validateMatchSelections({ selections: [{ item: 'paneer', candidateIndex: 9 }] }, ['paneer'], { paneer: PANEER_CANDS }).unmatched).toEqual(['paneer']);
    expect(validateMatchSelections({ selections: [{ item: 'paneer', candidateIndex: 0 }] }, ['paneer'], oos).unmatched).toEqual(['paneer']);
    expect(validateMatchSelections(null, ['paneer'], { paneer: PANEER_CANDS }).unmatched).toEqual(['paneer']);
  });
});

describe('cart body + draft summary', () => {
  it('clamps quantities 1..10 and rejects non-UPC ids', () => {
    const b = buildCartAddBody([
      { upc: '0001111060903', quantity: 99 },
      { upc: '0001111000093' },
      { upc: 'javascript:alert(1)', quantity: 2 },
      { upc: '0007675306136', quantity: -3 },
    ]);
    expect(b.items).toEqual([
      { upc: '0001111060903', quantity: 10 },
      { upc: '0001111000093', quantity: 1 },
      { upc: '0007675306136', quantity: 1 },
    ]);
  });

  it('summary names store, total, per-item mapping, and the unmatched leftovers', () => {
    const s = buildCartDraftSummary('QFC Pine Lake',
      [{ text: 'paneer', upc: 'x', description: 'Nanak Paneer Cubes', size: '14 oz', price: 6.49 }],
      ['kasuri methi']);
    expect(s).toMatch(/Add 1 item to your QFC Pine Lake cart \(~\$6\.49\)/);
    expect(s).toMatch(/paneer → Nanak Paneer Cubes \(14 oz, \$6\.49\)/);
    expect(s).toMatch(/No match at this store: kasuri methi \(left on your lists\)/);
  });
});
