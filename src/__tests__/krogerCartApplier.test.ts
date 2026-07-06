// The kroger_cart_write approve path is wired inline in App.tsx; these tests lock the two pure pieces
// it depends on end-to-end — the draft summary the parent approves, and the cart body actually sent —
// so a refactor can't silently change what "approve" adds to the real cart.
import { describe, it, expect } from 'vitest';
import { buildCartDraftSummary, buildCartAddBody, validateMatchSelections, type MatchedItem } from '../utils/krogerApi';

describe('kroger cart write — staged draft ↔ sent body', () => {
  const matched: MatchedItem[] = [
    { text: 'paneer', upc: '0001111060903', description: 'Nanak Paneer Cubes', size: '14 oz', price: 6.49 },
    { text: 'basmati rice', upc: '0001111000456', description: 'Royal Basmati Rice', size: '10 lb', price: 18.99 },
  ];

  it('the summary the parent approves lists exactly the items + unmatched leftovers', () => {
    const s = buildCartDraftSummary('QFC Pine Lake', matched, ['kasuri methi']);
    expect(s).toContain('Add 2 items to your QFC Pine Lake cart');
    expect(s).toContain('paneer → Nanak Paneer Cubes');
    expect(s).toContain('basmati rice → Royal Basmati Rice');
    expect(s).toContain('no match at this store: kasuri methi');
  });

  it('the payload staged from matched items produces a clean cart body (qty defaulted, UPCs intact)', () => {
    // App.tsx stages payload.items = matched.map(m => ({ upc, quantity: 1, text })).
    const payloadItems = matched.map(m => ({ upc: m.upc, quantity: 1, text: m.text }));
    const body = buildCartAddBody(payloadItems);
    expect(body.items).toEqual([
      { upc: '0001111060903', quantity: 1 },
      { upc: '0001111000456', quantity: 1 },
    ]);
  });

  it('a fully-unmatched list yields no matched items → App short-circuits before staging', () => {
    const r = validateMatchSelections({ selections: [{ item: 'unobtanium', candidateIndex: -1 }] }, ['unobtanium'], { unobtanium: [] });
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toEqual(['unobtanium']);
  });
});
