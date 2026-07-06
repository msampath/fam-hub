// Calendar-extraction validator (Phase-3 weak-model tightening): only real ISO dates within ±1yr
// survive the parse endpoints — a weak model's "next Tuesday" / invented-year / impossible dates
// must be dropped BEFORE import, and a bad `end` costs the field, not the event.
import { describe, it, expect } from 'vitest';
import { validateExtractedEvents, EXTRACTION_WINDOW_DAYS } from '../utils/extractedEvents';

const TODAY = '2026-07-06';

describe('validateExtractedEvents', () => {
  it('passes well-formed events through (date-only and date-time starts)', () => {
    const out = validateExtractedEvents([
      { title: 'Soccer', start: '2026-07-12' },
      { title: 'Recital', start: '2026-08-01T18:30', end: '2026-08-01', location: 'School gym' },
    ], TODAY);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ title: 'Soccer', start: '2026-07-12' });
    expect(out[1]).toMatchObject({ end: '2026-08-01', location: 'School gym' });
  });

  it('drops non-ISO, impossible, and unparseable start dates', () => {
    const out = validateExtractedEvents([
      { title: 'Vague', start: 'next Tuesday' },
      { title: 'Impossible', start: '2026-02-31' },      // round-trip check kills fake calendar dates
      { title: 'BadTime', start: '2026-07-10T27:99' },
      { title: 'Missing' },
      { start: '2026-07-10' },                            // no title
    ], TODAY);
    expect(out).toHaveLength(0);
  });

  it(`drops events outside the ±${EXTRACTION_WINDOW_DAYS}-day window`, () => {
    const out = validateExtractedEvents([
      { title: 'WayFuture', start: '2028-01-01' },
      { title: 'AncientPast', start: '2024-01-01' },
      { title: 'NearPast OK', start: '2026-06-01' },      // recent past stays (end-of-school lists)
      { title: 'NextSpring OK', start: '2027-03-15' },
    ], TODAY);
    expect(out.map(e => e.title)).toEqual(['NearPast OK', 'NextSpring OK']);
  });

  it('strips a bad end (unparseable or before start) instead of dropping the event', () => {
    const out = validateExtractedEvents([
      { title: 'CampWeek', start: '2026-07-20', end: 'TBD' },
      { title: 'Backwards', start: '2026-07-20', end: '2026-07-01' },
    ], TODAY);
    expect(out).toHaveLength(2);
    expect(out[0]).not.toHaveProperty('end');
    expect(out[1]).not.toHaveProperty('end');
  });

  it('clamps runaway free-text fields (repetition-loop defense)', () => {
    const out = validateExtractedEvents([
      { title: 'T'.repeat(500), start: '2026-07-12', description: 'd'.repeat(5000), location: 'L'.repeat(999) },
    ], TODAY);
    expect((out[0].title as string).length).toBe(200);
    expect((out[0] as any).description.length).toBe(1000);
    expect((out[0] as any).location.length).toBe(200);
  });
});
