import { describe, it, expect } from 'vitest';
import { parseICS, shiftIsoDate } from '../../server';

const ics = (body: string) => `BEGIN:VCALENDAR\n${body}\nEND:VCALENDAR`;

describe('shiftIsoDate', () => {
  it('shifts dates across month/year boundaries (UTC)', () => {
    expect(shiftIsoDate('2026-06-20', -1)).toBe('2026-06-19');
    expect(shiftIsoDate('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftIsoDate('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('parseICS — all-day exclusive DTEND → inclusive', () => {
  it('collapses a 1-day all-day event to a single day', () => {
    const [e] = parseICS(ics('BEGIN:VEVENT\nSUMMARY:Juneteenth\nDTSTART;VALUE=DATE:20260619\nDTEND;VALUE=DATE:20260620\nEND:VEVENT'));
    expect(e.start).toBe('2026-06-19');
    expect(e.end).toBe('2026-06-19'); // not 06-20
  });

  it('keeps a real multi-day all-day span correct (end exclusive → inclusive last day)', () => {
    const [e] = parseICS(ics('BEGIN:VEVENT\nSUMMARY:Spring Break\nDTSTART;VALUE=DATE:20260406\nDTEND;VALUE=DATE:20260411\nEND:VEVENT'));
    expect(e.start).toBe('2026-04-06');
    expect(e.end).toBe('2026-04-10'); // 5 days: 6,7,8,9,10
  });

  it('does NOT shift TIMED events (DTEND has a time)', () => {
    const [e] = parseICS(ics('BEGIN:VEVENT\nSUMMARY:Assembly\nDTSTART:20260619T090000\nDTEND:20260619T103000\nEND:VEVENT'));
    expect(e.start).toBe('2026-06-19T09:00:00');
    expect(e.end).toBe('2026-06-19T10:30:00');
  });

  // Regression: a UTC ('Z') timestamp must be interpreted as UTC, not as naive local — otherwise it
  // renders at the wrong time and (across the UTC day boundary) on the WRONG DAY. The parsed local
  // wall-clock string, read back as local, must equal the original UTC instant.
  it('interprets a UTC (Z) timed DTSTART as the correct absolute instant', () => {
    const [e] = parseICS(ics('BEGIN:VEVENT\nSUMMARY:Webinar\nDTSTART:20260617T010000Z\nDTEND:20260617T020000Z\nEND:VEVENT'));
    expect(new Date(e.start).getTime()).toBe(Date.UTC(2026, 5, 17, 1, 0, 0));
    expect(new Date(e.end).getTime()).toBe(Date.UTC(2026, 5, 17, 2, 0, 0));
  });

  it('leaves a naive (no-Z) timed DTSTART as local wall-clock, unchanged', () => {
    const [e] = parseICS(ics('BEGIN:VEVENT\nSUMMARY:Local\nDTSTART:20260617T090000\nEND:VEVENT'));
    expect(e.start).toBe('2026-06-17T09:00:00');
  });
});
