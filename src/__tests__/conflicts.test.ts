import { describe, it, expect } from 'vitest';
import { groupConflicts, conflictResolutionPrompt, filterConflictWindow, detectConflicts, timedOverlap } from '../utils/conflicts';
import type { CalendarEvent } from '../types';

const tev = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: id, start: '2026-07-04', category: 'Other', members: ['Dad'], ...over,
});

describe('timedOverlap', () => {
  it('overlapping ranges clash; touching boundaries and disjoint ranges do not', () => {
    expect(timedOverlap('09:00', '10:30', '10:00', '11:00')).toBe(true);
    expect(timedOverlap('09:00', '10:00', '10:00', '11:00')).toBe(false); // touch
    expect(timedOverlap('09:00', '10:00', '16:00', '17:00')).toBe(false); // disjoint
  });
  it('missing end ⇒ default 60m, so same-start events clash', () => {
    expect(timedOverlap('16:00', undefined, '16:00', undefined)).toBe(true);
    expect(timedOverlap('16:00', undefined, '16:30', undefined)).toBe(true);
    expect(timedOverlap('16:00', undefined, '17:00', undefined)).toBe(false);
  });
  it('an end before its start crosses midnight and still clashes with an overnight event', () => {
    // 22:00–01:00 overlaps 23:30–00:30 — without unwrapping, both intervals read as empty and missed.
    expect(timedOverlap('22:00', '01:00', '23:30', '00:30')).toBe(true);
    // 22:00–01:00 vs 01:30–02:00 (next-day, no wrap) stay disjoint — touching at 01:00 doesn't clash.
    expect(timedOverlap('22:00', '01:00', '01:30', '02:00')).toBe(false);
  });
});

describe('detectConflicts (time-aware)', () => {
  it('flags two overlapping TIMED events for the same member', () => {
    const c = detectConflicts([tev('a', { startTime: '09:00', endTime: '10:30' }), tev('b', { startTime: '10:00', endTime: '11:00' })]);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ date: '2026-07-04', member: 'Dad' });
    expect(c[0].overlappingEvents.map(e => e.id).sort()).toEqual(['a', 'b']);
  });
  it('does NOT flag two non-overlapping timed events on the same day', () => {
    expect(detectConflicts([tev('a', { startTime: '09:00', endTime: '10:00' }), tev('b', { startTime: '16:00', endTime: '17:00' })])).toHaveLength(0);
  });
  it('does NOT flag all-day events (holiday vs no-school) or all-day vs timed', () => {
    expect(detectConflicts([tev('holiday'), tev('noschool')])).toHaveLength(0);
    expect(detectConflicts([tev('holiday'), tev('soccer', { startTime: '16:00', endTime: '17:00' })])).toHaveLength(0);
  });
  it('is per-member (a member who only has one of the events is not in conflict)', () => {
    const c = detectConflicts([
      tev('a', { startTime: '09:00', endTime: '10:00', members: ['Dad', 'Mom'] }),
      tev('b', { startTime: '09:30', endTime: '10:30', members: ['Dad'] }),
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].member).toBe('Dad');
  });
});

const ev = (id: string, title: string): CalendarEvent => ({ id, title, start: '2026-07-02', category: 'Other' });
const c = (date: string, member: string, titles: string[]) => ({
  date, member, overlappingEvents: titles.map((t, i) => ev(`${t}-${date}-${i}`, t)),
});

describe('groupConflicts', () => {
  it('clubs the same member + clashing titles across days into one group', () => {
    const groups = groupConflicts([
      c('2026-07-02', 'Dad', ['Soccer', 'Piano']),
      c('2026-07-03', 'Dad', ['Piano', 'Soccer']), // order-independent
      c('2026-07-04', 'Dad', ['Soccer', 'Piano']),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].dates).toEqual(['2026-07-02', '2026-07-03', '2026-07-04']);
    expect(groups[0].titles).toEqual(['Piano', 'Soccer']); // sorted
  });

  it('keeps different members or different clashes separate', () => {
    const groups = groupConflicts([
      c('2026-07-02', 'Dad', ['Soccer', 'Piano']),
      c('2026-07-02', 'Mom', ['Soccer', 'Piano']), // different member
      c('2026-07-05', 'Dad', ['Camp', 'Trip']),    // different clash
    ]);
    expect(groups).toHaveLength(3);
  });

  it('sorts most-recurring first', () => {
    const groups = groupConflicts([
      c('2026-07-10', 'Dad', ['A', 'B']),
      c('2026-07-02', 'Mom', ['C', 'D']),
      c('2026-07-03', 'Mom', ['C', 'D']),
    ]);
    expect(groups[0].member).toBe('Mom');
    expect(groups[0].count).toBe(2);
  });

  it('dedups repeated dates within a group', () => {
    const groups = groupConflicts([c('2026-07-02', 'Dad', ['A', 'B']), c('2026-07-02', 'Dad', ['B', 'A'])]);
    expect(groups[0].count).toBe(1);
  });

  it('empty input → []', () => {
    expect(groupConflicts([])).toEqual([]);
  });
});

describe('filterConflictWindow', () => {
  const win = (d: string) => ({ date: d, member: 'Dad', overlappingEvents: [] });
  it('drops conflicts before today and beyond the horizon (inclusive bounds)', () => {
    const all = [win('2026-06-09'), win('2026-06-16'), win('2026-06-23'), win('2026-06-30'), win('2026-07-05')];
    const kept = filterConflictWindow(all, '2026-06-16', '2026-06-30'); // today .. +14
    expect(kept.map(c => c.date)).toEqual(['2026-06-16', '2026-06-23', '2026-06-30']);
  });
  it('empty when nothing falls in the window', () => {
    expect(filterConflictWindow([win('2026-01-01')], '2026-06-16', '2026-06-30')).toEqual([]);
  });
});

describe('conflictResolutionPrompt', () => {
  it('single conflict → date-specific prompt', () => {
    const [g] = groupConflicts([c('2026-06-18', 'Leo', ['Soccer', 'Piano'])]);
    const p = conflictResolutionPrompt(g);
    expect(p).toContain('resolve the conflict on 2026-06-18');
    expect(p).toContain('Piano and Soccer');
  });

  it('recurring → date range + recurring wording', () => {
    const [g] = groupConflicts([
      c('2026-07-02', 'Dad', ['Soccer', 'Piano']),
      c('2026-07-04', 'Dad', ['Soccer', 'Piano']),
    ]);
    const p = conflictResolutionPrompt(g);
    expect(p).toContain('recurring overlap');
    expect(p).toContain('2 days (2026-07-02 to 2026-07-04)');
  });
});
