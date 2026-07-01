import { describe, it, expect } from 'vitest';
import { classifyEvent, buildAvailabilityBlock, OFF_KEYWORDS } from '../utils/availability';

// Fixtures anchored at Wednesday 2026-06-17 (matches the other harness tests). Relevant weekdays:
// 06-17 Wed (today), 06-18 Thu, 06-19 Fri (Juneteenth), 06-20 Sat, 06-21 Sun, 06-25 Thu.
const TODAY = '2026-06-17';
const MEMBERS = ['Aisu', 'Srini'];

describe('classifyEvent — time-off vs busy', () => {
  it('treats category Holiday as OFF (free), regardless of title', () => {
    expect(classifyEvent({ title: 'Juneteenth', category: 'Holiday' })).toBe('OFF');
    expect(classifyEvent({ title: 'whatever', category: 'holiday' })).toBe('OFF'); // case-insensitive
  });

  it('treats time-off keyword titles as OFF', () => {
    for (const t of ['Mom OOO', 'Out of Office', 'PTO day', 'Family vacation', 'No School', 'day off', 'Last day of school']) {
      expect(classifyEvent({ title: t })).toBe('OFF');
    }
  });

  it('treats real commitments as BUSY', () => {
    for (const t of ['Dentist appointment', 'Swim practice', 'Work meeting', 'Robotics Camp', 'Piano lesson']) {
      expect(classifyEvent({ title: t })).toBe('BUSY');
    }
  });

  it('defaults a neutral / missing-category event to BUSY', () => {
    expect(classifyEvent({ title: 'Some event' })).toBe('BUSY');
    expect(classifyEvent({})).toBe('BUSY');
  });

  it('matches keywords on word boundaries, not substrings', () => {
    expect(classifyEvent({ title: 'Return laptop' })).toBe('BUSY'); // "pto" inside "laptop" must NOT match
    expect(classifyEvent({ title: 'Vacationland trip' })).toBe('BUSY'); // "vacation" inside "vacationland"
    expect(classifyEvent({ title: 'Holiday Party' })).toBe('BUSY'); // a busy event; "holiday" is not a title keyword
  });

  it('exposes the OFF keyword list', () => {
    expect(OFF_KEYWORDS).toContain('no school');
    expect(OFF_KEYWORDS).toContain('ooo');
  });

  it('lets an explicit freeBusy flag override the keyword/category guess', () => {
    // "OOO sync meeting" reads as time-off by keyword, but it's really a busy meeting.
    expect(classifyEvent({ title: 'OOO sync meeting', freeBusy: 'busy' })).toBe('BUSY');
    // A non-holiday, non-keyword title the owner marks as time off.
    expect(classifyEvent({ title: 'Grandparents visiting', freeBusy: 'free' })).toBe('OFF');
    // The flag wins over the Holiday category too.
    expect(classifyEvent({ title: 'x', category: 'Holiday', freeBusy: 'busy' })).toBe('BUSY');
  });

  it("treats freeBusy 'free' as OFF over a busy-looking title (e.g. a Holiday-calendar Father's Day)", () => {
    expect(classifyEvent({ title: "Father's Day", freeBusy: 'free' })).toBe('OFF');
    expect(classifyEvent({ title: 'Work conference', freeBusy: 'free' })).toBe('OFF');
  });

  it('treats busy-phrase false positives as BUSY without breaking genuine time-off', () => {
    expect(classifyEvent({ title: 'PTO meeting' })).toBe('BUSY');     // Parent-Teacher Org, not time off
    expect(classifyEvent({ title: 'Day off-site' })).toBe('BUSY');    // off-site work day, not a day off
    expect(classifyEvent({ title: 'PTO' })).toBe('OFF');              // genuine time off still OFF
    expect(classifyEvent({ title: 'Last day of school' })).toBe('OFF');
  });

  it('treats bare "off" / "off work" as OFF', () => {
    for (const t of ['Off', 'Off work', 'Parents off today', 'Day Off']) {
      expect(classifyEvent({ title: t })).toBe('OFF');
    }
  });

  it('keeps busy "*off" phrases BUSY (drop-off, kick-off, off-site, off-Broadway)', () => {
    for (const t of ['School drop off', 'School drop-off', 'Project kick-off', 'Soccer kickoff', 'Off-site work day', 'Off-Broadway show']) {
      expect(classifyEvent({ title: t })).toBe('BUSY');
    }
  });

  it('does NOT flip busy compound/"*off" titles to OFF (narrowed from bare \\boff\\b)', () => {
    // Regression: bare "off" matched these as time-off. Now "off" only matches time-off PHRASES/standalone.
    for (const t of ['Play-off game', 'Send-off party', 'One-off task', 'tee-off Saturday', 'Off to work', 'Trade-off review']) {
      expect(classifyEvent({ title: t })).toBe('BUSY');
    }
  });

  it('treats a named holiday as OFF even when mis-categorized (the Father\'s Day backstop)', () => {
    // The recurring "Father's Day reads BUSY" bug: a holiday-cal event left as category 'Other'.
    for (const t of ["Father's Day", "Mother's Day", 'Memorial Day', 'Juneteenth National Independence Day', 'Christmas Day', 'Thanksgiving']) {
      expect(classifyEvent({ title: t, category: 'Other' })).toBe('OFF');
    }
    expect(classifyEvent({ title: 'Holiday Party' })).toBe('BUSY');            // "party" ≠ a named holiday
    expect(classifyEvent({ title: "Father's Day brunch shift", freeBusy: 'busy' })).toBe('BUSY'); // override wins
  });

  it('does NOT mark a holiday-THEMED work commitment as OFF (anchored holiday match)', () => {
    // Regression: HOLIDAY_NAME_RE matched the holiday name anywhere; now it must be the whole title.
    for (const t of ['Memorial Day work shift', "Father's Day brunch shift", 'Christmas Eve shift', 'Labor Day parade volunteer']) {
      expect(classifyEvent({ title: t, category: 'Other' })).toBe('BUSY');
    }
  });

  it('still matches common holiday-calendar title decorations (region parenthetical, year, possessive)', () => {
    // Google holiday calendars title days like "Memorial Day (United States)"; don't regress those to BUSY.
    for (const t of ['Memorial Day (United States)', 'Christmas Day (US Holiday)', 'Labor Day 2026', "President's Day", "Presidents' Day", "Veteran's Day"]) {
      expect(classifyEvent({ title: t, category: 'Other' })).toBe('OFF');
    }
  });
});

describe('buildAvailabilityBlock', () => {
  it('scopes a member-tagged event to that person only', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Swim practice', start: '2026-06-19', members: ['Aisu'], category: 'Sports' },
    ], MEMBERS);
    expect(block).toContain('- Aisu:');
    expect(block).toContain('Friday 2026-06-19: BUSY (Swim practice)'); // weekday matches weekdayOf
    expect(block).not.toContain('- Srini:');
    expect(block).not.toContain('- Everyone:');
  });

  it('treats a "Family"-tagged event as whole-family (the Google-sync default assignee), like "Everyone"', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Spring Break', start: '2026-06-19', members: ['Family'], freeBusy: 'free' },
    ], MEMBERS);
    expect(block).toContain('- Everyone:');     // mapped to the whole-family row
    expect(block).not.toContain('- Family:');   // NOT a phantom per-person "Family" row
  });

  it('treats an untagged or "Everyone" event as family-wide', () => {
    const untagged = buildAvailabilityBlock(TODAY, [
      { title: 'Juneteenth', start: '2026-06-19', category: 'Holiday' },
    ], MEMBERS);
    expect(untagged).toContain('- Everyone:');
    expect(untagged).toContain('Friday 2026-06-19: OFF (Juneteenth)');

    const explicit = buildAvailabilityBlock(TODAY, [
      { title: 'Holiday', start: '2026-06-19', members: ['Everyone'], category: 'Holiday' },
    ], MEMBERS);
    expect(explicit).toContain('- Everyone:');
  });

  it('expands a multi-day event and clamps it to the [today, today+12) window', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Beach vacation', start: '2026-06-16', end: '2026-06-20', members: ['Aisu'] }, // starts pre-today
      { title: 'Future trip', start: '2026-07-15', members: ['Aisu'] }, // beyond the window
    ], MEMBERS);
    expect(block).toContain('Wednesday 2026-06-17: OFF (Beach vacation)'); // clamped to today
    expect(block).toContain('Friday 2026-06-19: OFF (Beach vacation)');
    expect(block).toContain('Saturday 2026-06-20: OFF (Beach vacation)');
    expect(block).not.toContain('2026-06-16'); // pre-today day dropped
    expect(block).not.toContain('2026-07-15'); // out-of-window event dropped entirely
  });

  it('lists both an OFF and a BUSY line when a person has both on one day', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'No school', start: '2026-06-18', members: ['Aisu'] },
      { title: 'Dentist', start: '2026-06-18', members: ['Aisu'] },
    ], MEMBERS);
    expect(block).toContain('Thursday 2026-06-18: OFF (No school)');
    expect(block).toContain('Thursday 2026-06-18: BUSY (Dentist)');
  });

  it('surfaces a BUSY appointment clock window (Bug 5) but not for OFF events', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Bariatric follow-up', start: '2026-06-22', startTime: '14:00', endTime: '15:00', members: ['Aisu'] },
      { title: 'Dentist', start: '2026-06-23', startTime: '09:00', members: ['Aisu'] }, // no end
      { title: 'No school', start: '2026-06-22', startTime: '08:00', members: ['Aisu'] }, // OFF → no time shown
    ], MEMBERS);
    expect(block).toContain('BUSY 14:00–15:00 (Bariatric follow-up)');
    expect(block).toContain('BUSY 09:00 (Dentist)'); // start only when no end
    expect(block).toContain('OFF (No school)'); // OFF lines carry no time
    expect(block).not.toContain('OFF 08:00');
  });

  it('canonicalizes a member tag to the roster name (no ghost lowercase row)', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Swim', start: '2026-06-19', members: ['aisu'], category: 'Sports' }, // lowercase tag
    ], MEMBERS); // roster has 'Aisu'
    expect(block).toContain('- Aisu:');
    expect(block).not.toContain('- aisu:'); // not a separate extra section
  });

  it('attaches a multi-day timed BUSY window only to the start day', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Conference', start: '2026-06-22', end: '2026-06-24', startTime: '09:00', endTime: '17:00', members: ['Aisu'] },
    ], MEMBERS);
    expect(block).toContain('Monday 2026-06-22: BUSY 09:00–17:00 (Conference)'); // start day has the window
    expect(block).toContain('Tuesday 2026-06-23: BUSY (Conference)');            // later days: no clock window
    expect(block).toContain('Wednesday 2026-06-24: BUSY (Conference)');
  });

  it('returns an empty string when nothing falls in the window', () => {
    expect(buildAvailabilityBlock(TODAY, [], MEMBERS)).toBe('');
    expect(buildAvailabilityBlock(TODAY, [{ title: 'x', start: '2026-09-01' }], MEMBERS)).toBe('');
  });

  it('collapses to a single "Family" row when there is no roster', () => {
    const block = buildAvailabilityBlock(TODAY, [
      { title: 'Dentist', start: '2026-06-18' },
    ], []);
    expect(block).toContain('- Family:');
    expect(block).toContain('Thursday 2026-06-18: BUSY (Dentist)');
    expect(block).not.toContain('- Everyone:');
  });

  it('caps a long title in the reason (sanitized to 40 chars, no full title)', () => {
    const long = 'A very long event title that definitely exceeds forty characters by a lot';
    const block = buildAvailabilityBlock(TODAY, [{ title: long, start: '2026-06-18', members: ['Aisu'] }], MEMBERS);
    expect(block).not.toContain(long);
    // the reason is the first 40 chars of the (sanitized) title
    expect(block).toContain('A very long event title that definitely');
  });

  it('includes the authoritative header and the trailing free-by-default note', () => {
    const block = buildAvailabilityBlock(TODAY, [{ title: 'Dentist', start: '2026-06-18', members: ['Aisu'] }], MEMBERS);
    expect(block).toMatch(/^AVAILABILITY \(authoritative/);
    expect(block).toContain('treat that person as free.');
  });
});
