import { describe, it, expect } from 'vitest';
import { isHolidayOrAllDay, filterUnrequestedHolidayDeletes } from '../utils/holidayGuard';
import type { CalendarEvent } from '../types';

const ev = (id: string, title: string, start: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id, title, start, category: 'Other', members: ['Everyone'], ...extra } as CalendarEvent);

const EVENTS: CalendarEvent[] = [
  ev('h1', 'Independence Day', '2026-07-04', { category: 'Holiday' }), // all-day holiday
  ev('h2', 'No school', '2026-07-03'),                                 // all-day (no startTime)
  ev('t1', 'Zoo Day', '2026-07-04', { startTime: '10:00' }),           // a real timed event
];

// agent-path reader: an action is {tool, artifact:{title,start,id}}
const agentRead = (a: any) => ({ isDeleteEvent: a.tool === 'delete_event', ref: a.artifact || {} });
const del = (title: string, start?: string) => ({ tool: 'delete_event', artifact: { title, ...(start ? { start } : {}) } });

describe('isHolidayOrAllDay', () => {
  it('is true for an all-day event (no startTime) and for a Holiday category', () => {
    expect(isHolidayOrAllDay({ startTime: undefined, category: 'Other' })).toBe(true);
    expect(isHolidayOrAllDay({ startTime: '10:00', category: 'Holiday' })).toBe(true);
    expect(isHolidayOrAllDay({ startTime: '10:00', category: 'Other' })).toBe(false);
  });
});

describe('filterUnrequestedHolidayDeletes', () => {
  it('drops an unrequested delete of an all-day holiday', () => {
    const r = filterUnrequestedHolidayDeletes([del('Independence Day', '2026-07-04')], EVENTS, 'add these anyway', agentRead);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toEqual([{ title: 'Independence Day' }]);
  });

  it('drops an unrequested delete of an all-day (no startTime) marker', () => {
    const r = filterUnrequestedHolidayDeletes([del('No school')], EVENTS, 'add these', agentRead);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
  });

  it('KEEPS the delete when the user explicitly asked to remove it (names the event)', () => {
    const r = filterUnrequestedHolidayDeletes([del('Independence Day', '2026-07-04')], EVENTS, 'delete Independence Day', agentRead);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('KEEPS the delete when the verb pairs with a generic event word ("cancel that holiday")', () => {
    const r = filterUnrequestedHolidayDeletes([del('Independence Day', '2026-07-04')], EVENTS, 'cancel that holiday please', agentRead);
    expect(r.kept).toHaveLength(1);
  });

  it('still DROPS a holiday delete when a delete verb is only INCIDENTAL ("clear the driveway and add a picnic")', () => {
    // "clear" is a delete verb but refers to the driveway, not a calendar item — the guard must not
    // treat that as permission to remove the July-4 holiday.
    const r = filterUnrequestedHolidayDeletes([del('Independence Day', '2026-07-04')], EVENTS, 'clear the driveway and add a picnic', agentRead);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toEqual([{ title: 'Independence Day' }]);
  });

  it('KEEPS a delete of a real timed event', () => {
    const r = filterUnrequestedHolidayDeletes([del('Zoo Day', '2026-07-04')], EVENTS, 'add a picnic', agentRead);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });

  it('leaves non-delete actions untouched', () => {
    const create = { tool: 'create_event', artifact: { title: 'Picnic' } };
    const r = filterUnrequestedHolidayDeletes([create, del('Independence Day', '2026-07-04')], EVENTS, 'add these', agentRead);
    expect(r.kept).toEqual([create]);
  });

  it('works with the local-path action shape ({type, payload})', () => {
    const localRead = (a: any) => ({ isDeleteEvent: a.type === 'delete_event', ref: a.payload || {} });
    const local = { type: 'delete_event', payload: { title: 'Independence Day', start: '2026-07-04' } };
    const r = filterUnrequestedHolidayDeletes([local], EVENTS, 'add anyway', localRead);
    expect(r.kept).toHaveLength(0);
  });
});
