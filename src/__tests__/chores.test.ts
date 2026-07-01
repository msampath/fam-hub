import { describe, it, expect } from 'vitest';
import { choreMatchesSlot } from '../utils/chores';
import { getCurrentTimeOfDay } from '../utils/dates';

describe('choreMatchesSlot', () => {
  it("returns true for any chore when filter is 'All'", () => {
    expect(choreMatchesSlot('Morning', 'All')).toBe(true);
    expect(choreMatchesSlot('Evening', 'All')).toBe(true);
    expect(choreMatchesSlot(undefined, 'All')).toBe(true);
    expect(choreMatchesSlot('Anytime', 'All')).toBe(true);
  });

  it('matches an exact slot', () => {
    expect(choreMatchesSlot('Morning', 'Morning')).toBe(true);
    expect(choreMatchesSlot('Morning', 'Evening')).toBe(false);
    expect(choreMatchesSlot('Evening', 'Evening')).toBe(true);
    expect(choreMatchesSlot('Afternoon', 'Morning')).toBe(false);
  });

  it('shows chores with empty/undefined slot under any filter', () => {
    expect(choreMatchesSlot(undefined, 'Morning')).toBe(true);
    expect(choreMatchesSlot('', 'Morning')).toBe(true);
    expect(choreMatchesSlot(undefined, 'Evening')).toBe(true);
  });

  it("shows 'Anytime'/unrecognized slots under any filter", () => {
    expect(choreMatchesSlot('Anytime', 'Morning')).toBe(true);
    expect(choreMatchesSlot('Anytime', 'Evening')).toBe(true);
    expect(choreMatchesSlot('whenever', 'Afternoon')).toBe(true);
  });

  it('shows legacy multi-slot chores under each named slot', () => {
    expect(choreMatchesSlot('Morning & Evening', 'Morning')).toBe(true);
    expect(choreMatchesSlot('Morning & Evening', 'Evening')).toBe(true);
    expect(choreMatchesSlot('Morning & Evening', 'Afternoon')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(choreMatchesSlot('morning', 'Morning')).toBe(true);
    expect(choreMatchesSlot('MORNING', 'morning')).toBe(true);
    expect(choreMatchesSlot('Morning', 'EVENING')).toBe(false);
  });
});

describe('getCurrentTimeOfDay', () => {
  it('returns Morning for hours 5-11', () => {
    expect(getCurrentTimeOfDay(5)).toBe('Morning');
    expect(getCurrentTimeOfDay(11)).toBe('Morning');
  });

  it('returns Afternoon for hours 12-16', () => {
    expect(getCurrentTimeOfDay(12)).toBe('Afternoon');
    expect(getCurrentTimeOfDay(16)).toBe('Afternoon');
  });

  it('returns Evening otherwise', () => {
    expect(getCurrentTimeOfDay(17)).toBe('Evening');
    expect(getCurrentTimeOfDay(4)).toBe('Evening');
    expect(getCurrentTimeOfDay(0)).toBe('Evening');
    expect(getCurrentTimeOfDay(23)).toBe('Evening');
  });
});
