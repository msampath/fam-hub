import { describe, it, expect } from 'vitest';
import { applySyncedPull } from '../utils/events';
import type { CalendarEvent } from '../types';

const ev = (id: string, title = 'x', start = '2026-06-20'): CalendarEvent => ({ id, title, start, category: 'Other' });

// Regression: a Google-Calendar sync must merge its pull into the CURRENT events, never overwrite
// from a stale call-time snapshot — otherwise an event added DURING the multi-second sync is lost.
describe('applySyncedPull (sync must not clobber concurrent edits)', () => {
  it('preserves a manual event added during the sync (and replaces only the pulled calendar)', () => {
    const prev = [ev('cop-added-midsync', 'Dentist'), ev('gcal-cal1-old', 'Old GCal')];
    const fresh = [ev('gcal-cal1-new', 'New GCal')];
    const ids = applySyncedPull(prev, ['cal1'], fresh).map(e => e.id);
    expect(ids).toContain('cop-added-midsync'); // the concurrent add survives
    expect(ids).toContain('gcal-cal1-new');     // fresh pull added
    expect(ids).not.toContain('gcal-cal1-old'); // old gcal for the pulled calendar replaced
  });

  it('keeps gcal events from calendars that were NOT pulled this run', () => {
    const ids = applySyncedPull([ev('gcal-cal2-keep', 'Other cal')], ['cal1'], []).map(e => e.id);
    expect(ids).toContain('gcal-cal2-keep');
  });

  it('is null-safe on prev', () => {
    expect(applySyncedPull(undefined as any, ['cal1'], [ev('gcal-cal1-a')]).map(e => e.id)).toEqual(['gcal-cal1-a']);
  });
});
