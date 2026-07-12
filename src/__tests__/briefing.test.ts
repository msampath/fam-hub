import { describe, it, expect } from 'vitest';
import { buildCalendarNudges, buildBriefing, buildDinnerLines } from '../utils/briefing';
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

describe('buildDinnerLines (the meal planner in the briefing)', () => {
  const dinnerPlan = {
    weekStart: '2026-06-22',
    days: [
      { date: '2026-06-24', dish: 'Paneer butter masala' },
      { date: '2026-06-25', dish: 'Tacos' },
      { date: '2026-06-27', dish: 'Roast chicken' },
    ],
  };
  it('tonight + tomorrow when both are planned', () => {
    expect(buildDinnerLines([dinnerPlan], TODAY)).toEqual(['🍽 Dinner tonight: Paneer butter masala', '🍽 Tomorrow: Tacos']);
  });
  it('tomorrow-only when tonight is unplanned; empty when neither is', () => {
    expect(buildDinnerLines([dinnerPlan], '2026-06-26')).toEqual(['🍽 Tomorrow: Roast chicken']);
    expect(buildDinnerLines([dinnerPlan], '2026-06-30')).toEqual([]);
    expect(buildDinnerLines(undefined, TODAY)).toEqual([]);
  });
  it('lunch + dinner plans for the same week both speak, chronological order', () => {
    const lunchPlan = { weekStart: '2026-06-22', meal: 'lunch', days: [{ date: '2026-06-24', dish: 'Puliodharai' }] };
    expect(buildDinnerLines([dinnerPlan, lunchPlan], TODAY)).toEqual([
      '🍽 Lunch today: Puliodharai',
      '🍽 Dinner tonight: Paneer butter masala',
      '🍽 Tomorrow: Tacos',
    ]);
    // Only the NEWEST week speaks — an older week's plan is history.
    const oldWeek = { weekStart: '2026-06-15', days: [{ date: TODAY, dish: 'Stale stew' }] };
    expect(buildDinnerLines([dinnerPlan, oldWeek], TODAY)[0]).toBe('🍽 Dinner tonight: Paneer butter masala');
  });
  it('does NOT drop the CURRENT week just because a FUTURE week is also planned', () => {
    // futureWeek's weekStart sorts after dinnerPlan's — picking purely by latest weekStart would have
    // selected futureWeek (which has no entry for TODAY at all) and silently dropped tonight's dinner.
    const futureWeek = { weekStart: '2026-06-29', days: [{ date: '2026-07-01', dish: 'Future feast' }] };
    expect(buildDinnerLines([dinnerPlan, futureWeek], TODAY)).toEqual(['🍽 Dinner tonight: Paneer butter masala', '🍽 Tomorrow: Tacos']);
  });
  it('rides into buildBriefing lines after the agenda', () => {
    const b = buildBriefing([ev('1', 'Dentist', TODAY)], [], TODAY, 14, [dinnerPlan]);
    expect(b.lines[b.lines.length - 2]).toBe('🍽 Dinner tonight: Paneer butter masala');
    expect(b.lines[b.lines.length - 1]).toBe('🍽 Tomorrow: Tacos');
  });
});
