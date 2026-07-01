// Today/Tomorrow agenda derivation (pure, unit-tested).
import type { CalendarEvent, Chore } from '../types';
import { byStartTime } from './reminders';

export interface AgendaResult {
  todayEvents: CalendarEvent[];
  tomorrowEvents: CalendarEvent[];
  todayChores: Chore[]; // chores not yet fully done for today
}

// An event "falls on" a date if the date is within its [start, end] span (date-only).
function eventOnDate(evt: CalendarEvent, dateStr: string): boolean {
  if (!evt.start) return false;
  const start = evt.start.split('T')[0];
  const end = evt.end ? evt.end.split('T')[0] : start;
  return dateStr >= start && dateStr <= end;
}

/**
 * Build the at-a-glance agenda: today's & tomorrow's events plus today's still-pending
 * chores. Pure — caller passes the local 'YYYY-MM-DD' strings (no Date() in here, so it
 * is deterministic and unit-testable). A chore is pending when its completions so far
 * are below its per-day target.
 */
export function buildTodayTomorrowAgenda(
  events: CalendarEvent[],
  chores: Chore[],
  todayStr: string,
  tomorrowStr: string,
): AgendaResult {
  return {
    todayEvents: events.filter(e => eventOnDate(e, todayStr)).sort(byStartTime),
    tomorrowEvents: events.filter(e => eventOnDate(e, tomorrowStr)).sort(byStartTime),
    todayChores: chores.filter(c => (c.completedCount ?? 0) < (c.timesPerDay || 1)),
  };
}
