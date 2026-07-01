import { describe, it, expect } from 'vitest';
import { filterHiddenEvents, mergeDeduplicateEvents } from '../utils/events';
import type { CalendarEvent } from '../types';

const ev = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: 'Swim',
  start: '2026-06-15',
  end: '2026-06-15',
  category: 'Sports',
  members: ['Leo'],
  ...over,
});

describe('filterHiddenEvents', () => {
  it('removes events whose id is in the blocklist (array input)', () => {
    const events = [ev('gcal-cal1-a'), ev('gcal-cal1-b'), ev('usr-1')];
    const out = filterHiddenEvents(events, ['gcal-cal1-a']);
    expect(out.map(e => e.id)).toEqual(['gcal-cal1-b', 'usr-1']);
  });

  it('accepts a Set as the blocklist', () => {
    const events = [ev('gcal-cal1-a'), ev('gcal-cal1-b')];
    const out = filterHiddenEvents(events, new Set(['gcal-cal1-b']));
    expect(out.map(e => e.id)).toEqual(['gcal-cal1-a']);
  });

  it('an empty blocklist passes everything through', () => {
    const events = [ev('a'), ev('b')];
    expect(filterHiddenEvents(events, [])).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const events = [ev('gcal-x'), ev('y')];
    filterHiddenEvents(events, ['gcal-x']);
    expect(events).toHaveLength(2);
  });

  // The reason Hiding filters BEFORE the merge: the merge promotes a gcal- id to a local
  // id on a same-key collision, after which an id blocklist can never match it again.
  it('filtering before merge keeps a hidden event hidden; filtering after merge fails', () => {
    const hiddenId = 'gcal-cal1-a';
    // A local manual event with the SAME title+start+end as the hidden synced one.
    const local = ev('usr-1', { members: ['Mom'] });
    const importedHidden = ev(hiddenId, { members: ['Leo'] });

    // WRONG ORDER — merge first: the gcal id is promoted to the local id, so a post-merge
    // id filter can't catch it and the hidden event slips through.
    const mergedFirst = mergeDeduplicateEvents([importedHidden, local]);
    expect(mergedFirst).toHaveLength(1);
    expect(mergedFirst[0].id).toBe('usr-1'); // gcal- id was promoted away
    expect(filterHiddenEvents(mergedFirst, [hiddenId])).toHaveLength(1); // slipped through

    // RIGHT ORDER — filter the imported array first (as syncGoogleCalendars does), then merge.
    const existing = [local];
    const visibleImported = filterHiddenEvents([importedHidden], [hiddenId]);
    const committed = mergeDeduplicateEvents([...existing, ...visibleImported]);
    expect(committed.map(e => e.id)).toEqual(['usr-1']);
    expect(committed[0].members).toEqual(['Mom']); // the hidden Leo copy never merged in
  });
});

describe('import dedup / sourceId (why AI imports append-direct instead of merging)', () => {
  it('mergeDeduplicateEvents drops the incoming sourceId on a same-key collision', () => {
    // This is the latent bug the import-path fix avoids: if an imported event collides
    // with an existing one, the merge keeps the existing object and never copies the new
    // sourceId — so handleDeleteSource(sourceId) would later match nothing ("undo" fails).
    const existing = ev('usr-1'); // no sourceId
    const imported = ev('src-1-evt', { sourceId: 'src-1' });
    const merged = mergeDeduplicateEvents([existing, imported]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sourceId).toBeUndefined();
  });

  it('appending directly preserves sourceId so per-source undo works', () => {
    const existing = ev('usr-1');
    const imported = ev('src-1-evt', { sourceId: 'src-1' });
    // The fixed import path appends rather than merging.
    const committed = [imported, existing];
    expect(committed.find(e => e.sourceId === 'src-1')).toBeDefined();
    // handleDeleteSource('src-1') then removes exactly the imported event.
    const afterUndo = committed.filter(e => e.sourceId !== 'src-1');
    expect(afterUndo.map(e => e.id)).toEqual(['usr-1']);
  });
});

describe('mergeDeduplicateEvents promotes identity fields with the id', () => {
  it('a gcal event promoted to a local id adopts the local recurringEventId/sourceId, not stale gcal ones', () => {
    // gcal event FIRST (becomes the surviving `existing`), local manual event second.
    const synced = ev('gcal-cal1-a', { recurringEventId: 'rec-123', sourceId: 'gcal-cal1' });
    const local = ev('usr-1'); // manual: no recurringEventId/sourceId
    const merged = mergeDeduplicateEvents([synced, local]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('usr-1');                  // id promoted to the local event
    expect(merged[0].recurringEventId).toBeUndefined();  // stale gcal series id dropped with it
    expect(merged[0].sourceId).toBeUndefined();          // stale gcal sourceId dropped with it
  });
});

describe('mergeDeduplicateEvents keys on startTime', () => {
  it('keeps same-title same-day events at DIFFERENT times distinct', () => {
    const a = ev('gcal-1-a', { title: 'Practice', startTime: '09:00' });
    const b = ev('gcal-1-b', { title: 'Practice', startTime: '16:00' });
    expect(mergeDeduplicateEvents([a, b])).toHaveLength(2);
  });

  it('still merges identical timed events (e.g. a shared invite across feeds)', () => {
    const a = ev('gcal-1-a', { title: 'Practice', startTime: '16:00', members: ['Leo'] });
    const b = ev('gcal-2-b', { title: 'Practice', startTime: '16:00', members: ['Mom'] });
    const merged = mergeDeduplicateEvents([a, b]);
    expect(merged).toHaveLength(1);
    expect(merged[0].members?.sort()).toEqual(['Leo', 'Mom']);
  });
});
