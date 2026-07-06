// The "never duplicate" contract: every add path folds through mergeShoppingItem(s). A checked-off
// match re-activates in place, an active match is a no-op, a different store is distinct.
import { describe, it, expect } from 'vitest';
import { mergeShoppingItem, mergeShoppingItems, findDuplicate } from '../utils/shoppingMerge';
import type { ShoppingItem } from '../types';

const item = (over: Partial<ShoppingItem> & { id: string }): ShoppingItem =>
  ({ text: 'Milk', completed: false, store: 'Grocery Store', ...over });

describe('findDuplicate', () => {
  it('matches on normalized text + store (case/space-insensitive); different store is not a dup', () => {
    const list = [item({ id: 'g1', text: 'Milk', store: 'Grocery Store' })];
    expect(findDuplicate(list, '  milk ', 'Grocery Store')?.id).toBe('g1');
    expect(findDuplicate(list, 'Milk', 'Costco')).toBeUndefined();
    expect(findDuplicate(list, 'Bread', 'Grocery Store')).toBeUndefined();
  });
});

describe('mergeShoppingItem', () => {
  it('adds when there is no match', () => {
    const r = mergeShoppingItem([], item({ id: 'new', text: 'Eggs' }));
    expect(r.outcome).toBe('added');
    expect(r.list).toHaveLength(1);
  });

  it('re-activates a checked-off match in place (same id, unchecked, bumped to top) — never a 2nd row', () => {
    const list = [item({ id: 'a', text: 'Apples' }), item({ id: 'g1', text: 'Milk', completed: true })];
    const r = mergeShoppingItem(list, item({ id: 'new', text: 'MILK' }));
    expect(r.outcome).toBe('reactivated');
    expect(r.list).toHaveLength(2);
    expect(r.list[0].id).toBe('g1');            // existing row, bumped to top
    expect(r.list[0].completed).toBe(false);
    expect(r.list.filter(i => i.text.toLowerCase() === 'milk')).toHaveLength(1);
  });

  it('adopts a fresh quantity on re-activation, keeps the old one otherwise', () => {
    const list = [item({ id: 'g1', text: 'Milk', completed: true, quantity: '1 gal' })];
    expect(mergeShoppingItem(list, item({ id: 'n', text: 'milk', quantity: '2 gal' })).list[0].quantity).toBe('2 gal');
    expect(mergeShoppingItem(list, item({ id: 'n', text: 'milk' })).list[0].quantity).toBe('1 gal');
  });

  it('is a no-op when the match is already active', () => {
    const list = [item({ id: 'g1', text: 'Milk', completed: false })];
    const r = mergeShoppingItem(list, item({ id: 'new', text: 'milk' }));
    expect(r.outcome).toBe('exists');
    expect(r.list).toBe(list); // unchanged reference
  });
});

describe('mergeShoppingItems (batch)', () => {
  it('collapses duplicates within the batch AND against the live list', () => {
    const list = [item({ id: 'g1', text: 'Milk', completed: true })];
    const r = mergeShoppingItems(list, [
      item({ id: 'b1', text: 'milk' }),     // re-activates g1
      item({ id: 'b2', text: 'Bread' }),    // added
      item({ id: 'b3', text: 'bread' }),    // dup within the batch → no-op
    ]);
    expect(r.added).toBe(1);
    expect(r.reactivated).toBe(1);
    expect(r.list.filter(i => i.text.toLowerCase() === 'bread')).toHaveLength(1);
    expect(r.list.filter(i => i.text.toLowerCase() === 'milk')).toHaveLength(1);
  });
});
