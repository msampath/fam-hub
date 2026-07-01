// Event merge/deduplication + recurring-series detection (pure).
import type { CalendarEvent } from '../types';

/** A detected run of the same event repeating across many days for one person. */
export interface RecurringGroup {
  groupId: string;       // stable key: `rec:<id>|<member>` or `heur:<title>|<member>`
  title: string;
  member: string;        // the family member whose calendar this clutters
  dayCount: number;      // distinct days the series spans (the "daily" signal)
  instanceCount: number; // number of event cards in the group (what gets deleted)
  eventIds: string[];
  startDate: string;
  endDate: string;
}

/**
 * Detect recurring daily events so they can be flagged and bulk-deleted.
 *
 * Google pulls events with singleEvents=true, which expands a recurring series into
 * one card per day. We group by Google's `recurringEventId` when present, and fall
 * back to a normalized-title heuristic ONLY for imported events sharing a `sourceId`
 * (a single schedule PDF/ICS import) — never for manual one-offs, whose identical
 * titles would otherwise collide into a bogus deletable series. Grouping is
 * per-member (an event tagged to several people forms one group each) so a warning
 * can read "on <person>'s calendar". A group is only returned when it spans at least
 * `minInstances` DISTINCT days — three same-day copies are not "daily".
 */
export function detectRecurringGroups(events: CalendarEvent[], minInstances = 3): RecurringGroup[] {
  const groups = new Map<string, { title: string; member: string; ids: Map<string, string> }>();

  for (const ev of events) {
    const date = (ev.start || '').split('T')[0];
    if (!date) continue;
    // Series identity: Google's real series id, else an IMPORTED same-title run scoped to the source
    // that created it. A manual one-off (no recurringEventId, no sourceId) is NEVER grouped — keying
    // on title alone collided unrelated events (e.g. three manual "Birthday Party" entries looked like
    // a deletable recurring series). The app has no manual-recurrence feature, so the only legitimate
    // non-Google series come from a single import (a schedule PDF/ICS), which shares a sourceId.
    let seriesKey: string;
    if (ev.recurringEventId) seriesKey = `rec:${ev.recurringEventId}`;
    else if (ev.sourceId) seriesKey = `heur:${(ev.title || '').trim().toLowerCase()}|${ev.sourceId}`;
    else continue;
    const members = ev.members && ev.members.length ? ev.members : ['Family'];

    for (const member of members) {
      const key = `${seriesKey}|${member}`;
      let g = groups.get(key);
      if (!g) {
        g = { title: ev.title || 'Untitled event', member, ids: new Map() };
        groups.set(key, g);
      }
      g.ids.set(ev.id, date); // Map<eventId, date> — distinct ids, dates counted below
    }
  }

  const result: RecurringGroup[] = [];
  for (const [groupId, g] of groups) {
    const distinctDates = new Set(g.ids.values());
    if (distinctDates.size < minInstances) continue;
    const sortedDates = Array.from(distinctDates).sort();
    result.push({
      groupId,
      title: g.title,
      member: g.member,
      dayCount: distinctDates.size,
      instanceCount: g.ids.size,
      eventIds: Array.from(g.ids.keys()),
      startDate: sortedDates[0],
      endDate: sortedDates[sortedDates.length - 1],
    });
  }

  // Collapse groups that point at the EXACT same cards (a shared event tagged to
  // several members) into one row listing all affected members — otherwise the UI
  // shows a duplicate row per member and "delete one" misleadingly wipes both.
  const bySig = new Map<string, { group: RecurringGroup; members: Set<string> }>();
  for (const g of result) {
    const sig = [...g.eventIds].sort().join('|');
    const entry = bySig.get(sig);
    if (entry) entry.members.add(g.member);
    else bySig.set(sig, { group: g, members: new Set([g.member]) });
  }
  const collapsed = Array.from(bySig.values()).map(({ group, members }) => ({
    ...group,
    member: Array.from(members).sort().join(' & '),
  }));

  // Most-cluttering series first.
  collapsed.sort((a, b) => b.dayCount - a.dayCount);
  return collapsed;
}

/**
 * Drop events whose id is in the hidden/blocklist set. Used at Google-pull time to
 * keep locally-deleted synced events from re-appearing. Filtering BEFORE the merge
 * (mergeDeduplicateEvents) is deliberate: the merge can promote a `gcal-` id to a
 * local id on a same-key collision, after which an id-based blocklist would never
 * match again — so we must remove hidden items while they still carry their gcal- id.
 */
export function filterHiddenEvents(events: CalendarEvent[], hiddenIds: Set<string> | string[]): CalendarEvent[] {
  const set = hiddenIds instanceof Set ? hiddenIds : new Set(hiddenIds);
  return events.filter(e => !set.has(e.id));
}

/**
 * Merge and deduplicate overlapping events across family feeds/calendars.
 * Match key = normalized title + start + end. On a match, combines member rosters,
 * promotes read-only Google events to editable local IDs, and concatenates distinct
 * descriptions/location/ageGroup without duplicating. Copies items before mutating
 * so React state objects are never touched directly.
 */
export function mergeDeduplicateEvents(items: CalendarEvent[]): CalendarEvent[] {
  const merged: CalendarEvent[] = [];
  const visitedKeys = new Map<string, CalendarEvent>();

  for (const item of items) {
    const normalizedTitle = (item.title || '').trim().toLowerCase();
    const st = item.start || '';
    const ed = item.end || st;
    // Include startTime so two same-title, same-day events at DIFFERENT times stay distinct.
    const key = `${normalizedTitle}|${st}|${ed}|${item.startTime || ''}`;

    if (visitedKeys.has(key)) {
      const existing = visitedKeys.get(key)!;

      const combinedMembers = Array.from(new Set([...(existing.members || []), ...(item.members || [])]));
      existing.members = combinedMembers.filter(Boolean);

      if (existing.id.startsWith('gcal-') && !item.id.startsWith('gcal-')) {
        existing.id = item.id;
        // The surviving record is now the LOCAL (manual) event — adopt its identity fields too, so it
        // isn't later re-grouped as a Google series (recurringEventId) or shielded from the gcal-
        // hidden-event blocklist (a stale gcal sourceId/recurringEventId would do both).
        existing.recurringEventId = item.recurringEventId;
        existing.sourceId = item.sourceId;
      }

      if (item.description && item.description !== existing.description) {
        if (!existing.description) {
          existing.description = item.description;
        } else if (!existing.description.toLowerCase().includes(item.description.toLowerCase().trim())) {
          existing.description = `${existing.description}\n\n${item.description}`;
        }
      }

      if (!existing.location && item.location) {
        existing.location = item.location;
      }

      if (!existing.ageGroup && item.ageGroup) {
        existing.ageGroup = item.ageGroup;
      }
    } else {
      const itemCopy = {
        ...item,
        members: [...(item.members || [])].filter(Boolean),
      };
      visitedKeys.set(key, itemCopy);
      merged.push(itemCopy);
    }
  }

  return merged;
}

// Apply a Google-Calendar PULL to the CURRENT events: drop only the old `gcal-<connId>-…` events for
// the calendars that were just pulled, keep everything else (manual/copilot events AND events added
// DURING the multi-second sync), then add the freshly-pulled events and dedup. Pure — so the sync
// handler can use it inside a functional `setEvents(prev => …)` and never clobber a concurrent add
// from a stale call-time snapshot.
export function applySyncedPull(
  prev: CalendarEvent[],
  pulledConnIds: string[],
  freshImported: CalendarEvent[],
): CalendarEvent[] {
  const kept = (Array.isArray(prev) ? prev : []).filter(
    e => !pulledConnIds.some(cid => e.id.startsWith(`gcal-${cid}-`)),
  );
  return mergeDeduplicateEvents([...kept, ...freshImported]);
}
