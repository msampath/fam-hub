import { describe, it, expect } from 'vitest';
import { detectRecurringGroups, mergeDeduplicateEvents } from '../utils/events';
import type { CalendarEvent } from '../types';

// QA edge-case coverage for the recurring-daily-events feature. The happy path and
// the core grouping rules live in recurring.test.ts; this file targets boundaries,
// data-shape variations, and the merge/detect interplay that the warning card relies on.

// Default a sourceId so the heuristic (non-Google) path engages — it now groups only IMPORTED events
// sharing a sourceId, never bare manual one-offs. These QA cases exercise detection mechanics
// (boundaries, datetime parsing, whitespace, sorting), which are orthogonal to that gate; the gate
// itself is covered in recurring.test.ts. Tests that pass a recurringEventId use the Google path and
// ignore sourceId. Override with `sourceId: undefined` to model a true manual one-off.
const ev = (over: Partial<CalendarEvent> & { id: string; start: string }): CalendarEvent => ({
  title: 'Untitled',
  category: 'Other',
  sourceId: 'src-qa',
  ...over,
});

describe('detectRecurringGroups — edge cases', () => {
  it('flags at exactly the minInstances boundary (3 distinct days)', () => {
    const events = [
      ev({ id: 'a', title: 'Meds', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'b', title: 'Meds', start: '2026-06-02', members: ['Dad'] }),
      ev({ id: 'c', title: 'Meds', start: '2026-06-03', members: ['Dad'] }),
    ];
    expect(detectRecurringGroups(events)).toHaveLength(1);
  });

  it('does NOT flag at one below the boundary (2 distinct days)', () => {
    const events = [
      ev({ id: 'a', title: 'Meds', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'b', title: 'Meds', start: '2026-06-02', members: ['Dad'] }),
    ];
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('parses datetime starts (Google dateTime form) down to the day', () => {
    // Real Google pull can yield ISO datetimes; the helper splits on "T".
    const events = [
      ev({ id: 'a', title: 'Standup', start: '2026-06-01T09:00:00-04:00', members: ['Dad'] }),
      ev({ id: 'b', title: 'Standup', start: '2026-06-02T09:00:00-04:00', members: ['Dad'] }),
      ev({ id: 'c', title: 'Standup', start: '2026-06-03T09:00:00-04:00', members: ['Dad'] }),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(3);
    expect(groups[0].startDate).toBe('2026-06-01');
    expect(groups[0].endDate).toBe('2026-06-03');
  });

  it('counts a multi-time-per-day series by distinct days, not by card count', () => {
    // Series fires twice each day for 3 days: 6 cards, but only 3 distinct days.
    const events = [
      ev({ id: 'a1', title: 'Pills', start: '2026-06-01T08:00', members: ['Mom'], recurringEventId: 'r' }),
      ev({ id: 'a2', title: 'Pills', start: '2026-06-01T20:00', members: ['Mom'], recurringEventId: 'r' }),
      ev({ id: 'b1', title: 'Pills', start: '2026-06-02T08:00', members: ['Mom'], recurringEventId: 'r' }),
      ev({ id: 'b2', title: 'Pills', start: '2026-06-02T20:00', members: ['Mom'], recurringEventId: 'r' }),
      ev({ id: 'c1', title: 'Pills', start: '2026-06-03T08:00', members: ['Mom'], recurringEventId: 'r' }),
      ev({ id: 'c2', title: 'Pills', start: '2026-06-03T20:00', members: ['Mom'], recurringEventId: 'r' }),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(3);
    expect(groups[0].instanceCount).toBe(6); // all 6 cards get bulk-deleted
    expect(groups[0].eventIds).toHaveLength(6);
  });

  it('skips events with no start date (no day signal)', () => {
    const events = [
      ev({ id: 'a', title: 'Ghost', start: '', members: ['Dad'] }),
      ev({ id: 'b', title: 'Ghost', start: '', members: ['Dad'] }),
      ev({ id: 'c', title: 'Ghost', start: '', members: ['Dad'] }),
    ];
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('normalizes title whitespace/case so cosmetic variants group together (heuristic)', () => {
    const events = [
      ev({ id: 'a', title: 'Walk Dog', start: '2026-06-01', members: ['Mom'] }),
      ev({ id: 'b', title: '  walk dog  ', start: '2026-06-02', members: ['Mom'] }),
      ev({ id: 'c', title: 'WALK DOG', start: '2026-06-03', members: ['Mom'] }),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(3);
    // Display title is taken from the first-seen instance.
    expect(groups[0].title).toBe('Walk Dog');
  });

  it('collapses a multi-member shared series into one group (shared cards are not split per member)', () => {
    const events = [
      ev({ id: 'a', title: 'Dinner', start: '2026-06-01', members: ['Mom', 'Dad'], recurringEventId: 'r' }),
      ev({ id: 'b', title: 'Dinner', start: '2026-06-02', members: ['Mom', 'Dad'], recurringEventId: 'r' }),
      ev({ id: 'c', title: 'Dinner', start: '2026-06-03', members: ['Mom', 'Dad'], recurringEventId: 'r' }),
    ];
    const groups = detectRecurringGroups(events);
    // One row — deleting it removes the shared cards once; copy lists both members.
    expect(groups).toHaveLength(1);
    expect(groups[0].member).toBe('Dad & Mom');
    expect(groups[0].eventIds.sort()).toEqual(['a', 'b', 'c']);
    expect(groups[0].instanceCount).toBe(3);
  });

  it('sorts most-cluttering (highest dayCount) series first', () => {
    const short = [
      ev({ id: 's1', title: 'Short', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 's2', title: 'Short', start: '2026-06-02', members: ['Dad'] }),
      ev({ id: 's3', title: 'Short', start: '2026-06-03', members: ['Dad'] }),
    ];
    const long = Array.from({ length: 10 }, (_, i) =>
      ev({ id: `l${i}`, title: 'Long', start: `2026-06-${String(i + 1).padStart(2, '0')}`, members: ['Dad'] }),
    );
    const groups = detectRecurringGroups([...short, ...long]);
    expect(groups).toHaveLength(2);
    expect(groups[0].title).toBe('Long'); // 10 days
    expect(groups[1].title).toBe('Short'); // 3 days
    expect(groups[0].dayCount).toBeGreaterThan(groups[1].dayCount);
  });

  it('recurringEventId grouping beats title — same id, different titles still group', () => {
    // A renamed instance keeps the series id; it should not split into two groups.
    const events = [
      ev({ id: 'a', title: 'Standup', start: '2026-06-01', members: ['Dad'], recurringEventId: 'r' }),
      ev({ id: 'b', title: 'Standup (moved)', start: '2026-06-02', members: ['Dad'], recurringEventId: 'r' }),
      ev({ id: 'c', title: 'Standup', start: '2026-06-03', members: ['Dad'], recurringEventId: 'r' }),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(3);
  });

  it('does NOT cross-group two different members running the same titled heuristic series', () => {
    const events = [
      ev({ id: 'm1', title: 'Vitamins', start: '2026-06-01', members: ['Mom'] }),
      ev({ id: 'm2', title: 'Vitamins', start: '2026-06-02', members: ['Mom'] }),
      ev({ id: 'm3', title: 'Vitamins', start: '2026-06-03', members: ['Mom'] }),
      ev({ id: 'd1', title: 'Vitamins', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'd2', title: 'Vitamins', start: '2026-06-02', members: ['Dad'] }),
    ];
    const groups = detectRecurringGroups(events);
    // Mom has 3 days (flagged); Dad has only 2 (not flagged).
    expect(groups).toHaveLength(1);
    expect(groups[0].member).toBe('Mom');
  });

  it('falls back to "Untitled event" label when title is empty (heuristic groups by empty key)', () => {
    const events = [
      ev({ id: 'a', title: '', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'b', title: '', start: '2026-06-02', members: ['Dad'] }),
      ev({ id: 'c', title: '', start: '2026-06-03', members: ['Dad'] }),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Untitled event');
  });
});

describe('mergeDeduplicateEvents <-> detectRecurringGroups interplay', () => {
  it('dedup does NOT collapse a daily series (distinct start dates = distinct keys)', () => {
    // Each daily instance has a unique start, so the merge key differs and all survive;
    // the warning card then has a real series to flag.
    const raw = Array.from({ length: 4 }, (_, i) =>
      ev({
        id: `g-${i}`,
        title: 'Daily Standup',
        start: `2026-06-0${i + 1}`,
        members: ['Dad'],
        recurringEventId: 'series-1',
      }),
    );
    const merged = mergeDeduplicateEvents(raw);
    expect(merged).toHaveLength(4); // nothing collapsed
    const groups = detectRecurringGroups(merged);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(4);
  });

  it('dedup collapses true same-day duplicates BEFORE detection so they cannot fake a series', () => {
    // Two feeds import the identical event for 3 days → 6 cards, but dedup leaves 3,
    // one per day, which is a legitimate daily series.
    const feedA = Array.from({ length: 3 }, (_, i) =>
      ev({ id: `a-${i}`, title: 'Yoga', start: `2026-06-0${i + 1}`, members: ['Mom'] }),
    );
    const feedB = Array.from({ length: 3 }, (_, i) =>
      ev({ id: `b-${i}`, title: 'Yoga', start: `2026-06-0${i + 1}`, members: ['Mom'] }),
    );
    const merged = mergeDeduplicateEvents([...feedA, ...feedB]);
    expect(merged).toHaveLength(3); // dupes collapsed per day
    const groups = detectRecurringGroups(merged);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(3);
    expect(groups[0].instanceCount).toBe(3); // only the surviving cards get deleted
  });

  it('merge promotes a gcal id to a local id, keeping the deletable id stable for bulk delete', () => {
    const merged = mergeDeduplicateEvents([
      ev({ id: 'gcal-1-x', title: 'Lunch', start: '2026-06-01', members: ['Mom'] }),
      ev({ id: 'local-1', title: 'Lunch', start: '2026-06-01', members: ['Mom'] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('local-1'); // editable/deletable id wins
  });

  it('merge unions members so a shared series is detectable on each calendar', () => {
    const merged = mergeDeduplicateEvents([
      ev({ id: '1', title: 'Dinner', start: '2026-06-01', members: ['Mom'] }),
      ev({ id: '1b', title: 'Dinner', start: '2026-06-01', members: ['Dad'] }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].members?.sort()).toEqual(['Dad', 'Mom']);
  });
});
