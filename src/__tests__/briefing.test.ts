import { describe, it, expect } from 'vitest';
import { buildCalendarNudges, buildBriefing } from '../utils/briefing';
import type { CalendarEvent, Chore } from '../types';

const ev = (id: string, title: string, start: string): CalendarEvent =>
  ({ id, title, start, category: 'Other' } as CalendarEvent);

const TODAY = '2026-06-24';

describe('buildCalendarNudges', () => {
  it('derives a gift nudge from an upcoming birthday (with a 1-tap list draft)', () => {
    const nudges = buildCalendarNudges([ev('1', "Mia's birthday", '2026-06-28')], TODAY);
    expect(nudges).toHaveLength(1);
    expect(nudges[0].kind).toBe('birthday');
    expect(nudges[0].listItem).toMatch(/Gift for Mia/);
  });

  it('derives a pack nudge from an upcoming trip', () => {
    const nudges = buildCalendarNudges([ev('1', 'Hawaii trip', '2026-06-30')], TODAY);
    expect(nudges[0].kind).toBe('trip');
  });

  it('ignores events outside the horizon and non-matching titles', () => {
    const nudges = buildCalendarNudges([
      ev('1', "Dad's birthday", '2026-09-01'), // beyond 14-day horizon
      ev('2', 'Soccer practice', '2026-06-25'), // no pattern
    ], TODAY);
    expect(nudges).toHaveLength(0);
  });

  it('ignores past events', () => {
    expect(buildCalendarNudges([ev('1', "Sam's birthday", '2026-06-20')], TODAY)).toHaveLength(0);
  });
});

describe('buildBriefing', () => {
  it('combines today’s agenda with nudges', () => {
    const events = [ev('1', 'Dentist', TODAY), ev('2', "Mia's birthday", '2026-06-27')];
    const chores: Chore[] = [{ id: 'c1', title: 'Trash', assignedTo: 'Leo', timesPerDay: 1, completedCount: 0 } as Chore];
    const b = buildBriefing(events, chores, TODAY);
    expect(b.title).toMatch(/Today:/);
    expect(b.lines.length).toBeGreaterThan(0);
    expect(b.nudges).toHaveLength(1);
  });

  it('handles an empty household gracefully', () => {
    const b = buildBriefing([], [], TODAY);
    expect(b.lines).toEqual([]);
    expect(b.nudges).toEqual([]);
  });
});
