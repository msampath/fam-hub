import { describe, it, expect } from 'vitest';
import { filterUpcomingEvents, dedupeActions, sanitizeCopilotActions, sanitizeSuggestions } from '../../server';

// Guards Bug 9: the copilot must never be handed past events (a weak fallback model would
// otherwise list them as "upcoming" — e.g. proposing June 9 when today is June 17).
describe('filterUpcomingEvents', () => {
  const today = '2026-06-17';

  it('drops fully-past events and keeps today + future', () => {
    const events = [
      { title: 'derm follow-up', start: '2026-06-09' },   // past → drop
      { title: 'DL renewal', start: '2026-06-12' },        // past → drop
      { title: 'half day', start: '2026-06-17' },          // today → keep
      { title: 'Juneteenth', start: '2026-06-19' },        // future → keep
    ];
    expect(filterUpcomingEvents(events, today).map(e => e.title)).toEqual(['half day', 'Juneteenth']);
  });

  it('keeps a multi-day event that started in the past but ends today-or-later', () => {
    const events = [{ title: 'summer camp', start: '2026-06-10', end: '2026-06-20' }];
    expect(filterUpcomingEvents(events, today)).toHaveLength(1);
  });

  it('uses date-only comparison for datetime starts', () => {
    expect(filterUpcomingEvents([{ start: '2026-06-17T09:00:00' }], today)).toHaveLength(1); // today
    expect(filterUpcomingEvents([{ start: '2026-06-16T23:00:00' }], today)).toHaveLength(0); // yesterday
  });

  it('is null-safe and drops undated entries', () => {
    expect(filterUpcomingEvents(null as any, today)).toEqual([]);
    expect(filterUpcomingEvents(undefined as any, today)).toEqual([]);
    expect(filterUpcomingEvents([{ title: 'no date' }], today)).toEqual([]);
  });
});

// Guards the "multiple entries all for June 17" report: a model that emits the same create_event
// several times must not spray duplicates onto the calendar.
describe('dedupeActions', () => {
  it('collapses identical create_event actions (case/space-insensitive)', () => {
    const actions = [
      { type: 'create_event', payload: { title: 'Zoo day', start: '2026-06-17' } },
      { type: 'create_event', payload: { title: 'zoo day ', start: '2026-06-17' } }, // dup
      { type: 'create_event', payload: { title: 'Zoo day', start: '2026-06-19' } },   // diff date → keep
    ];
    expect(dedupeActions(actions)).toHaveLength(2);
  });

  it('keeps distinct action types and is order-preserving + null-safe', () => {
    const actions = [
      { type: 'add_shopping_item', payload: { text: 'milk' } },
      { type: 'add_shopping_item', payload: { text: 'milk' } }, // dup
      { type: 'add_chore', payload: { title: 'dishes', assignedTo: 'Aisu' } },
    ];
    const out = dedupeActions(actions);
    expect(out.map(a => a.type)).toEqual(['add_shopping_item', 'add_chore']);
    expect(dedupeActions(null as any)).toEqual([]);
  });
});

// Server-side allowlist + shape check: off-contract or unsafe actions never reach the client.
describe('sanitizeCopilotActions', () => {
  it('keeps allowed action types and drops unknown/destructive ones', () => {
    const actions = [
      { type: 'create_event', payload: { title: 'Zoo', start: '2026-06-20' } },
      { type: 'add_chore', payload: { title: 'dishes' } },
      { type: 'add_shopping_item', payload: { text: 'milk' } },
      { type: 'purge_all_events', payload: {} },          // not allowed → drop
      { type: 'drop_database', payload: {} },             // not allowed → drop
    ];
    expect(sanitizeCopilotActions(actions).map(a => a.type)).toEqual([
      'create_event', 'add_chore', 'add_shopping_item',
    ]);
  });

  it('requires a target selector for delete_event (id or title) — a target-less destructive delete is dropped', () => {
    const actions = [
      { type: 'delete_event', payload: { title: 'Zoo Day' } },          // ok (allowed + has selector)
      { type: 'delete_event', payload: { id: 'e1' } },                  // ok
      { type: 'delete_event', payload: {} },                            // no selector → drop
    ];
    expect(sanitizeCopilotActions(actions).map(a => a.payload)).toEqual([{ title: 'Zoo Day' }, { id: 'e1' }]);
  });

  it('requires a target selector for update_event (id or matchTitle)', () => {
    const actions = [
      { type: 'update_event', payload: { matchTitle: 'Soccer', start: '2026-06-21' } }, // ok
      { type: 'update_event', payload: { id: 'e2', start: '2026-06-21' } },              // ok
      { type: 'update_event', payload: { start: '2026-06-21' } },                        // no selector → drop
      { type: 'update_event', payload: { matchTitle: '   ' } },                          // blank → drop
    ];
    const out = sanitizeCopilotActions(actions);
    expect(out).toHaveLength(2);
    expect(out.every(a => a.type === 'update_event')).toBe(true);
  });

  it('is null-safe', () => {
    expect(sanitizeCopilotActions(null as any)).toEqual([]);
  });

  it('drops a create_event that collides (date + normalized title) with an existing event', () => {
    const existing = [{ title: 'Woodland Park Zoo', start: '2026-06-20' }];
    const actions = [
      { type: 'create_event', payload: { title: 'woodland park zoo!', start: '2026-06-20' } }, // paraphrase → drop
      { type: 'create_event', payload: { title: 'Aquarium', start: '2026-06-20' } },            // new → keep
      { type: 'create_event', payload: { title: 'Woodland Park Zoo', start: '2026-06-27' } },    // diff date → keep
    ];
    expect(sanitizeCopilotActions(actions, existing).map(a => a.payload.title))
      .toEqual(['Aquarium', 'Woodland Park Zoo']);
  });
});

describe('sanitizeSuggestions (tap-to-add chips)', () => {
  it('keeps only well-formed dated suggestions and clamps fields', () => {
    const out = sanitizeSuggestions([
      { start: '2026-06-20', title: 'Zoo', category: 'Other', members: ['Leo'], note: 'sunscreen' },
      { start: '2026-06-21T09:00', title: 'Aquarium' },     // datetime start ok → sliced to date
      { title: 'No date' },                                  // missing start → drop
      { start: '2026-06-22' },                               // missing title → drop
      { start: 'soon', title: 'Bad date' },                  // non-ISO start → drop
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: '2026-06-20', title: 'Zoo', category: 'Other', members: ['Leo'], note: 'sunscreen' });
    expect(out[1]).toMatchObject({ start: '2026-06-21', title: 'Aquarium' });
  });

  it('caps to 14 and clamps long fields; null-safe', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ start: '2026-06-20', title: `T${i}`, note: 'z'.repeat(500) }));
    const out = sanitizeSuggestions(many);
    expect(out).toHaveLength(14);
    expect(out[0].note!.length).toBe(300);
    expect(sanitizeSuggestions(null as any)).toEqual([]);
  });

  // Bug 3: a suggestion that just echoes an event already on the calendar (same date + title) is a
  // holiday/event resurfaced from DATE FACTS, not a new idea — tapping ＋Create would duplicate it.
  it('drops a suggestion that matches an existing event by date + title (case/space-insensitive)', () => {
    const existing = [
      { title: 'Juneteenth', start: '2026-06-19' },
      { title: 'Soccer', start: '2026-06-20' },
    ];
    const out = sanitizeSuggestions([
      { start: '2026-06-19', title: ' juneteenth ' }, // echoes existing holiday → drop
      { start: '2026-06-20', title: 'Woodland Park Zoo' }, // genuinely new → keep
      { start: '2026-06-21', title: 'Soccer' },        // same title, different date → keep
    ], existing);
    expect(out.map(s => s.title)).toEqual(['Woodland Park Zoo', 'Soccer']);
  });

  it('dedupes near-duplicate paraphrases WITHIN one batch', () => {
    const out = sanitizeSuggestions([
      { start: '2026-06-20', title: 'Woodland Park Zoo' },
      { start: '2026-06-20', title: 'woodland park zoo!' }, // same date + normalized title → drop
      { start: '2026-06-20', title: 'Pacific Science Center' },
    ]);
    expect(out.map(s => s.title)).toEqual(['Woodland Park Zoo', 'Pacific Science Center']);
  });
});

// The anti-hallucination core: a "place" suggestion must resolve to a server-provided fact (the
// id-tagged PLACES/EVENTS FACTS the model saw) — by id, else exact name. It then takes the REAL name +
// link from the fact; an unresolvable "place" (a fabricated venue) is dropped. "idea" suggestions are
// generic and pass through. (The reported "Sammamish Community Center Kids' Workshop" bug = a place
// that resolves to nothing → now dropped.)
describe('sanitizeSuggestions — grounded place resolution', () => {
  const facts = [
    { id: 'P1', name: 'Woodland Park Zoo', url: 'https://zoo.example', kind: 'place' as const },
    { id: 'E1', name: 'Family Fun Day', url: 'https://tm.example/e1', kind: 'event' as const, date: '2026-06-21' },
  ];

  it('resolves a place by ref to the real name + url (model title is discarded)', () => {
    const out = sanitizeSuggestions(
      [{ type: 'place', ref: '[P1]', start: '2026-06-20', title: 'whatever the model typed', note: 'sunny' }],
      [], facts,
    );
    expect(out).toEqual([{ start: '2026-06-20', title: 'Woodland Park Zoo', url: 'https://zoo.example', note: 'sunny' }]);
  });

  it('DROPS a place whose ref/name resolves to nothing (a fabricated venue)', () => {
    const out = sanitizeSuggestions(
      [
        { type: 'place', ref: 'P9', start: '2026-06-20', title: 'Sammamish Community Center Kids Workshop' }, // bad id → drop
        { type: 'place', start: '2026-06-20', title: 'Totally Made Up Place' },                               // no ref + no name match → drop
      ],
      [], facts,
    );
    expect(out).toEqual([]);
  });

  it('falls back to an exact (case-insensitive) name match when the ref is absent', () => {
    const out = sanitizeSuggestions(
      [{ type: 'place', start: '2026-06-20', title: 'woodland park zoo' }],
      [], facts,
    );
    expect(out).toEqual([{ start: '2026-06-20', title: 'Woodland Park Zoo', url: 'https://zoo.example' }]);
  });

  it('overrides the start with the fact date for an event ref', () => {
    const out = sanitizeSuggestions([{ type: 'place', ref: 'E1', start: '2026-06-25' }], [], facts);
    expect(out).toEqual([{ start: '2026-06-21', title: 'Family Fun Day', url: 'https://tm.example/e1' }]);
  });

  it('keeps a generic idea (no business name, no url)', () => {
    const out = sanitizeSuggestions([{ type: 'idea', start: '2026-06-20', title: 'visit a nearby park' }], [], facts);
    expect(out).toEqual([{ start: '2026-06-20', title: 'visit a nearby park' }]);
  });

  it('keeps a type:"idea" even if it carries a stray (non-resolving) ref — not treated as a place', () => {
    const out = sanitizeSuggestions([{ type: 'idea', ref: 'P9', start: '2026-06-20', title: 'a backyard picnic' }], [], facts);
    expect(out).toEqual([{ start: '2026-06-20', title: 'a backyard picnic' }]);
  });

  it('DROPS a place with a WRONG ref even if its title matches another fact (no silent rebind)', () => {
    // ref P9 doesn't exist; title happens to match P1 — must drop, NOT rebind to Woodland Park Zoo.
    const out = sanitizeSuggestions([{ type: 'place', ref: 'P9', start: '2026-06-20', title: 'Woodland Park Zoo' }], [], facts);
    expect(out).toEqual([]);
  });

  it('with no facts (ungrounded), every "place" suggestion is dropped — only ideas survive', () => {
    const out = sanitizeSuggestions(
      [
        { type: 'place', ref: 'P1', start: '2026-06-20', title: 'Some Specific Venue' }, // no facts → drop
        { type: 'idea', start: '2026-06-20', title: 'a backyard picnic' },
      ],
      [], [],
    );
    expect(out).toEqual([{ start: '2026-06-20', title: 'a backyard picnic' }]);
  });
});
