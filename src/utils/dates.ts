// Date / calendar-window helpers (pure, unit-tested).
import { MONTH_NAMES, CHORE_SLOTS } from '../constants';

export interface MonthInfo { name: string; index: number; year: number }

// Local 'YYYY-MM-DD' for a Date (avoids the UTC shift toISOString causes in negative TZs).
export function toLocalDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Format an 'HH:MM' (24h) time as a friendly 12h string, e.g. '14:30' -> '2:30 PM'.
// Returns '' for missing/invalid input (so callers can render unconditionally).
export function formatTime(hhmm: string | undefined | null): string {
  if (!hhmm) return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return '';
  let h = Number(m[1]);
  const min = m[2];
  if (h < 0 || h > 23 || Number(min) > 59) return '';
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

// Parse 'HH:MM' to minutes-since-midnight, or null if invalid.
export function parseHmToMinutes(hhmm: string | undefined | null): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// Build a rolling window of months starting at `start` (defaults to the current month),
// so the planner never goes stale on a hardcoded year.
export function buildMonthWindow(count = 4, start: Date = new Date()): MonthInfo[] {
  const startMonth = start.getMonth();
  const startYear = start.getFullYear();
  const months: MonthInfo[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(startYear, startMonth + i, 1);
    months.push({ name: `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`, index: d.getMonth(), year: d.getFullYear() });
  }
  return months;
}

// Window spanning `back` months before and `fwd` months after the current month (inclusive),
// so calendar navigation has a full year of headroom either side and never overflows the array.
// The current month sits at index `back` (use that as the default navigation step).
export function buildRollingWindow(back = 12, fwd = 12, start: Date = new Date()): MonthInfo[] {
  const begin = new Date(start.getFullYear(), start.getMonth() - back, 1);
  return buildMonthWindow(back + fwd + 1, begin);
}

// ISO start/end timestamps covering a month window — used for Google Calendar sync ranges.
export function monthWindowRange(months: { index: number; year: number }[]): { timeMin: string; timeMax: string } {
  const first = months[0];
  const last = months[months.length - 1];
  const lastDay = new Date(last.year, last.index + 1, 0).getDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    timeMin: `${first.year}-${pad(first.index + 1)}-01T00:00:00Z`,
    timeMax: `${last.year}-${pad(last.index + 1)}-${pad(lastDay)}T23:59:59Z`,
  };
}

// Parse a 'YYYY-MM-DD' string as a LOCAL date. `new Date(str)` parses as UTC midnight,
// which shifts the day backward in negative-offset timezones and breaks weekday/weekend
// detection — this avoids that.
export function parseLocalDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

// Advance a 'YYYY-MM-DD' string by one day using pure UTC arithmetic (no timezone drift).
export function addOneDayUTC(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().split('T')[0];
}

// Shift a 'YYYY-MM-DD' by n days (UTC; n may be negative). Used to convert a Google all-day
// end.date (which is EXCLUSIVE — the day after the last day) into an inclusive end date.
export function shiftDateStr(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + n));
  return shifted.toISOString().split('T')[0];
}

// Which slot the clock is currently in (used as the default chore filter).
export function getCurrentTimeOfDay(hour: number = new Date().getHours()): typeof CHORE_SLOTS[number] {
  if (hour >= 5 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 17) return 'Afternoon';
  return 'Evening';
}

export interface CalendarCell { dateStr: string; dayNum: number; isCurrentMonth: boolean }

/**
 * Generates the 42-cell (6-week) grid for a given month, with leading/trailing
 * days from the adjacent months. Week starts on Monday.
 */
export function generateCalendarCells(monthIndex: number, year: number): CalendarCell[] {
  const month = monthIndex;
  const firstDayInstance = new Date(year, month, 1);

  // Day of week index where Monday is 0, Sunday is 6
  const startDayOfWeek = firstDayInstance.getDay(); // Sun = 0, Mon = 1, ...
  const padCount = startDayOfWeek === 0 ? 6 : startDayOfWeek - 1;

  const totalDaysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: CalendarCell[] = [];

  // Prior month trailing days
  const prevMonthDaysTotal = new Date(year, month, 0).getDate();
  for (let i = padCount - 1; i >= 0; i--) {
    const prevDayNum = prevMonthDaysTotal - i;
    const prevMonthIdx = month === 0 ? 11 : month - 1;
    const prevYear = month === 0 ? year - 1 : year;
    const mStr = String(prevMonthIdx + 1).padStart(2, '0');
    const dStr = String(prevDayNum).padStart(2, '0');
    cells.push({ dateStr: `${prevYear}-${mStr}-${dStr}`, dayNum: prevDayNum, isCurrentMonth: false });
  }

  // Current month days
  const mStr = String(month + 1).padStart(2, '0');
  for (let d = 1; d <= totalDaysInMonth; d++) {
    const dStr = String(d).padStart(2, '0');
    cells.push({ dateStr: `${year}-${mStr}-${dStr}`, dayNum: d, isCurrentMonth: true });
  }

  // Post month leading days to fill the 42-cell grid (6 rows)
  const extraNeeded = 42 - cells.length;
  const nextMonthIdx = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;
  const nextMStr = String(nextMonthIdx + 1).padStart(2, '0');
  for (let nextD = 1; nextD <= extraNeeded; nextD++) {
    const dStr = String(nextD).padStart(2, '0');
    cells.push({ dateStr: `${nextYear}-${nextMStr}-${dStr}`, dayNum: nextD, isCurrentMonth: false });
  }

  return cells;
}
