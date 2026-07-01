import { describe, it, expect } from 'vitest';
import { parseTicketmasterEvents, buildEventsFacts, indexedEvents } from '../utils/eventsFacts';

const TODAY = '2026-06-17';
const END = '2026-06-29'; // exclusive window end

describe('parseTicketmasterEvents', () => {
  it('keeps in-window events, dedupes name+date, floats family/children first, parses venue+segment', () => {
    const json = {
      _embedded: {
        events: [
          { name: 'Seattle Symphony', dates: { start: { localDate: '2026-06-20' } }, _embedded: { venues: [{ name: 'Benaroya Hall' }] }, classifications: [{ segment: { name: 'Music' } }] },
          { name: 'Family Fun Day', dates: { start: { localDate: '2026-06-21' } }, _embedded: { venues: [{ name: 'Seattle Center' }] }, classifications: [{ segment: { name: 'Family' } }] },
          { name: 'Too Late', dates: { start: { localDate: '2026-07-15' } } },                  // outside window → drop
          { name: 'Seattle Symphony', dates: { start: { localDate: '2026-06-20' } } },          // dup name+date → drop
          { name: 'No date' },                                                                   // no date → drop
        ],
      },
    };
    const evs = parseTicketmasterEvents(json, TODAY, END);
    expect(evs.map(e => e.name)).toEqual(['Family Fun Day', 'Seattle Symphony']); // family first
    expect(evs[0]).toMatchObject({ date: '2026-06-21', venue: 'Seattle Center', category: 'Family' });
  });
  it('is null-safe', () => {
    expect(parseTicketmasterEvents(null, TODAY, END)).toEqual([]);
    expect(parseTicketmasterEvents({}, TODAY, END)).toEqual([]);
  });
});

describe('buildEventsFacts', () => {
  it('formats dated events with weekday/venue/category and an authoritative header', () => {
    const block = buildEventsFacts('Seattle', [
      { name: 'Family Fun Day', date: '2026-06-21', venue: 'Seattle Center', category: 'Family' },
    ]);
    expect(block).toMatch(/^EVENTS FACTS/);
    expect(block).toContain('- [E1] Sunday 2026-06-21: Family Fun Day at Seattle Center [Family]');
    expect(block).toContain('do NOT invent events');
  });
  it('returns "" when there are no events', () => {
    expect(buildEventsFacts('x', [])).toBe('');
  });
});

describe('event URLs + ids', () => {
  it('parseTicketmasterEvents captures the event url when valid', () => {
    const json = { _embedded: { events: [
      { name: 'Concert', dates: { start: { localDate: '2026-06-20' } }, url: 'https://ticketmaster.com/e/1' },
      { name: 'No URL', dates: { start: { localDate: '2026-06-21' } } },
    ] } };
    const evs = parseTicketmasterEvents(json, TODAY, END);
    const byName = Object.fromEntries(evs.map(e => [e.name, e.url]));
    expect(byName['Concert']).toBe('https://ticketmaster.com/e/1');
    expect(byName['No URL']).toBeUndefined();
  });
  it('indexedEvents tags E1..En in order, filtering nameless entries', () => {
    const idx = indexedEvents([
      { name: 'A', date: '2026-06-20' },
      { name: '', date: '2026-06-21' },        // no name → skip
      { name: 'B', date: '2026-06-22' },
    ]);
    expect(idx.map(x => [x.id, x.event.name])).toEqual([['E1', 'A'], ['E2', 'B']]);
  });
});
