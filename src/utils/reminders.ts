// Local reminder logic (pure). Two kinds: (1) a configurable DAILY digest summarizing
// today's events + still-due chores (covers all-day events), and (2) per-event "X min
// before" reminders for events that carry a startTime (see dueEventReminders).
import type { CalendarEvent, Chore } from '../types';
import { formatTime, parseHmToMinutes } from './dates';

/** Events whose [start, end] day-range covers `dateStr` (YYYY-MM-DD). */
export function eventsOnDate(events: CalendarEvent[], dateStr: string): CalendarEvent[] {
  return events.filter((e) => {
    const start = (e.start || '').slice(0, 10);
    if (!start) return false;
    const end = (e.end || e.start || '').slice(0, 10) || start;
    return start <= dateStr && dateStr <= end;
  });
}

/** Chores not yet fully completed for the day (completedCount < timesPerDay). */
export function dueChores(chores: Chore[]): Chore[] {
  return chores.filter((c) => (c.completedCount || 0) < (c.timesPerDay || 1));
}

/** Sort events for display: all-day first, then timed events ascending by start time. */
export function byStartTime(a: CalendarEvent, b: CalendarEvent): number {
  const ta = parseHmToMinutes(a.startTime);
  const tb = parseHmToMinutes(b.startTime);
  if (ta === null && tb === null) return 0;
  if (ta === null) return -1; // all-day first
  if (tb === null) return 1;
  return ta - tb;
}

export interface ReminderContent {
  title: string;
  body: string;
}

/**
 * Build the daily reminder notification (today's events + still-due chores), or null if
 * there is nothing to report. Body lists up to a few of each, then "…and N more".
 */
export function buildDailyReminder(
  events: CalendarEvent[],
  chores: Chore[],
  dateStr: string,
  maxLines = 5,
): ReminderContent | null {
  const evs = eventsOnDate(events, dateStr).slice().sort(byStartTime);
  const due = dueChores(chores);
  if (!evs.length && !due.length) return null;

  const summary: string[] = [];
  if (evs.length) summary.push(`${evs.length} event${evs.length > 1 ? 's' : ''}`);
  if (due.length) summary.push(`${due.length} chore${due.length > 1 ? 's' : ''} to do`);

  const lines: string[] = [];
  for (const e of evs) {
    if (lines.length >= maxLines) break;
    const t = formatTime(e.startTime);
    lines.push(`📅 ${t ? `${t} ` : ''}${e.title || 'Event'}`);
  }
  for (const c of due) {
    if (lines.length >= maxLines) break;
    lines.push(`✅ ${c.title}${c.assignedTo ? ` — ${c.assignedTo}` : ''}`);
  }
  const remaining = evs.length + due.length - lines.length;
  if (remaining > 0) lines.push(`…and ${remaining} more`);

  return { title: `Today: ${summary.join(' · ')}`, body: lines.join('\n') };
}

export interface DueEventReminder {
  id: string;    // fire-key: `${dateStr}|${event.id}` (used to fire once per event/day)
  title: string;
  body: string;
}

/**
 * Per-event "X minutes before" reminders. For each TIMED event starting today, returns a
 * reminder when now is within [start - lead, start + grace] and it hasn't fired yet.
 * The `graceMinutes` tail means an alert isn't silently lost when the tick lands just
 * after the start (e.g. the app opened late or a background tab's timer was throttled).
 * Events with no startTime (all-day) are covered by the daily digest, not here.
 */
export function dueEventReminders(
  events: CalendarEvent[],
  todayStr: string,
  now: Date,
  leadMinutes: number,
  fired: Set<string>,
  graceMinutes = 15,
): DueEventReminder[] {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const out: DueEventReminder[] = [];
  for (const e of events) {
    if ((e.start || '').slice(0, 10) !== todayStr) continue; // only the start day
    const evMin = parseHmToMinutes(e.startTime);
    if (evMin === null) continue; // all-day / invalid
    const key = `${todayStr}|${e.id}`;
    if (fired.has(key)) continue;
    if (nowMin >= evMin - leadMinutes && nowMin <= evMin + graceMinutes) {
      const mins = evMin - nowMin;
      const phrase = mins >= 1 ? `Starts in ${mins} min` : mins === 0 ? 'Starting now' : `Started ${-mins} min ago`;
      const who = e.members && e.members.length ? ` · ${e.members.join(', ')}` : '';
      out.push({ id: key, title: `${e.title || 'Event'} at ${formatTime(e.startTime)}`, body: `${phrase}${who}` });
    }
  }
  return out;
}

/**
 * Whether the daily reminder should fire now: current time is at/after the configured
 * time-of-day (minutes since midnight) AND it hasn't already fired today.
 */
export function shouldFireDailyReminder(
  now: Date,
  reminderMinutes: number,
  lastFiredDate: string | null,
  todayStr: string,
): boolean {
  if (lastFiredDate === todayStr) return false;
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  return nowMinutes >= reminderMinutes;
}
