import { describe, it, expect } from 'vitest';
import {
  resolveAssignee,
  resolveAssignees,
  resolveMembers,
  buildEventFromPayload,
  buildEventUpdateFromPayload,
  buildChoreFromPayload,
  buildChoresFromPayload,
  choreDedupeKey,
  isDuplicateChore,
  normalizeShoppingItems,
  suggestionKey,
  buildSuggestionFromPayload,
  buildReservationDraft,
  bookingFromFields,
  buildCartDraft,
  buildHaActionDraft,
  resolveEventDeletion,
} from '../utils/aiActions';
import type { CalendarEvent, Chore, FamilyMember, ShoppingItem } from '../types';

const FAM: FamilyMember[] = [
  { name: 'Dad', role: 'Parent', color: 'indigo' },
  { name: 'Mom', role: 'Parent', color: 'rose' },
  { name: 'Leo', role: 'Kid', color: 'amber' },
  { name: 'Mia', role: 'Kid', color: 'teal' },
];
const STORES = ['Costco', 'Indian Store', 'Grocery Store', 'Other'] as const as readonly ShoppingItem['store'][];

describe('resolveAssignee', () => {
  it('returns the name when it is a real Kid', () => {
    expect(resolveAssignee('Leo', FAM)).toBe('Leo');
  });
  it('falls back to the first Kid for a Parent/unknown name', () => {
    expect(resolveAssignee('Dad', FAM)).toBe('Leo'); // Parent → first Kid
    expect(resolveAssignee('Nobody', FAM)).toBe('Leo');
  });
  it('falls back to first member, then Family, when no Kids', () => {
    expect(resolveAssignee('x', [{ name: 'Dad', role: 'Parent', color: 'indigo' }])).toBe('Dad');
    expect(resolveAssignee('x', [])).toBe('Family');
  });
});

describe('resolveAssignees (multi-kid expansion)', () => {
  it('expands "both"/"all kids"/"everyone"/"each" to every kid', () => {
    expect(resolveAssignees('both kids', FAM)).toEqual(['Leo', 'Mia']);
    expect(resolveAssignees('all kids', FAM)).toEqual(['Leo', 'Mia']);
    expect(resolveAssignees('everyone', FAM)).toEqual(['Leo', 'Mia']);
    expect(resolveAssignees('each kid', FAM)).toEqual(['Leo', 'Mia']);
    expect(resolveAssignees('kids', FAM)).toEqual(['Leo', 'Mia']);
  });
  it('expands an explicit list of ≥2 real kids', () => {
    expect(resolveAssignees('Leo and Mia', FAM)).toEqual(['Leo', 'Mia']);
    expect(resolveAssignees('leo, mia', FAM)).toEqual(['Leo', 'Mia']); // case-insensitive
    expect(resolveAssignees('Leo & Mia', FAM)).toEqual(['Leo', 'Mia']);
  });
  it('returns a single assignee for a single name or unknown', () => {
    expect(resolveAssignees('Leo', FAM)).toEqual(['Leo']);
    expect(resolveAssignees('Dad', FAM)).toEqual(['Leo']); // Parent → first Kid
    expect(resolveAssignees('Nobody', FAM)).toEqual(['Leo']);
  });
  it('degrades sensibly with 0/1 kids even on multi-kid intent', () => {
    expect(resolveAssignees('both kids', [{ name: 'Leo', role: 'Kid', color: 'amber' }])).toEqual(['Leo']);
    expect(resolveAssignees('both kids', [{ name: 'Dad', role: 'Parent', color: 'indigo' }])).toEqual(['Dad']);
    expect(resolveAssignees('both kids', [])).toEqual(['Family']);
  });
  it('an EXACT real-kid name wins over the multi-kid keyword (a kid named "All" is one kid)', () => {
    const fam: FamilyMember[] = [
      { name: 'All', role: 'Kid', color: 'amber' },
      { name: 'Bo', role: 'Kid', color: 'teal' },
    ];
    expect(resolveAssignees('All', fam)).toEqual(['All']);  // not ['All','Bo']
    expect(resolveAssignees('all', fam)).toEqual(['All']);  // case-insensitive exact match
  });
});

describe('resolveMembers', () => {
  it('keeps only roster names + Family/Everyone', () => {
    expect(resolveMembers(['Leo', 'Family', 'Hacker'], FAM)).toEqual(['Leo', 'Family']);
  });
  it('falls back to ["Everyone"] for non-array or all-invalid', () => {
    expect(resolveMembers(undefined, FAM)).toEqual(['Everyone']);
    expect(resolveMembers(['Ghost'], FAM)).toEqual(['Everyone']);
  });
  it('coerces non-string entries before filtering', () => {
    expect(resolveMembers([123, 'Mom'], FAM)).toEqual(['Mom']);
  });
});

describe('buildEventFromPayload', () => {
  it('returns null without a title', () => {
    expect(buildEventFromPayload({}, 'qa', FAM, '2026-06-16')).toBeNull();
  });
  it('clamps category and members, defaults start to today', () => {
    const ev = buildEventFromPayload({ title: 'Swim', category: 'Bogus', members: ['Leo', 'X'] }, 'qa', FAM, '2026-06-16')!;
    expect(ev.title).toBe('Swim');
    expect(ev.category).toBe('Other');
    expect(ev.members).toEqual(['Leo']);
    expect(ev.start).toBe('2026-06-16');
    expect(ev.id.startsWith('qa-')).toBe(true);
  });
  it('keeps a valid category and slices dates to YYYY-MM-DD', () => {
    const ev = buildEventFromPayload({ title: 'Camp', category: 'Camp', start: '2026-07-01T09:00', end: '2026-07-05T15:00' }, 'cop', FAM, '2026-06-16')!;
    expect(ev.category).toBe('Camp');
    expect(ev.start).toBe('2026-07-01');
    expect(ev.end).toBe('2026-07-05');
    expect(ev.members).toEqual(['Everyone']); // none given
  });
  it('accepts valid HH:MM times and pads the hour', () => {
    const ev = buildEventFromPayload({ title: 'Swim', startTime: '4:00', endTime: '17:30' }, 'qa', FAM, '2026-06-16')!;
    expect(ev.startTime).toBe('04:00');
    expect(ev.endTime).toBe('17:30');
  });
  it('drops malformed/out-of-range times', () => {
    const ev = buildEventFromPayload({ title: 'Swim', startTime: '4pm', endTime: '25:99' }, 'qa', FAM, '2026-06-16')!;
    expect(ev.startTime).toBeUndefined();
    expect(ev.endTime).toBeUndefined();
  });
  it('caps an over-long title (defense against a misbehaving/attacked model)', () => {
    const ev = buildEventFromPayload({ title: 'x'.repeat(5000) }, 'qa', FAM, '2026-06-16')!;
    expect(ev.title.length).toBe(200);
  });
  it('carries a provided description (clamped) and defaults to empty', () => {
    expect(buildEventFromPayload({ title: 'Zoo', description: 'bring sunscreen' }, 'cop-sug', FAM, '2026-06-16')!.description).toBe('bring sunscreen');
    expect(buildEventFromPayload({ title: 'Zoo', description: 'y'.repeat(3000) }, 'cop-sug', FAM, '2026-06-16')!.description!.length).toBe(2000);
    expect(buildEventFromPayload({ title: 'Zoo' }, 'cop-sug', FAM, '2026-06-16')!.description).toBe('');
  });
});

describe('suggestionKey', () => {
  it('keys on date + lowercased title (stable across casing/whitespace)', () => {
    expect(suggestionKey({ start: '2026-06-20', title: 'Woodland Park Zoo' })).toBe('2026-06-20|woodland park zoo');
    expect(suggestionKey({ start: '2026-06-20T09:00', title: '  Woodland Park ZOO ' })).toBe('2026-06-20|woodland park zoo');
    expect(suggestionKey({})).toBe('|');
  });
});

describe('buildEventUpdateFromPayload', () => {
  const EVENTS: CalendarEvent[] = [
    { id: 'e1', title: 'Soccer', start: '2026-06-20', category: 'Sports', members: ['Leo'] },
    { id: 'e2', title: 'Soccer', start: '2026-06-27', category: 'Sports', members: ['Leo'] },
    { id: 'e3', title: 'Dentist', start: '2026-06-22', startTime: '09:00', category: 'Other', members: ['Mia'] },
  ];

  it('resolves the target by id and builds a partial change set', () => {
    const u = buildEventUpdateFromPayload({ id: 'e3', start: '2026-06-23', startTime: '10:30' }, EVENTS, FAM)!;
    expect(u.id).toBe('e3');
    expect(u.changes).toEqual({ start: '2026-06-23', startTime: '10:30' });
    expect(u.before.title).toBe('Dentist');
  });

  it('resolves by matchTitle + matchStart when there are duplicate titles', () => {
    const u = buildEventUpdateFromPayload(
      { matchTitle: 'Soccer', matchStart: '2026-06-27', start: '2026-06-28' }, EVENTS, FAM,
    )!;
    expect(u.id).toBe('e2'); // disambiguated by date
    expect(u.changes).toEqual({ start: '2026-06-28' });
  });

  it('returns null when the title is ambiguous and no date disambiguates it', () => {
    expect(buildEventUpdateFromPayload({ matchTitle: 'Soccer', start: '2026-07-01' }, EVENTS, FAM)).toBeNull();
  });

  it('returns null when no event matches', () => {
    expect(buildEventUpdateFromPayload({ matchTitle: 'Piano', start: '2026-07-01' }, EVENTS, FAM)).toBeNull();
    expect(buildEventUpdateFromPayload({ id: 'nope', start: '2026-07-01' }, EVENTS, FAM)).toBeNull();
  });

  it('returns null when the payload changes nothing (all fields equal current)', () => {
    expect(buildEventUpdateFromPayload({ id: 'e1', start: '2026-06-20', category: 'Sports' }, EVENTS, FAM)).toBeNull();
  });

  it('clamps changed fields (category whitelist, members roster, HH:MM time) and never includes id/sourceId', () => {
    const u = buildEventUpdateFromPayload(
      { id: 'e1', category: 'Bogus', members: ['Mia', 'Hacker'], startTime: '4:00' }, EVENTS, FAM,
    )!;
    expect(u.changes.category).toBeUndefined(); // bogus → coerced to current 'Sports' → no-op → dropped
    expect(u.changes.members).toEqual(['Mia']); // 'Hacker' filtered out; differs from current ['Leo'] → kept
    expect(u.changes.startTime).toBe('04:00'); // '4:00' padded; e1 had no time → kept
    expect((u.changes as any).id).toBeUndefined();
  });

  it('accepts a freeBusy override and validates it to free|busy (mark free without deleting)', () => {
    expect(buildEventUpdateFromPayload({ id: 'e1', freeBusy: 'free' }, EVENTS, FAM)!.changes).toEqual({ freeBusy: 'free' });
    expect(buildEventUpdateFromPayload({ id: 'e1', freeBusy: 'BUSY' }, EVENTS, FAM)!.changes).toEqual({ freeBusy: 'busy' });
    expect(buildEventUpdateFromPayload({ id: 'e1', freeBusy: 'maybe' }, EVENTS, FAM)).toBeNull(); // invalid → no change → null
  });
});

describe('buildSuggestionFromPayload', () => {
  it('builds a clamped suggestion, keeps an http(s) url, drops a non-http one', () => {
    const s = buildSuggestionFromPayload({ title: 'Woodland Park Zoo', start: '2026-07-04', url: 'https://zoo.org', category: 'Arts', note: 'bring water' }, '2026-06-24')!;
    expect(s).toMatchObject({ title: 'Woodland Park Zoo', start: '2026-07-04', url: 'https://zoo.org', category: 'Arts', note: 'bring water' });
    expect(buildSuggestionFromPayload({ title: 'X', start: '2026-07-04', url: 'javascript:alert(1)' }, '2026-06-24')!.url).toBeUndefined();
  });
  it('defaults a missing/garbled date to today and requires a title', () => {
    expect(buildSuggestionFromPayload({ title: 'X' }, '2026-06-24')!.start).toBe('2026-06-24');
    expect(buildSuggestionFromPayload({ start: '2026-07-04' }, '2026-06-24')).toBeNull();
    expect(buildSuggestionFromPayload({ title: '   ' }, '2026-06-24')).toBeNull();
  });
  it('drops an invalid category (not in the whitelist)', () => {
    expect(buildSuggestionFromPayload({ title: 'X', start: '2026-07-04', category: 'Bogus' }, '2026-06-24')!.category).toBeUndefined();
  });
});

describe('buildChoreFromPayload', () => {
  it('returns null without a title', () => {
    expect(buildChoreFromPayload({}, FAM)).toBeNull();
  });
  it('resolves assignee to a Kid and applies numeric/enum defaults', () => {
    const c = buildChoreFromPayload({ title: 'Dishes', assignedTo: 'Dad' }, FAM)!;
    expect(c.assignedTo).toBe('Leo'); // Parent → first Kid
    expect(c.points).toBe(10);
    expect(c.timesPerDay).toBe(1);
    expect(c.repeatType).toBe('daily');
    expect(c.completedCount).toBe(0);
  });
  it('honors provided values and clamps repeatType', () => {
    const c = buildChoreFromPayload({ title: 'Laundry', assignedTo: 'Mia', points: 25, timesPerDay: 2, repeatType: 'weekly' }, FAM)!;
    expect(c.assignedTo).toBe('Mia');
    expect(c.points).toBe(25);
    expect(c.timesPerDay).toBe(2);
    expect(c.repeatType).toBe('weekly');
  });
  it('carries notes (clamped) — regression for the field buildChoreFor silently dropped', () => {
    const c = buildChoreFromPayload({ title: 'Water plants', assignedTo: 'Mia', notes: 'Small cup per pot.' }, FAM)!;
    expect(c.notes).toBe('Small cup per pot.');
    const long = buildChoreFromPayload({ title: 'Read', assignedTo: 'Mia', notes: 'x'.repeat(600) }, FAM)!;
    expect(long.notes).toHaveLength(500);
    expect(buildChoreFromPayload({ title: 'Read', assignedTo: 'Mia' }, FAM)!.notes).toBeUndefined();
  });
  it('coerces a bogus repeatType to daily', () => {
    expect(buildChoreFromPayload({ title: 'x', repeatType: 'hourly' }, FAM)!.repeatType).toBe('daily');
  });
  it('clamps points and timesPerDay to sane integer ranges', () => {
    expect(buildChoreFromPayload({ title: 'x', points: -5 }, FAM)!.points).toBe(1);          // negative → min 1
    expect(buildChoreFromPayload({ title: 'x', points: 1e9 }, FAM)!.points).toBe(1000);       // huge → max 1000
    expect(buildChoreFromPayload({ title: 'x', points: 2.7 }, FAM)!.points).toBe(3);          // fractional → rounded
    expect(buildChoreFromPayload({ title: 'x' }, FAM)!.points).toBe(10);                       // missing → default 10
    expect(buildChoreFromPayload({ title: 'x', timesPerDay: 99 }, FAM)!.timesPerDay).toBe(20); // huge → max 20
    expect(buildChoreFromPayload({ title: 'x', timesPerDay: 0 }, FAM)!.timesPerDay).toBe(1);   // 0 → min 1
  });
});

describe('buildChoresFromPayload (multi-kid)', () => {
  it('returns [] without a title', () => {
    expect(buildChoresFromPayload({}, FAM)).toEqual([]);
  });
  it('creates one chore per kid for multi-kid intent, with distinct ids', () => {
    const chores = buildChoresFromPayload({ title: 'Brush Teeth', assignedTo: 'both kids', timesPerDay: 2 }, FAM);
    expect(chores.map(c => c.assignedTo)).toEqual(['Leo', 'Mia']);
    expect(chores.every(c => c.title === 'Brush Teeth' && c.timesPerDay === 2)).toBe(true);
    expect(new Set(chores.map(c => c.id)).size).toBe(2); // distinct ids
  });
  it('creates a single chore for a single assignee', () => {
    const chores = buildChoresFromPayload({ title: 'Dishes', assignedTo: 'Mia' }, FAM);
    expect(chores).toHaveLength(1);
    expect(chores[0].assignedTo).toBe('Mia');
  });
});

describe('choreDedupeKey / isDuplicateChore', () => {
  const mk = (over: Partial<Chore>): Chore => ({
    id: 'chore-' + Math.random(), title: 'Brush Teeth', assignedTo: 'Leo', points: 10,
    completed: false, completedCount: 0, timesPerDay: 2, repeatType: 'daily', scheduleTimeOfDay: 'Morning',
    ...over,
  });

  it('keys on title+assignee+cadence+slot, case/space-insensitive', () => {
    expect(choreDedupeKey({ title: ' Brush Teeth ', assignedTo: 'LEO', repeatType: 'daily', timesPerDay: 2, scheduleTimeOfDay: 'Morning' }))
      .toBe('brush teeth|leo|daily|2|morning');
  });
  it('detects an identical chore and ignores a different assignee/slot', () => {
    const existing = [mk({ assignedTo: 'Leo' })];
    expect(isDuplicateChore(mk({ assignedTo: 'Leo' }), existing)).toBe(true);
    expect(isDuplicateChore(mk({ assignedTo: 'Mia' }), existing)).toBe(false); // different kid
    expect(isDuplicateChore(mk({ assignedTo: 'Leo', scheduleTimeOfDay: 'Evening' }), existing)).toBe(false); // different slot
  });
});

describe('normalizeShoppingItems', () => {
  it('drops blanks and clamps unknown stores to Grocery Store', () => {
    const items = normalizeShoppingItems(
      [{ text: 'milk', store: 'Costco' }, { text: '  ' }, { text: 'saffron', store: 'Hacker' }],
      STORES,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ text: 'milk', store: 'Costco', completed: false });
    expect(items[1]).toMatchObject({ text: 'saffron', store: 'Grocery Store' });
  });
  it('handles a non-array safely', () => {
    expect(normalizeShoppingItems(undefined as any, STORES)).toEqual([]);
  });
});

// Confirm-tier DRAFT builders (B3 reserve / B4 cart) + the scaffolded B5 HA validator. Per the
// no-payment invariant: links are CONSTRUCTED (never model-supplied), the agent never books/buys/executes.
describe('buildReservationDraft / buildCartDraft / buildHaActionDraft', () => {
  it('reservation draft: summary + a constructed Google booking link; null without a venue', () => {
    const d = buildReservationDraft({ title: 'Cafe Flora', start: '2026-06-28', startTime: '19:00' })!;
    expect(d.summary).toContain('Cafe Flora');
    expect(d.link).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
    expect(buildReservationDraft({ start: '2026-06-28' })).toBeNull();
  });
  it('reservation draft carries a booking stub when a real date is present (drives the on-approval event)', () => {
    expect(buildReservationDraft({ title: 'Cafe Flora', start: '2026-06-28', startTime: '19:00' })!.booking)
      .toEqual({ title: 'Cafe Flora', start: '2026-06-28', startTime: '19:00' });
    // no date → no booking (just the link)
    expect(buildReservationDraft({ title: 'Cafe Flora' })!.booking).toBeUndefined();
  });
  it('bookingFromFields: pulls {title,start,startTime} from handoff Date/Time fields; null without a date', () => {
    expect(bookingFromFields('Din Tai Fung Bellevue', [
      { label: 'Date', value: '2026-07-09' }, { label: 'Time', value: '18:00' }, { label: 'Party Size', value: '4' },
    ])).toEqual({ title: 'Din Tai Fung Bellevue', start: '2026-07-09', startTime: '18:00' });
    expect(bookingFromFields('DTF', [{ label: 'Date', value: '2026-07-09' }])).toEqual({ title: 'DTF', start: '2026-07-09' });
    expect(bookingFromFields('DTF', [{ label: 'Party Size', value: '4' }])).toBeNull(); // no date
  });
  it('bookingFromFields: parses 12h AM/PM times to 24h (a 6:30 PM dinner is NOT 06:30)', () => {
    const t = (v: string) => bookingFromFields('X', [{ label: 'Date', value: '2026-07-09' }, { label: 'Time', value: v }])!.startTime;
    expect(t('6:30 PM')).toBe('18:30');
    expect(t('12:30 AM')).toBe('00:30');
    expect(t('12:00 PM')).toBe('12:00');
    expect(t('9:00 am')).toBe('09:00');
    expect(t('18:00')).toBe('18:00'); // 24h still works
  });
  it('bookingFromFields: a non-date "date" field does not suppress a valid date in a later field', () => {
    expect(bookingFromFields('X', [
      { label: 'Booking date', value: 'tomorrow' }, { label: 'Reservation Date', value: '2026-07-09' },
    ])).toEqual({ title: 'X', start: '2026-07-09' });
  });
  it('cart draft: summary + a constructed Amazon link; null without an item', () => {
    const d = buildCartDraft({ text: 'AA batteries', quantity: 4 })!;
    expect(d.summary).toContain('AA batteries');
    expect(d.link).toMatch(/^https:\/\/www\.amazon\.com\/s\?k=/);
    expect(buildCartDraft({})).toBeNull();
  });
  it('HA action validator (B5 scaffold): allowlists actions, null on anything else', () => {
    expect(buildHaActionDraft({ action: 'arm', entity: 'SimpliSafe' })!.summary).toMatch(/Arm/);
    expect(buildHaActionDraft({ action: 'launch_nukes' })).toBeNull();
    expect(buildHaActionDraft({})).toBeNull();
  });
});

describe('resolveEventDeletion (delete_event scope safety)', () => {
  const evs: CalendarEvent[] = [
    { id: 'e1', title: 'Zoo Day', start: '2026-07-05' } as CalendarEvent,
    { id: 'e2', title: 'Soccer practice', start: '2026-07-06' } as CalendarEvent,
    { id: 'e3', title: 'Soccer practice', start: '2026-07-13' } as CalendarEvent, // recurring → same title, diff dates
    { id: 'e4', title: 'Soccer practice', start: '2026-07-13' } as CalendarEvent, // same title AND date as e3
  ];
  it('refId → exactly that event, never ambiguous', () => {
    expect(resolveEventDeletion(evs, { refId: 'e1' })).toEqual({ victims: [evs[0]], ambiguous: false });
  });
  it('title + start narrows to that date (same-date duplicates are scoped, not ambiguous)', () => {
    const r = resolveEventDeletion(evs, { title: 'Soccer practice', start: '2026-07-13' });
    expect(r.victims.map(e => e.id)).toEqual(['e3', 'e4']);
    expect(r.ambiguous).toBe(false); // the date was specified — scope is intentional (report the count)
  });
  it('title-ONLY matching one event is fine', () => {
    expect(resolveEventDeletion(evs, { title: 'Zoo Day' })).toEqual({ victims: [evs[0]], ambiguous: false });
  });
  it('title-ONLY matching MANY (a recurring series) is AMBIGUOUS — caller must NOT mass-delete', () => {
    const r = resolveEventDeletion(evs, { title: 'Soccer practice' });
    expect(r.victims).toHaveLength(3);
    expect(r.ambiguous).toBe(true);
  });
  it('no match → empty, no title → empty', () => {
    expect(resolveEventDeletion(evs, { title: 'Nope' })).toEqual({ victims: [], ambiguous: false });
    expect(resolveEventDeletion(evs, {})).toEqual({ victims: [], ambiguous: false });
  });
});
