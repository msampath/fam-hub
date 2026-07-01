import { describe, it, expect } from 'vitest';
import { nthWeekday, usHolidays, computeOffDays, buildLongWeekendBlock } from '../utils/longWeekend';

describe('nthWeekday', () => {
  it('computes nth and last weekdays (UTC, no tz drift)', () => {
    expect(nthWeekday(2026, 1, 1, 3)).toBe('2026-01-19');   // 3rd Monday of Jan 2026 (MLK)
    expect(nthWeekday(2026, 11, 4, 4)).toBe('2026-11-26');  // 4th Thursday of Nov 2026 (Thanksgiving)
    expect(nthWeekday(2026, 5, 1, -1)).toBe('2026-05-25');  // last Monday of May 2026 (Memorial)
    expect(nthWeekday(2026, 9, 1, 1)).toBe('2026-09-07');   // 1st Monday of Sep 2026 (Labor)
  });
});

describe('usHolidays', () => {
  it('returns the named-holiday backstop for a year, including Juneteenth', () => {
    const h = usHolidays(2026);
    expect(h.get('2026-06-19')).toBe('Juneteenth');
    expect(h.get('2026-07-04')).toBe('Independence Day');
    expect(h.get('2026-12-25')).toBe('Christmas Day');
    expect(h.get('2026-05-25')).toBe('Memorial Day');
    expect(h.get('2026-02-16')).toBe("Presidents' Day");
  });
  it('adds the observed weekday for a fixed holiday on a weekend (Sat→Fri, Sun→Mon)', () => {
    const h = usHolidays(2026); // July 4 2026 is a Saturday → observed Fri Jul 3
    expect(h.get('2026-07-04')).toBe('Independence Day');
    expect(h.get('2026-07-03')).toBe('Independence Day (observed)');
    // 2027: July 4 is a Sunday → observed Mon Jul 5; Christmas Dec 25 is a Saturday → observed Fri Dec 24
    const h27 = usHolidays(2027);
    expect(h27.get('2027-07-05')).toBe('Independence Day (observed)');
    expect(h27.get('2027-12-24')).toBe('Christmas Day (observed)');
  });
  it('adds the day-after-Thanksgiving Friday bridge', () => {
    expect(usHolidays(2026).get('2026-11-27')).toBe('Day after Thanksgiving'); // Thanksgiving = Thu 11/26
  });
});

// Fixtures anchored at Wednesday 2026-06-17 (matches the other harness tests). 06-19 Fri is
// Juneteenth; 06-20 Sat / 06-21 Sun are the weekend; 06-22 Mon is a normal day.
const TODAY = '2026-06-17';

describe('computeOffDays', () => {
  it('unions weekends, the holiday backstop, and OFF calendar events', () => {
    const off = computeOffDays(TODAY, [
      { title: 'No school', start: '2026-06-18' },                        // OFF keyword → off, named
      { title: 'Dentist', start: '2026-06-22', members: ['Aisu'] },       // BUSY → not off
    ]);
    expect(off.get('2026-06-19')).toBe('Juneteenth');  // holiday backstop
    expect(off.get('2026-06-20')).toBe('');            // Saturday (plain weekend)
    expect(off.get('2026-06-21')).toBe('');            // Sunday
    expect(off.get('2026-06-18')).toBe('No school');   // OFF event, named reason
    expect(off.has('2026-06-22')).toBe(false);         // BUSY event doesn't create an off-day
    expect(off.has('2026-06-17')).toBe(false);         // today is a normal Wednesday
  });

  it('an explicit freeBusy="free" event marks the day off', () => {
    const off = computeOffDays(TODAY, [
      { title: 'Grandparents visiting', start: '2026-06-22', freeBusy: 'free', members: ['Everyone'] },
    ]);
    expect(off.get('2026-06-22')).toBe('Grandparents visiting');
  });
});

describe('computeOffDays — family-wide gate (whole family must be off)', () => {
  const ROSTER = ['Dad', 'Mom', 'Leo', 'Mia'];

  it('a single-member (kids-only) OFF event does NOT mark a family off-day', () => {
    const off = computeOffDays(TODAY, [
      { title: 'No school', start: '2026-06-22', members: ['Leo', 'Mia'] }, // kids off, parents working
    ], ROSTER);
    expect(off.has('2026-06-22')).toBe(false);
  });

  it('marks the day off only when every member is off (kids AND both parents)', () => {
    const off = computeOffDays(TODAY, [
      { title: 'No school', start: '2026-06-22', members: ['Leo', 'Mia'] },
      { title: 'PTO', start: '2026-06-22', freeBusy: 'free', members: ['Dad', 'Mom'] },
    ], ROSTER);
    expect(off.get('2026-06-22')).toBe('No school'); // first OFF event supplies the reason
  });

  it('an untagged / "Everyone" OFF event still covers the whole family', () => {
    const off = computeOffDays(TODAY, [
      { title: 'Family day', start: '2026-06-22', freeBusy: 'free', members: ['Everyone'] },
    ], ROSTER);
    expect(off.get('2026-06-22')).toBe('Family day');
  });

  it('a "Family"-tagged OFF event covers the whole family (the imported-calendar default assignee)', () => {
    // Regression: 'Family' (Google-sync default) was not recognized as whole-family, so imported
    // whole-family OFF events were dropped from the long weekend.
    const off = computeOffDays(TODAY, [
      { title: 'Spring Break', start: '2026-06-22', freeBusy: 'free', members: ['Family'] },
    ], ROSTER);
    expect(off.get('2026-06-22')).toBe('Spring Break');
  });

  it('a Holiday-category event bypasses the gate (everyone-off by nature, even if tagged to one person)', () => {
    const off = computeOffDays(TODAY, [
      { title: 'Eid', start: '2026-06-22', category: 'Holiday', members: ['Mom'] },
    ], ROSTER);
    expect(off.get('2026-06-22')).toBe('Eid');
  });

  it('the Holiday title wins the day label over a coincident single-member OFF event', () => {
    const off = computeOffDays(TODAY, [
      { title: 'No school', start: '2026-06-22', members: ['Leo'] },          // single-member, listed first
      { title: 'Eid', start: '2026-06-22', category: 'Holiday', members: ['Mom'] }, // the family-wide cause
    ], ROSTER);
    expect(off.get('2026-06-22')).toBe('Eid');
  });
});

describe('buildLongWeekendBlock', () => {
  it('emits the Juneteenth long weekend and names the adjacent Monday as NOT part of it', () => {
    const block = buildLongWeekendBlock(TODAY, []);
    expect(block).toMatch(/^LONG WEEKEND/);
    expect(block).toContain('Friday 2026-06-19: Juneteenth');
    expect(block).toContain('Saturday 2026-06-20');
    expect(block).toContain('Sunday 2026-06-21');
    // Only the FIRST qualifying run — the following weekend (6/27–6/28) is not pulled in.
    expect(block).not.toContain('2026-06-27');
    // The adjacent normal weekday is explicitly called out.
    expect(block).toContain('Monday 2026-06-22');
    expect(block).toContain('NOT part of the long weekend');
  });

  it('returns "" when the window has only an ordinary Sat+Sun weekend (no adjacent off day)', () => {
    // Mon 2026-07-06; window 07-06..07-17 has only the 07-11/07-12 weekend and no adjacent holiday.
    expect(buildLongWeekendBlock('2026-07-06', [])).toBe('');
  });

  it('emits the July-4-on-Saturday long weekend via the observed Friday', () => {
    // Tue 2026-06-30; July 4 2026 is a Saturday → observed Fri 7/3, so Fri–Sun is a long weekend.
    const block = buildLongWeekendBlock('2026-06-30', []);
    expect(block).toMatch(/^LONG WEEKEND/);
    expect(block).toContain('Friday 2026-07-03: Independence Day (observed)');
    expect(block).toContain('Saturday 2026-07-04: Independence Day');
    expect(block).toContain('Sunday 2026-07-05');
    expect(block).toContain('Monday 2026-07-06'); // adjacent normal day called out
  });

  it('emits the Thanksgiving 4-day weekend via the Friday bridge', () => {
    // Mon 2026-11-23; Thanksgiving Thu 11/26 + Fri 11/27 bridge + Sat/Sun.
    const block = buildLongWeekendBlock('2026-11-23', []);
    expect(block).toContain('Thursday 2026-11-26: Thanksgiving');
    expect(block).toContain('Friday 2026-11-27: Day after Thanksgiving');
    expect(block).toContain('Saturday 2026-11-28');
    expect(block).toContain('Sunday 2026-11-29');
  });

  it('an explicit free Monday extends the long weekend to include it', () => {
    const block = buildLongWeekendBlock(TODAY, [
      { title: 'Family day', start: '2026-06-22', freeBusy: 'free', members: ['Everyone'] },
    ]);
    expect(block).toContain('Monday 2026-06-22: Family day');
    // Now the adjacent normal day shifts to Tuesday.
    expect(block).toContain('Tuesday 2026-06-23');
  });

  it('a kids-only day off does NOT extend the long weekend (parents still working)', () => {
    const block = buildLongWeekendBlock(TODAY, [
      { title: 'No school', start: '2026-06-22', members: ['Leo', 'Mia'] },
    ], ['Dad', 'Mom', 'Leo', 'Mia']);
    // Juneteenth Fri + weekend only; Monday 6/22 stays the adjacent NORMAL day, not part of the run.
    expect(block).toContain('Friday 2026-06-19: Juneteenth');
    expect(block).not.toContain('Monday 2026-06-22: No school');
    expect(block).toContain('Monday 2026-06-22');
    expect(block).toContain('NOT part of the long weekend');
  });

  it('extends through a day when the WHOLE family is off', () => {
    const block = buildLongWeekendBlock(TODAY, [
      { title: 'No school', start: '2026-06-22', members: ['Leo', 'Mia'] },
      { title: 'PTO', start: '2026-06-22', freeBusy: 'free', members: ['Dad', 'Mom'] },
    ], ['Dad', 'Mom', 'Leo', 'Mia']);
    expect(block).toContain('Monday 2026-06-22'); // now part of the run
    expect(block).toContain('Tuesday 2026-06-23'); // adjacent shifts to Tuesday
  });

  it('a Holiday-category Monday makes a long weekend even if no parent marked off', () => {
    const block = buildLongWeekendBlock(TODAY, [
      { title: 'Eid', start: '2026-06-22', category: 'Holiday', members: ['Mom'] },
    ], ['Dad', 'Mom', 'Leo', 'Mia']);
    expect(block).toContain('Monday 2026-06-22: Eid');
    expect(block).toContain('Tuesday 2026-06-23'); // adjacent shifts to Tuesday
  });
});
