// Weekly coordination metrics (pure, unit-tested). "Activity" = how booked the current
// week is, measured as the fraction of its days that have a real commitment (a BUSY event).
import type { CalendarEvent } from '../types';
import { eventsOnDate } from './reminders';
import { classifyEvent } from './availability';
import { toLocalDateStr } from './dates';

/** The 7 'YYYY-MM-DD' dates of the Monday-start week containing `ref`. */
export function currentWeekDates(ref: Date): string[] {
  const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const mondayOffset = (d.getDay() + 6) % 7; // 0=Mon … 6=Sun
  d.setDate(d.getDate() - mondayOffset);
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    out.push(toLocalDateStr(x));
  }
  return out;
}

export interface WeeklyActivity {
  daysCovered: number; // days in the week with ≥1 BUSY (commitment) event
  totalDays: number;   // 7
  pct: number;         // round(daysCovered / totalDays * 100)
  eventCount: number;  // DISTINCT events overlapping the week (all events, incl. holidays)
}

export function weeklyActivity(events: CalendarEvent[], weekDates: string[]): WeeklyActivity {
  const ids = new Set<string>();
  let daysCovered = 0;
  for (const d of weekDates) {
    const onDay = eventsOnDate(events, d);
    // Count a day as "booked" only if it has a real commitment — a holiday / time-off day
    // (Juneteenth, Father's Day, "no school") has nothing scheduled to DO and shouldn't inflate
    // the %. Reuses the copilot's OFF/BUSY classifier (honors the per-event freeBusy override).
    if (onDay.some(e => classifyEvent(e) === 'BUSY')) daysCovered++;
    for (const e of onDay) ids.add(e.id); // eventCount stays the raw distinct-event count
  }
  const totalDays = weekDates.length || 7;
  return { daysCovered, totalDays, pct: Math.round((daysCovered / totalDays) * 100), eventCount: ids.size };
}
