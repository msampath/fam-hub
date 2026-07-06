import { describe, it, expect } from 'vitest';
import {
  buildKrogerAuthUrl, authCodeTokenBody, refreshTokenBody, clientCredentialsBody,
  shapeLocations, shapeProductCandidates, buildMatchPrompt, validateMatchSelections,
  buildCartAddBody, buildCartDraftSummary, type ProductCandidate,
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
    expect(s).toMatch(/couldn't match: kasuri methi \(left on your lists\)/);
  });
});
