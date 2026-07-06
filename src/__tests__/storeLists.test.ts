// Household-defined store lists (Phase-5): the shared sanitize gate + fallback routing + the dynamic
// pieces that consume them (normalize, morning planner). The invariant under test: NO input — junk
// settings, a weak model's invented store, an empty list — ever produces an item outside the
// household's (or default) lists.
import { describe, it, expect } from 'vitest';
import { sanitizeStoreList, fallbackStore, SHOP_STORES } from '../constants';
import { normalizeShoppingItems } from '../utils/aiActions';
import { validateMorningProposals, buildMorningPlannerSchema } from '../utils/morningAgent';

describe('sanitizeStoreList', () => {
  it('trims, collapses whitespace, dedupes case-insensitively, clamps name + list size', () => {
    expect(sanitizeStoreList(['  Trader   Joe\'s ', 'COSTCO', 'costco', '', '   ', 'X'.repeat(50)]))
      .toEqual(["Trader Joe's", 'COSTCO', 'X'.repeat(24)]);
    expect(sanitizeStoreList(Array.from({ length: 20 }, (_, i) => `Store ${i}`))).toHaveLength(8);
  });
  it('falls back to the defaults on junk/empty input', () => {
    expect(sanitizeStoreList(undefined)).toEqual([...SHOP_STORES]);
    expect(sanitizeStoreList([])).toEqual([...SHOP_STORES]);
    expect(sanitizeStoreList('not-an-array')).toEqual([...SHOP_STORES]);
    expect(sanitizeStoreList([null, '', 42])).toEqual(['42']); // one salvageable entry survives
  });
});

describe('fallbackStore', () => {
  it('prefers the general-grocery list, else the LAST list (Other-position)', () => {
    expect(fallbackStore([...SHOP_STORES])).toBe('Grocery Store');
    expect(fallbackStore(['Trader Joe\'s', 'H-Mart', 'Misc'])).toBe('Misc');
    expect(fallbackStore([])).toBe('Other');
  });
});

describe('normalizeShoppingItems with custom household lists', () => {
  it('keeps valid custom stores and re-routes unknown/model-invented ones to the fallback', () => {
    const stores = ['Trader Joe\'s', 'H-Mart', 'Misc'] as const;
    const items = normalizeShoppingItems(
      [{ text: 'kimchi', store: 'H-Mart' }, { text: 'flowers', store: 'Target' }, { text: 'eggs' }],
      stores as unknown as readonly string[],
    );
    expect(items.map(i => i.store)).toEqual(['H-Mart', 'Misc', 'Misc']);
  });
});

describe('morning planner with custom household lists', () => {
  it('schema enum reflects the household lists; validator clamps unknown stores to their last list', () => {
    const stores = ['Farm Stand', 'Bulk Barn'];
    const schema = buildMorningPlannerSchema(stores) as any;
    expect(schema.properties.proposals.items.properties.store.enum).toEqual(stores);
    const out = validateMorningProposals(
      [{ kind: 'shopping', text: 'Umbrella', store: 'Costco', rationale: 'rain during soccer' }],
      { today: '2026-07-06', stores },
    );
    expect((out[0].payload as { store: string }).store).toBe('Bulk Barn'); // no 'Other' → last list
  });
  it('default lists keep the documented Other fallback', () => {
    const out = validateMorningProposals(
      [{ kind: 'shopping', text: 'Gift wrap', store: 'Target', rationale: 'birthday friday' }],
      { today: '2026-07-06' },
    );
    expect((out[0].payload as { store: string }).store).toBe('Other');
  });
});
