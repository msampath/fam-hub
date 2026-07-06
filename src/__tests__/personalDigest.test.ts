// Personalized digest sections + rich nudges: every line must trace to a REAL event/chore — the
// grounding rule these builders exist to enforce (the composing model rephrases, never invents).
import { describe, it, expect } from 'vitest';
import { buildMemberSections, buildRichNudges } from '../utils/personalDigest';
import type { CalendarEvent, Chore, FamilyMember } from '../types';

const TODAY = '2026-07-06';
const member = (name: string, role: 'Parent' | 'Kid' = 'Kid'): FamilyMember => ({ name, role } as FamilyMember);
const ev = (title: string, start: string, over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: title + start, title, start, category: 'Other', ...over } as CalendarEvent);
const chore = (title: string, assignedTo: string, done = 0): Chore =>
  ({ id: title, title, assignedTo, timesPerDay: 1, completedCount: done } as Chore);

describe('buildMemberSections', () => {
  it('gives each member THEIR day (their events + open chores); members with nothing get no section', () => {
    const out = buildMemberSections(
      [member('Ava'), member('Max'), member('You', 'Parent')],
      [ev('Soccer', TODAY, { members: ['Ava'], startTime: '16:00' }), ev('Dinner out', TODAY, { members: ['Family'] })],
      [chore('Feed dog', 'Ava'), chore('Dishes', 'Max', 1)],
      TODAY,
    );
    expect(out).toHaveLength(3); // Family event counts for everyone → all three have content
    expect(out[0]).toContain('For Ava:');
    expect(out[0]).toContain('Soccer at 16:00');
    expect(out[0]).toContain('chore: Feed dog');
    expect(out[1]).toContain('For Max:');
    expect(out[1]).not.toContain('Dishes'); // completed chore doesn't nag
  });

  it('untagged events count for everyone; empty inputs → no sections', () => {
    expect(buildMemberSections([member('Ava')], [ev('Holiday', TODAY)], [], TODAY)[0]).toContain('Holiday');
    expect(buildMemberSections([member('Ava')], [], [], TODAY)).toEqual([]);
  });
});

describe('buildRichNudges', () => {
  it('nudges an upcoming anniversary/birthday and a trip in the 3-7 day prep window', () => {
    const out = buildRichNudges([
      ev('Wedding anniversary', '2026-07-10'),
      ev('Camping trip — Olympic NP', '2026-07-11'),
      ev('Birthday party TODAY', TODAY),          // dd=0 → no gift nudge (too late to plan)
      ev('Trip next month', '2026-08-20'),        // outside the window
    ], TODAY);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Wedding anniversary is in 4 days');
    expect(out[1]).toContain('start the packing list');
  });

  it('Black Friday nudge fires only near the computed date AND with a non-trivial list', () => {
    // 2026: 4th Thursday of November = Nov 26 → Black Friday Nov 27.
    expect(buildRichNudges([], '2026-11-20', 5).some(n => n.includes('2026-11-27'))).toBe(true);
    expect(buildRichNudges([], '2026-11-20', 0)).toEqual([]); // nothing worth holding
    expect(buildRichNudges([], '2026-07-06', 5)).toEqual([]); // nowhere near
  });
});
