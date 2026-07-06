import { describe, it, expect } from 'vitest';
import { detectRecurringGroups } from '../utils/events';
import type { CalendarEvent } from '../types';

// Minimal event factory — only the fields detectRecurringGroups reads matter.
const ev = (over: Partial<CalendarEvent> & { id: string; start: string }): CalendarEvent => ({
  title: 'Untitled',
  category: 'Other',
  ...over,
});

// Build N daily instances of a series. A Google series shares a recurringEventId; an imported series
// has no recurringEventId but shares a sourceId (the heuristic path now requires one).
const series = (
  prefix: string,
  recurringEventId: string | undefined,
  title: string,
  startDay: number,
  count: number,
  members: string[],
  sourceId?: string,
): CalendarEvent[] =>
  Array.from({ length: count }, (_, i) =>
    ev({
      id: `${prefix}-${i}`,
      title,
      start: `2026-06-${String(startDay + i).padStart(2, '0')}`,
      members,
      recurringEventId,
      sourceId,
    }),
  );

describe('detectRecurringGroups', () => {
  it('groups a Google series by recurringEventId and flags it at >=3 days', () => {
    const events = series('g', 'series-1', 'Daily Standup', 1, 5, ['Dad']);
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe('Daily Standup');
    expect(groups[0].member).toBe('Dad');
    expect(groups[0].dayCount).toBe(5);
    expect(groups[0].instanceCount).toBe(5);
    expect(groups[0].eventIds).toHaveLength(5);
    expect(groups[0].startDate).toBe('2026-06-01');
    expect(groups[0].endDate).toBe('2026-06-05');
  });

  it('does NOT flag a series spanning fewer than minInstances days', () => {
    const events = series('g', 'series-1', 'Twice', 1, 2, ['Mom']);
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('falls back to a title+member heuristic for an IMPORTED series (shared sourceId)', () => {
    const events = series('m', undefined, 'Walk dog', 10, 4, ['Mom'], 'src-1');
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].dayCount).toBe(4);
    expect(groups[0].groupId.startsWith('heur:')).toBe(true);
    expect(groups[0].groupId).toContain('src-1'); // scoped to the import
  });

  it('does NOT group manual same-title one-offs (no sourceId) — avoids a bogus deletable series', () => {
    // Three unrelated manual events that merely share a title must not look like a recurring series.
    const events = [
      ev({ id: 'm1', title: 'Birthday Party', start: '2026-06-03', members: ['Mom'] }),
      ev({ id: 'm2', title: 'Birthday Party', start: '2026-06-14', members: ['Mom'] }),
      ev({ id: 'm3', title: 'Birthday Party', start: '2026-06-25', members: ['Mom'] }),
    ];
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('does NOT merge same-title events imported from DIFFERENT sources (title-only would over-group)', () => {
    const events = [
      ...series('a', undefined, 'Practice', 1, 2, ['Leo'], 'src-A'),   // 06-01, 06-02
      ...series('b', undefined, 'Practice', 10, 2, ['Leo'], 'src-B'),  // 06-10, 06-11
    ];
    // Title-only keying would see 4 distinct days (>=3) and flag a bogus series; sourceId-scoping keeps
    // them as two 2-day runs → neither reaches the threshold → no group.
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('does not merge distinct titles for the same member (one import)', () => {
    const events = [
      ...series('a', undefined, 'Walk dog', 1, 3, ['Mom'], 'src-1'),
      ...series('b', undefined, 'Make lunch', 1, 3, ['Mom'], 'src-1'),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.title).sort()).toEqual(['Make lunch', 'Walk dog']);
  });

  it('collapses a series shared across members into ONE group listing all members', () => {
    // The same cards are tagged to both people (e.g. a shared event pulled from two
    // calendars). They must not appear as two rows that each "delete both".
    const events = series('s', 'fam-1', 'Dinner', 1, 3, ['Mom', 'Dad']);
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].member).toBe('Dad & Mom'); // members sorted, joined
    expect(groups[0].instanceCount).toBe(3);
    expect(groups[0].dayCount).toBe(3);
  });

  it('keeps DISTINCT cards per member as separate groups (not collapsed)', () => {
    // Different underlying events (different ids) for each person → stay separate.
    const events = [
      ...series('a', undefined, 'Reading', 1, 3, ['Mom'], 'src-1'),
      ...series('b', undefined, 'Reading', 1, 3, ['Dad'], 'src-1'),
    ];
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(2);
    expect(groups.map(g => g.member).sort()).toEqual(['Dad', 'Mom']);
  });

  it('counts DISTINCT days, so multiple same-day copies do not fake a daily series', () => {
    const events = [
      ev({ id: 'x1', title: 'Meeting', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'x2', title: 'Meeting', start: '2026-06-01', members: ['Dad'] }),
      ev({ id: 'x3', title: 'Meeting', start: '2026-06-01', members: ['Dad'] }),
    ];
    // 3 cards but only 1 distinct day → not "daily".
    expect(detectRecurringGroups(events)).toHaveLength(0);
  });

  it('treats events with no members as the Family calendar', () => {
    const events = series('f', 'fam-2', 'Trash day', 1, 3, []);
    const groups = detectRecurringGroups(events);
    expect(groups).toHaveLength(1);
    expect(groups[0].member).toBe('Family');
  });

  it('respects a custom minInstances threshold', () => {
    const events = series('g', 'series-7', 'Vitamins', 1, 5, ['Dad']);
    expect(detectRecurringGroups(events, 7)).toHaveLength(0);
    expect(detectRecurringGroups(events, 5)).toHaveLength(1);
  });

  it('returns an empty array for no events', () => {
    expect(detectRecurringGroups([])).toEqual([]);
  });
});

// ── RRULE-lite (W8): manual repeat → concrete instances, Google-pull shaped ─────────────────────
import { expandRepeatingEvent, REPEAT_DAILY_COUNT, REPEAT_WEEKLY_COUNT } from '../utils/events';

describe('expandRepeatingEvent', () => {
  const base = ev({ id: 'usr-1', start: '2026-07-06', title: 'Soccer practice' });
  let n = 0;
  const makeId = () => `usr-gen-${++n}`;

  it("'' (one-off) passes the event through untouched — no series id", () => {
    const out = expandRepeatingEvent(base, '', makeId);
    expect(out).toEqual([base]);
    expect(out[0].recurringEventId).toBeUndefined();
  });

  it('daily → 30 consecutive dates sharing one local series id; the first keeps the base id', () => {
    const out = expandRepeatingEvent(base, 'daily', makeId);
    expect(out).toHaveLength(REPEAT_DAILY_COUNT);
    expect(out[0]).toMatchObject({ id: 'usr-1', start: '2026-07-06', recurringEventId: 'local-rec-usr-1' });
    expect(out[1].start).toBe('2026-07-07');
    expect(out[29].start).toBe('2026-08-04'); // +29 days, across the month boundary
    expect(new Set(out.map(e => e.recurringEventId)).size).toBe(1);
    expect(new Set(out.map(e => e.id)).size).toBe(REPEAT_DAILY_COUNT); // every instance its own id
  });

  it('weekly → 12 same-weekday dates', () => {
    const out = expandRepeatingEvent(base, 'weekly', makeId);
    expect(out).toHaveLength(REPEAT_WEEKLY_COUNT);
    expect(out[1].start).toBe('2026-07-13');
    expect(out[11].start).toBe('2026-09-21'); // +77 days
    const weekday = new Date('2026-07-06T00:00:00Z').getUTCDay();
    expect(out.every(e => new Date(`${e.start}T00:00:00Z`).getUTCDay() === weekday)).toBe(true);
  });

  it('preserves a multi-day span: each instance shifts start AND end together', () => {
    const spanBase = ev({ id: 'usr-2', start: '2026-07-06', end: '2026-07-08', title: 'Camp block' });
    const out = expandRepeatingEvent(spanBase, 'weekly', makeId);
    expect(out[0]).toMatchObject({ start: '2026-07-06', end: '2026-07-08' });
    expect(out[1]).toMatchObject({ start: '2026-07-13', end: '2026-07-15' });
  });

  it('a malformed start date refuses to expand (returns just the base)', () => {
    const bad = ev({ id: 'usr-3', start: 'sometime' });
    expect(expandRepeatingEvent(bad, 'daily', makeId)).toEqual([bad]);
  });

  it('the expanded series is picked up by detectRecurringGroups for bulk delete (the rec: branch)', () => {
    const out = expandRepeatingEvent(base, 'daily', makeId);
    const groups = detectRecurringGroups(out);
    expect(groups).toHaveLength(1);
    expect(groups[0].instanceCount).toBe(REPEAT_DAILY_COUNT);
    expect(groups[0].eventIds).toHaveLength(REPEAT_DAILY_COUNT);
  });
});
