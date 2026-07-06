// Shopping-list de-dupe / merge (the "never duplicate" contract). Every path that ADDS an item — the
// manual add form, the copilot/quick-add append, a recipe/pantry AI batch — routes through here so the
// list can never grow two rows for the same item in the same store. A match that's checked off is
// RE-ACTIVATED in place (unchecked + bumped to top) rather than duplicated; an active match is a no-op.
// Pure → unit-tested; the UI is thin glue over these.
import type { ShoppingItem } from '../types';

const norm = (s: string): string => String(s ?? '').trim().toLowerCase();

// The BASE item: the text with its parenthetical buy-unit(s) stripped — the presence-model key
// (owner decision). "Garlic (1 head)" ≡ "Garlic (1 bulb)" ≡ "garlic": one garlic row per list,
// whatever unit wording a model or human used. Falls back to the raw norm when stripping would
// leave nothing (an item that IS only a parenthetical is garbage anyway, but never keys as '').
export const baseItem = (text: string): string => {
  const stripped = String(text ?? '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return stripped || norm(text);
};

// The dedupe key is (BASE item + store): the same item on two DIFFERENT store lists is legitimately
// distinct ("milk" at Costco vs the grocery store), but two garlic rows on the SAME list never are —
// regardless of "(1 bulb)" vs "(1 head)" wording.
export const sameItem = (a: { text: string; store: string }, text: string, store: string): boolean =>
  baseItem(a.text) === baseItem(text) && a.store === store;

export const findDuplicate = (list: ShoppingItem[], text: string, store: string): ShoppingItem | undefined => {
  if (!baseItem(text)) return undefined; // a textless/garbage row can never be a duplicate of anything
  return (list || []).find(i => sameItem(i, text, store));
};

export type MergeOutcome = 'added' | 'reactivated' | 'exists';

// Merge ONE incoming item. Returns the new list, what happened, and the resulting row (for the toast/
// suggestion UX). Re-activation keeps the existing id/author/staple flag and adopts a freshly-supplied
// quantity if the incoming one carried it (else keeps the old).
export function mergeShoppingItem(
  list: ShoppingItem[], incoming: ShoppingItem,
): { list: ShoppingItem[]; outcome: MergeOutcome; item: ShoppingItem } {
  const dup = findDuplicate(list, incoming.text, incoming.store);
  if (!dup) return { list: [incoming, ...list], outcome: 'added', item: incoming };
  // Presence model: keep the EXISTING row's text (no churn) — except when the incoming carries a
  // buy-unit parenthetical and the existing doesn't (adopt the more informative wording).
  const moreInformative = /\(/.test(incoming.text) && !/\(/.test(dup.text);
  if (dup.completed) {
    const reactivated: ShoppingItem = {
      ...dup, completed: false,
      text: moreInformative ? incoming.text : dup.text,
      quantity: incoming.quantity || dup.quantity,
    };
    return { list: [reactivated, ...list.filter(i => i.id !== dup.id)], outcome: 'reactivated', item: reactivated };
  }
  if (moreInformative) {
    const upgraded: ShoppingItem = { ...dup, text: incoming.text };
    return { list: list.map(i => (i.id === dup.id ? upgraded : i)), outcome: 'exists', item: upgraded };
  }
  return { list, outcome: 'exists', item: dup }; // already active → nothing to do
}

// Merge a BATCH (AI recipe/restock/meal-plan/quick-add). Folds each incoming through mergeShoppingItem so
// duplicates within the batch AND against the live list both collapse. Returns counts for the caller's
// "added N (re-activated M)" message.
export function mergeShoppingItems(
  list: ShoppingItem[], incomings: ShoppingItem[],
): { list: ShoppingItem[]; added: number; reactivated: number } {
  let cur = list, added = 0, reactivated = 0;
  for (const inc of incomings || []) {
    const r = mergeShoppingItem(cur, inc);
    cur = r.list;
    if (r.outcome === 'added') added++;
    else if (r.outcome === 'reactivated') reactivated++;
  }
  return { list: cur, added, reactivated };
}
