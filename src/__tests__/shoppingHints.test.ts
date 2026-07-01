import { describe, it, expect } from 'vitest';
import { exampleDish } from '../utils/shoppingHints';

describe('exampleDish', () => {
  it('returns a neutral default with no dietary data', () => {
    expect(exampleDish([])).toBe('pasta for 4');
    expect(exampleDish([{ dietary: '' }, { dietary: undefined }])).toBe('pasta for 4');
  });

  it('reflects a recorded dietary preference', () => {
    expect(exampleDish([{ dietary: 'vegan' }])).toBe('veggie stir-fry for 4');
    expect(exampleDish([{ dietary: 'vegetarian, nut allergy' }])).toBe('veggie pasta for 4');
    expect(exampleDish([{ dietary: 'halal' }])).toBe('chicken shawarma for 4');
    expect(exampleDish([{ dietary: 'keeps kosher' }])).toBe('baked salmon for 4');
  });

  it('never returns the old offensive example', () => {
    const all = [exampleDish([]), exampleDish([{ dietary: 'vegan' }]), exampleDish([{ dietary: 'halal' }])];
    expect(all.some(d => /biryani/i.test(d))).toBe(false);
  });
});
