import { describe, it, expect } from 'vitest';
import { buildMonthWindow, buildRollingWindow, monthWindowRange } from '../utils/dates';

describe('buildMonthWindow', () => {
  it('defaults to a count of 4 months', () => {
    expect(buildMonthWindow(undefined, new Date(2026, 5, 15))).toHaveLength(4);
  });

  it('builds a rolling window from a fixed start (June 2026)', () => {
    const w = buildMonthWindow(4, new Date(2026, 5, 15));
    expect(w).toEqual([
      { name: 'June 2026', index: 5, year: 2026 },
      { name: 'July 2026', index: 6, year: 2026 },
      { name: 'August 2026', index: 7, year: 2026 },
      { name: 'September 2026', index: 8, year: 2026 },
    ]);
  });

  it('rolls over the year boundary (Nov 2026 -> Feb 2027)', () => {
    const w = buildMonthWindow(4, new Date(2026, 10, 10));
    expect(w).toEqual([
      { name: 'November 2026', index: 10, year: 2026 },
      { name: 'December 2026', index: 11, year: 2026 },
      { name: 'January 2027', index: 0, year: 2027 },
      { name: 'February 2027', index: 1, year: 2027 },
    ]);
  });
});

describe('buildRollingWindow', () => {
  it('spans 12 months back .. 12 months forward (25 months) with the current month centered', () => {
    const w = buildRollingWindow(12, 12, new Date(2026, 5, 24)); // June 2026
    expect(w).toHaveLength(25);
    expect(w[0]).toEqual({ name: 'June 2025', index: 5, year: 2025 });   // 12 back
    expect(w[12]).toEqual({ name: 'June 2026', index: 5, year: 2026 });  // center = current month
    expect(w[24]).toEqual({ name: 'June 2027', index: 5, year: 2027 });  // 12 forward
  });

  it('rolls over year boundaries on both ends', () => {
    const w = buildRollingWindow(2, 2, new Date(2027, 0, 10)); // Jan 2027, ±2
    expect(w.map(m => m.name)).toEqual([
      'November 2026', 'December 2026', 'January 2027', 'February 2027', 'March 2027',
    ]);
  });
});

describe('monthWindowRange', () => {
  it('spans first day of first month to last day of last month (June-Sept 2026)', () => {
    const months = buildMonthWindow(4, new Date(2026, 5, 15));
    const { timeMin, timeMax } = monthWindowRange(months);
    expect(timeMin).toBe('2026-06-01T00:00:00Z');
    expect(timeMax).toBe('2026-09-30T23:59:59Z');
  });

  it('computes the correct last day for a non-leap February window', () => {
    // Window ending in February 2027 (28 days, non-leap year).
    const months = buildMonthWindow(4, new Date(2026, 10, 1)); // Nov 2026 .. Feb 2027
    const { timeMin, timeMax } = monthWindowRange(months);
    expect(timeMin).toBe('2026-11-01T00:00:00Z');
    expect(timeMax).toBe('2027-02-28T23:59:59Z');
  });
});
