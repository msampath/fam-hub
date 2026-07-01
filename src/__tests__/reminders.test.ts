import { describe, it, expect } from 'vitest';
import { eventsOnDate, dueChores, buildDailyReminder, shouldFireDailyReminder, dueEventReminders } from '../utils/reminders';
import { formatTime, parseHmToMinutes, shiftDateStr } from '../utils/dates';
import type { CalendarEvent, Chore } from '../types';

const ev = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id, title: 'Soccer', start: '2026-06-16', end: '2026-06-16', category: 'Sports', ...over,
});
const chore = (id: string, over: Partial<Chore> = {}): Chore => ({
  id, title: 'Dishes', assignedTo: 'Leo', points: 10, completed: false,
  completedCount: 0, timesPerDay: 1, repeatType: 'daily', ...over,
});

describe('eventsOnDate', () => {
  it('includes a single-day event on its date and excludes other days', () => {
    const events = [ev('a', { start: '2026-06-16' }), ev('b', { start: '2026-06-17' })];
    expect(eventsOnDate(events, '2026-06-16').map(e => e.id)).toEqual(['a']);
  });

  it('includes a multi-day event whose range covers the date', () => {
    const events = [ev('a', { start: '2026-06-14', end: '2026-06-18' })];
    expect(eventsOnDate(events, '2026-06-16')).toHaveLength(1);
    expect(eventsOnDate(events, '2026-06-20')).toHaveLength(0);
  });

  it('slices ISO dateTime starts to the day', () => {
    const events = [ev('a', { start: '2026-06-16T09:30:00Z', end: '2026-06-16T10:30:00Z' })];
    expect(eventsOnDate(events, '2026-06-16')).toHaveLength(1);
  });

  it('ignores events with no start', () => {
    expect(eventsOnDate([ev('a', { start: '' })], '2026-06-16')).toHaveLength(0);
  });
});

describe('dueChores', () => {
  it('returns chores not yet fully completed for the day', () => {
    const chores = [
      chore('a', { completedCount: 0, timesPerDay: 1 }),
      chore('b', { completedCount: 1, timesPerDay: 2 }),
      chore('c', { completedCount: 2, timesPerDay: 2 }), // done
    ];
    expect(dueChores(chores).map(c => c.id)).toEqual(['a', 'b']);
  });
});

describe('buildDailyReminder', () => {
  it('returns null when there is nothing today', () => {
    expect(buildDailyReminder([], [], '2026-06-16')).toBeNull();
  });

  it('summarizes counts in the title and lists items in the body', () => {
    const events = [ev('a', { title: 'Swim' })];
    const chores = [chore('c', { title: 'Trash', assignedTo: 'Emma' })];
    const out = buildDailyReminder(events, chores, '2026-06-16')!;
    expect(out.title).toBe('Today: 1 event · 1 chore to do');
    expect(out.body).toContain('📅 Swim');
    expect(out.body).toContain('✅ Trash — Emma');
  });

  it('truncates the body and appends an "…and N more" line', () => {
    const events = Array.from({ length: 8 }, (_, i) => ev('e' + i, { title: 'Evt' + i, start: '2026-06-16' }));
    const out = buildDailyReminder(events, [], '2026-06-16', 5)!;
    expect(out.title).toBe('Today: 8 events');
    expect(out.body).toContain('…and 3 more');
  });

  it('counts only events/chores relevant to the date', () => {
    const events = [ev('a', { start: '2026-06-16' }), ev('b', { start: '2026-06-20' })];
    const out = buildDailyReminder(events, [], '2026-06-16')!;
    expect(out.title).toBe('Today: 1 event');
  });
});

describe('formatTime / parseHmToMinutes', () => {
  it('formats 24h to friendly 12h', () => {
    expect(formatTime('14:30')).toBe('2:30 PM');
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('09:00')).toBe('9:00 AM');
  });
  it('returns empty string for missing/invalid', () => {
    expect(formatTime(undefined)).toBe('');
    expect(formatTime('4pm')).toBe('');
    expect(formatTime('25:00')).toBe('');
  });
  it('parses HH:MM to minutes, null on invalid', () => {
    expect(parseHmToMinutes('00:00')).toBe(0);
    expect(parseHmToMinutes('16:00')).toBe(960);
    expect(parseHmToMinutes('bad')).toBeNull();
    expect(parseHmToMinutes('24:00')).toBeNull();
  });
});

describe('shiftDateStr (Google exclusive-end → inclusive)', () => {
  it('subtracts a day (exclusive all-day end → last actual day)', () => {
    expect(shiftDateStr('2026-06-26', -1)).toBe('2026-06-25'); // "last day of school"
    expect(shiftDateStr('2026-07-05', -1)).toBe('2026-07-04');
  });
  it('handles month and year boundaries', () => {
    expect(shiftDateStr('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDateStr('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateStr('2026-03-01', -1)).toBe('2026-02-28'); // 2026 not a leap year
  });
  it('can add days too', () => {
    expect(shiftDateStr('2026-06-30', 1)).toBe('2026-07-01');
  });
});

describe('buildDailyReminder shows event times', () => {
  it('prefixes timed events with their time in the body', () => {
    const events = [ev('a', { title: 'Swim', startTime: '16:00' })];
    const out = buildDailyReminder(events, [], '2026-06-16')!;
    expect(out.body).toContain('📅 4:00 PM Swim');
  });

  it('orders the body: all-day first, then timed events ascending', () => {
    const events = [
      ev('a', { title: 'Evening', startTime: '18:00' }),
      ev('b', { title: 'AllDay', startTime: undefined }),
      ev('c', { title: 'Morning', startTime: '09:00' }),
    ];
    const out = buildDailyReminder(events, [], '2026-06-16')!;
    const lines = out.body.split('\n');
    expect(lines[0]).toContain('AllDay');
    expect(lines[1]).toContain('Morning');
    expect(lines[2]).toContain('Evening');
  });
});

describe('dueEventReminders', () => {
  const at = (h: number, m: number) => new Date(2026, 5, 16, h, m);
  const timed = ev('e1', { title: 'Soccer', startTime: '16:00', members: ['Leo'] });

  it('fires within the lead window before a timed event, once', () => {
    const due = dueEventReminders([timed], '2026-06-16', at(15, 40), 30, new Set()); // 20 min before
    expect(due).toHaveLength(1);
    expect(due[0].title).toBe('Soccer at 4:00 PM');
    expect(due[0].body).toBe('Starts in 20 min · Leo');
    expect(due[0].id).toBe('2026-06-16|e1');
  });

  it('does not fire before the lead window or beyond the grace tail', () => {
    expect(dueEventReminders([timed], '2026-06-16', at(15, 10), 30, new Set())).toHaveLength(0); // 50 min before
    expect(dueEventReminders([timed], '2026-06-16', at(16, 20), 30, new Set())).toHaveLength(0); // 20 min after (>15 grace)
  });

  it('still fires shortly after start (within the grace tail) so a late tick is not lost', () => {
    const due = dueEventReminders([timed], '2026-06-16', at(16, 5), 30, new Set()); // 5 min after start
    expect(due).toHaveLength(1);
    expect(due[0].body).toBe('Started 5 min ago · Leo');
  });

  it('does not fire if already in the fired set', () => {
    expect(dueEventReminders([timed], '2026-06-16', at(15, 40), 30, new Set(['2026-06-16|e1']))).toHaveLength(0);
  });

  it('skips all-day events and other days', () => {
    const allDay = ev('e2', { title: 'Trip', startTime: undefined });
    const otherDay = ev('e3', { title: 'Later', start: '2026-06-17', startTime: '16:00' });
    expect(dueEventReminders([allDay, otherDay], '2026-06-16', at(15, 40), 30, new Set())).toHaveLength(0);
  });

  it('lead 0 fires at the start ("Starting now")', () => {
    const due = dueEventReminders([timed], '2026-06-16', at(16, 0), 0, new Set());
    expect(due).toHaveLength(1);
    expect(due[0].body).toBe('Starting now · Leo');
  });
});

describe('shouldFireDailyReminder', () => {
  const at = (h: number, m: number) => { const d = new Date(2026, 5, 16, h, m); return d; };

  it('does not fire if it already fired today', () => {
    expect(shouldFireDailyReminder(at(9, 0), 8 * 60, '2026-06-16', '2026-06-16')).toBe(false);
  });

  it('does not fire before the configured time', () => {
    expect(shouldFireDailyReminder(at(7, 30), 8 * 60, null, '2026-06-16')).toBe(false);
  });

  it('fires at or after the configured time when not yet fired today', () => {
    expect(shouldFireDailyReminder(at(8, 0), 8 * 60, null, '2026-06-16')).toBe(true);
    expect(shouldFireDailyReminder(at(10, 0), 8 * 60, '2026-06-15', '2026-06-16')).toBe(true);
  });
});
