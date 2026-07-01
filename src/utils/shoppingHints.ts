// Picks a respectful example dish for the recipe-input placeholder. Defaults to a neutral dish and,
// when the household has recorded dietary preferences, reflects them so a vegan/halal/kosher/etc.
// household never sees an off-putting example every session. Pure + unit-tested.
import type { FamilyMember } from '../types';

// Keyword → example dish. Order matters: the first matching diet wins (most-restrictive first).
const DIET_EXAMPLES: { match: RegExp; dish: string }[] = [
  { match: /\bvegan\b/i, dish: 'veggie stir-fry for 4' },
  { match: /\b(vegetarian|veggie)\b/i, dish: 'veggie pasta for 4' },
  { match: /\bhalal\b/i, dish: 'chicken shawarma for 4' },
  { match: /\bkosher\b/i, dish: 'baked salmon for 4' },
];

const NEUTRAL = 'pasta for 4';

export function exampleDish(members: Pick<FamilyMember, 'dietary'>[] = []): string {
  const diets = members.map(m => m.dietary || '').join(' ');
  for (const { match, dish } of DIET_EXAMPLES) {
    if (match.test(diets)) return dish;
  }
  return NEUTRAL;
}
