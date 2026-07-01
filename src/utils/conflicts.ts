// Club per-day scheduling conflicts into groups (pure, unit-tested). A recurring overlap
// (e.g. a daily series clashing with another event) surfaces as one conflict PER DAY; this
// collapses those into a single group so the Copilot can offer one resolution instead of a
// dozen near-identical rows.
import type { CalendarEvent } from '../types';
import { parseHmToMinutes, addOneDayUTC } from './dates';

export interface ConflictLike {
  date: string;
  member: string;
  overlappingEvents: CalendarEvent[];
}

// A timed event with no end is assumed to last this long (so two events starting at the
// same time still register as a clash).
const DEFAULT_EVENT_MINUTES = 60;

/** Do two TIMED events' clock intervals overlap? Missing end ⇒ start + DEFAULT_EVENT_MINUTES. */
export function timedOverlap(
  aStart: string, aEnd: string | undefined,
  bStart: string, bEnd: string | undefined,
): boolean {
  const as = parseHmToMinutes(aStart);
  const bs = parseHmToMinutes(bStart);
  if (as === null || bs === null) return false;
  let ae = parseHmToMinutes(aEnd || '') ?? as + DEFAULT_EVENT_MINUTES;
  let be = parseHmToMinutes(bEnd || '') ?? bs + DEFAULT_EVENT_MINUTES;
  // An end strictly BEFORE its start crosses midnight (e.g. 22:00–01:00) → unwrap to the next day so
  // the interval isn't treated as empty, which silently missed overnight double-bookings.
  if (ae < as) ae += 1440;
  if (be < bs) be += 1440;
  return as < be && bs < ae; // strict — touching boundaries (10:00 end vs 10:00 start) don't clash
}

/**
 * Detect real scheduling conflicts: per member, per day, TIMED events whose clock times
 * overlap. ALL-DAY events (no startTime — holidays, "no school", all-day camp) are treated
 * as informational and never generate a conflict; this removes the false positives that a
 * day-level check produced (e.g. a holiday "clashing" with everything else that day).
 */
export function detectConflicts(events: CalendarEvent[]): ConflictLike[] {
  const byDayMember: Record<string, Record<string, CalendarEvent[]>> = {};
  for (const ev of events) {
    if (!ev.startTime) continue; // only timed events can clock-clash
    const start = (ev.start || '').split('T')[0];
    if (!start) continue;
    const end = (ev.end ? ev.end.split('T')[0] : start) || start;
    let day = start;
    let guard = 0;
    while (day <= end && guard++ < 400) {
      const members = ev.members && ev.members.length ? ev.members : ['Family'];
      for (const m of members) {
        const dayMap = byDayMember[day] || (byDayMember[day] = {});
        (dayMap[m] || (dayMap[m] = [])).push(ev);
      }
      day = addOneDayUTC(day);
    }
  }

  const out: ConflictLike[] = [];
  for (const date of Object.keys(byDayMember)) {
    for (const member of Object.keys(byDayMember[date])) {
      const list = byDayMember[date][member];
      if (list.length < 2) continue;
      const overlapping = new Set<CalendarEvent>();
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (timedOverlap(list[i].startTime!, list[i].endTime, list[j].startTime!, list[j].endTime)) {
            overlapping.add(list[i]);
            overlapping.add(list[j]);
          }
        }
      }
      if (overlapping.size >= 2) out.push({ date, member, overlappingEvents: [...overlapping] });
    }
  }
  return out;
}

export interface ConflictGroup {
  key: string;       // member + clashing-title signature
  member: string;
  titles: string[];  // the distinct clashing event titles (sorted)
  dates: string[];   // sorted dates this clash occurs on
  count: number;     // dates.length (1 = one-off; >1 = recurring)
}

/**
 * Group conflicts by member + the set of clashing event titles. The same pair of events
 * clashing for one person across many days becomes ONE group spanning those dates; genuinely
 * different clashes stay separate. Sorted most-recurring first, then by earliest date.
 */
export function groupConflicts(conflicts: ConflictLike[]): ConflictGroup[] {
  const map = new Map<string, ConflictGroup>();
  for (const c of conflicts) {
    const titles = Array.from(new Set(c.overlappingEvents.map(e => (e.title || 'Untitled').trim()))).sort();
    const sig = `${c.member}|${titles.map(t => t.toLowerCase()).join('|')}`;
    let g = map.get(sig);
    if (!g) {
      g = { key: sig, member: c.member, titles, dates: [], count: 0 };
      map.set(sig, g);
    }
    if (!g.dates.includes(c.date)) g.dates.push(c.date);
  }
  const groups = Array.from(map.values()).map(g => {
    g.dates.sort();
    g.count = g.dates.length;
    return g;
  });
  groups.sort((a, b) => b.count - a.count || a.dates[0].localeCompare(b.dates[0]));
  return groups;
}

/**
 * Keep only conflicts within [todayStr, horizonStr] (inclusive). Drops past conflicts and
 * anything beyond the near-term horizon so the user isn't shown stale or far-future noise.
 * Dates are 'YYYY-MM-DD', which compare correctly lexicographically.
 */
export function filterConflictWindow<T extends { date: string }>(conflicts: T[], todayStr: string, horizonStr: string): T[] {
  return conflicts.filter(c => c.date >= todayStr && c.date <= horizonStr);
}

/** A helpful Copilot prompt for resolving a conflict group (recurring-aware). */
export function conflictResolutionPrompt(g: ConflictGroup): string {
  const titles = g.titles.join(' and ');
  if (g.count <= 1) {
    return `How should I resolve the conflict on ${g.dates[0]} where ${g.member} is registered for both ${titles}?`;
  }
  return `${g.member} is double-booked with ${titles} on ${g.count} days (${g.dates[0]} to ${g.dates[g.count - 1]}) — it looks like a recurring overlap. Suggest one plan to resolve it across all those dates.`;
}
