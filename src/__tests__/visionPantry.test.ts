import { describe, it, expect } from 'vitest';
import { diffDetectedVsPantry, normalizeItem } from '../utils/visionPantry';

describe('diffDetectedVsPantry (#2 vision)', () => {
  const pantry = [{ text: 'Milk' }, { text: 'Eggs' }];

  it('splits detected items into new vs already-stocked (by model flag and by pantry match)', () => {
    const { newItems, known } = diffDetectedVsPantry([
      { text: 'Milk', inPantry: false },        // matches pantry (normalized) → known despite the flag
      { text: 'Butter', inPantry: false },      // new
      { text: 'Yogurt', inPantry: true },       // model says already have → known
    ], pantry);
    expect(newItems.map(i => i.text)).toEqual(['Butter']);
    expect(known.map(i => i.text).sort()).toEqual(['Milk', 'Yogurt']);
  });

  it('de-dupes the model\'s own repeats (case/punctuation-insensitive)', () => {
    const { newItems } = diffDetectedVsPantry([
      { text: 'Butter' }, { text: 'butter!' }, { text: 'BUTTER' },
    ], pantry);
    expect(newItems).toHaveLength(1);
  });

  it('drops blank items and passes through the store hint', () => {
    const { newItems } = diffDetectedVsPantry([
      { text: '   ' }, { text: 'Besan', store: 'Indian Store' },
    ], pantry);
    expect(newItems).toEqual([{ text: 'Besan', store: 'Indian Store' }]);
  });

  it('normalizeItem lowercases + strips punctuation + collapses space', () => {
    expect(normalizeItem('  2% Milk!! ')).toBe('2 milk');
  });
});
