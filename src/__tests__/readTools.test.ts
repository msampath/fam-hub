import { describe, it, expect } from 'vitest';
import { READ_TOOL_DEFS, shapeEvents, shapeUpcoming, shapeChores, shapeBills } from '../mcp/readTools';
import type { CalendarEvent, Chore, Bill } from '../types';

const ev = (id: string, title: string, start: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id, title, start, category: 'Other', ...extra } as CalendarEvent);

const EVENTS = [
  ev('1', 'Dentist', '2026-06-24', { startTime: '09:00', members: ['Leo'] }),
  ev('2', 'Soccer', '2026-06-26'),
  ev('3', 'Old thing', '2026-05-01'),
  ev('4', 'Far thing', '2026-09-01'),
];
const CHORES: Chore[] = [
  { id: 'c1', title: 'Trash', assignedTo: 'Leo', timesPerDay: 1, completedCount: 0 } as Chore,
  { id: 'c2', title: 'Dishes', assignedTo: 'Mia', timesPerDay: 1, completedCount: 1 } as Chore,
];
const TODAY = '2026-06-24';

describe('READ_TOOL_DEFS', () => {
  it('declares the read tools with object schemas', () => {
    expect(READ_TOOL_DEFS.map(t => t.name).sort()).toEqual(['get_bills', 'get_chores', 'get_events', 'get_upcoming', 'search_local_knowledge']);
    for (const t of READ_TOOL_DEFS) expect(t.inputSchema.type).toBe('object');
  });
});

describe('shapeBills', () => {
  const BILLS: Bill[] = [
    { id: 'b1', payee: 'Comcast', amount: '$120', dueDate: '2026-07-05' },
    { id: 'b2', payee: 'PSE', amount: '$84', dueDate: '2026-06-20' }, // past relative to TODAY
  ];
  it('sorts soonest-due first and maps to compact fields', () => {
    const out = shapeBills(BILLS, '2026-06-24');
    expect(out.map(b => b.payee)).toEqual(['PSE', 'Comcast']); // 06-20 before 07-05
    expect(out[0]).toMatchObject({ payee: 'PSE', amount: '$84', dueDate: '2026-06-20' });
  });
  it('upcomingOnly drops bills already past due', () => {
    const out = shapeBills(BILLS, '2026-06-24', true);
    expect(out.map(b => b.payee)).toEqual(['Comcast']);
  });
});

describe('shapeEvents / shapeUpcoming', () => {
  it('shapeEvents sorts by date and trims to limit', () => {
    const out = shapeEvents(EVENTS, 2);
    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('2026-05-01'); // earliest first
  });

  it('shapeEvent surfaces time + members when present', () => {
    const out = shapeEvents([EVENTS[0]]);
    expect(out[0]).toMatchObject({ title: 'Dentist', date: '2026-06-24', startTime: '09:00', members: ['Leo'], category: 'Other' });
    expect(out[0]).not.toHaveProperty('allDay'); // a timed event is NOT all-day
  });

  it('shapeEvent flags all-day / holiday events (so the agent never treats them as booking conflicts)', () => {
    const holiday = ev('h', 'Independence Day', '2026-07-04', { category: 'Holiday' }); // no startTime → all-day
    const out = shapeEvents([holiday])[0];
    expect(out).toMatchObject({ title: 'Independence Day', date: '2026-07-04', allDay: true, category: 'Holiday' });
  });

  it('shapeUpcoming includes only today..+days, soonest first', () => {
    const out = shapeUpcoming(EVENTS, TODAY, 7);
    expect(out.map(e => e.title)).toEqual(['Dentist', 'Soccer']); // not the past or far event
  });

  it('shapeEvents from/to scopes to a date window BEFORE limiting (so a far event in-window survives)', () => {
    // limit 1, but the window pins the far Sep event — without the window, slice(1) of the EARLIEST would
    // return "Old thing" (May) and the conflict check would never see September.
    const out = shapeEvents(EVENTS, 1, { from: '2026-09-01', to: '2026-09-01' });
    expect(out.map(e => e.title)).toEqual(['Far thing']);
    // empty window → no events → the agent may honestly report "no conflict"
    expect(shapeEvents(EVENTS, 30, { from: '2026-07-01', to: '2026-07-31' })).toEqual([]);
  });

  it('shapeEvents catches a multi-day event that STARTS before the window but ENDS inside it (span overlap)', () => {
    // "Aisu oncall 7/13-7/19" overlaps a Jul 19-23 trip on its first day. A start-only filter would drop it
    // (start 7/13 < from 7/19) and the agent would miss the conflict — the bug this fixes.
    const oncall = ev('5', 'Aisu oncall', '2026-07-13', { end: '2026-07-19' });
    const out = shapeEvents([...EVENTS, oncall], 30, { from: '2026-07-19', to: '2026-07-23' });
    expect(out.map(e => e.title)).toEqual(['Aisu oncall']);
    // the spanning event surfaces its end date so the agent sees it runs THROUGH Jul 19
    expect(out[0]).toMatchObject({ date: '2026-07-13', endDate: '2026-07-19' });
    // a single-day event omits endDate (no noise)
    expect(shapeEvents([EVENTS[0]])[0]).not.toHaveProperty('endDate');
  });
});

describe('shapeChores', () => {
  it('shapeChores returns due-only by default, all when asked', () => {
    expect(shapeChores(CHORES).map(c => c.title)).toEqual(['Trash']);
    expect(shapeChores(CHORES, true).map(c => c.title)).toEqual(['Trash', 'Dishes']);
  });
});
