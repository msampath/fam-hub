import { describe, it, expect } from 'vitest';
import { currentWeekDates, weeklyActivity } from '../utils/coordination';
import { parseLocalDate } from '../utils/dates';
import type { CalendarEvent } from '../types';

const ev = (id: string, start: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: 'E', start, category: 'Other', ...over,
});

const WEEK = ['2026-06-15', '2026-06-16', '2026-06-17', '2026-06-18', '2026-06-19', '2026-06-20', '2026-06-21'];

describe('currentWeekDates', () => {
  it('returns the 7 Monday-start dates of the week containing ref', () => {
    const week = currentWeekDates(new Date(2026, 5, 17)); // Wed Jun 17 2026
    expect(week).toEqual(WEEK);
    expect(parseLocalDate(week[0]).getDay()).toBe(1); // Monday
    expect(parseLocalDate(week[6]).getDay()).toBe(0); // Sunday
  });

  it('keeps Sunday in the same Monday-start week', () => {
    const week = currentWeekDates(new Date(2026, 5, 21)); // Sun Jun 21
    expect(week[0]).toBe('2026-06-15');
    expect(week[6]).toBe('2026-06-21');
  });
});

describe('weeklyActivity', () => {
  it('counts days covered + distinct events; excludes out-of-week events', () => {
    const events = [ev('a', '2026-06-15'), ev('b', '2026-06-15'), ev('c', '2026-06-17'), ev('x', '2026-06-30')];
    const r = weeklyActivity(events, WEEK);
    expect(r.daysCovered).toBe(2);   // the 15th and 17th
    expect(r.eventCount).toBe(3);    // a, b, c distinct (x is outside the week)
    expect(r.totalDays).toBe(7);
    expect(r.pct).toBe(29);          // round(2/7*100)
  });

  it('a multi-day event covers each spanned day but counts as one distinct event', () => {
    const r = weeklyActivity([ev('span', '2026-06-15', { end: '2026-06-17' })], WEEK);
    expect(r.daysCovered).toBe(3);
    expect(r.eventCount).toBe(1);
  });

  it('empty week → 0%', () => {
    expect(weeklyActivity([], WEEK)).toEqual({ daysCovered: 0, totalDays: 7, pct: 0, eventCount: 0 });
  });

  it('excludes holidays / time-off from daysCovered but keeps them in eventCount (Bug 8)', () => {
    const events = [
      ev('hol', '2026-06-19', { category: 'Holiday' }),       // Juneteenth → OFF, not a booked day
      ev('off', '2026-06-20', { title: 'No school' }),        // OFF keyword → not booked
      ev('busy', '2026-06-17', { title: 'Dentist' }),         // BUSY → booked
      ev('both1', '2026-06-18', { category: 'Holiday' }),     // OFF on 6/18 …
      ev('both2', '2026-06-18', { title: 'Swim practice' }),  // … plus BUSY on 6/18 → booked once
    ];
    const r = weeklyActivity(events, WEEK);
    expect(r.daysCovered).toBe(2);  // only 6/17 (Dentist) and 6/18 (Swim) — holidays/off excluded
    expect(r.eventCount).toBe(5);   // every event still counted
    expect(r.pct).toBe(29);
  });

  it('honors an explicit freeBusy override for the days-covered count', () => {
    const events = [
      ev('f', '2026-06-17', { freeBusy: 'free' }),                                   // marked time off → not booked
      ev('b', '2026-06-18', { category: 'Holiday', freeBusy: 'busy' }),              // override → booked
    ];
    expect(weeklyActivity(events, WEEK).daysCovered).toBe(1); // only 6/18
  });
});
