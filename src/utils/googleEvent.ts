import { addOneDayUTC, parseHmToMinutes } from './dates';
import { APP_NAME } from '../constants';
import type { CalendarEvent } from '../types';

// Dedupe marker embedded in a pushed event's description so a re-push UPDATES the same Google
// event instead of inserting a duplicate. Keyed by the app event id, and kept identical between
// the bulk "Sync Now" push and the manual per-event push so both find each other's events.
export const googleEventMarker = (ev: Pick<CalendarEvent, 'id'>): string => `[FamilyHub-id:${ev.id}]`;

// Build the Google Calendar event resource body for one app event. PURE (no network) so it can be
// unit-tested and shared by both push paths. Timed events push a real dateTime in the device tz;
// all-day events push a date. Guards a zero-/negative-duration timed event by defaulting to
// start + 1h, rolling the end DATE forward a day if that crosses midnight (rather than clamping to
// end == start, which Google rejects).
export function buildGoogleEventBody(ev: CalendarEvent) {
  const marker = googleEventMarker(ev);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let timing: Record<string, unknown>;
  if (ev.startTime) {
    const startMin = parseHmToMinutes(ev.startTime) ?? 0;
    let endMin = ev.endTime ? (parseHmToMinutes(ev.endTime) ?? startMin + 60) : startMin + 60;
    let endDate = ev.end || ev.start;
    // Zero-/negative-duration guard applies only when end is the SAME day — a multi-day timed
    // event legitimately has an earlier end time-of-day.
    if (endDate === ev.start && endMin <= startMin) endMin = startMin + 60;
    if (endMin > 23 * 60 + 59) { endDate = addOneDayUTC(endDate); endMin -= 24 * 60; }
    const endHm = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
    timing = {
      start: { dateTime: `${ev.start}T${ev.startTime}:00`, timeZone: tz },
      end: { dateTime: `${endDate}T${endHm}:00`, timeZone: tz },
    };
  } else {
    timing = { start: { date: ev.start }, end: { date: ev.end || ev.start } };
  }
  return {
    summary: ev.title,
    description: `${ev.description || ''}\n\nSynced via ${APP_NAME} Planner.\nFamily Members: ${ev.members?.join(', ') || 'All'}\n${marker}`,
    location: ev.location || '',
    ...timing,
  };
}

// Minimal shape of a Google Calendar event item we read back when searching for an existing push.
export interface GoogleApiEvent {
  id: string;
  description?: string;
  [k: string]: unknown;
}

// Find an already-pushed Google event by our dedupe marker in its description (drives find-or-update
// vs insert). Pure; tolerant of a non-array / marker-less input. Shared by both push paths.
export function findGoogleEventByMarker(items: GoogleApiEvent[], marker: string): GoogleApiEvent | undefined {
  if (!Array.isArray(items)) return undefined;
  return items.find(item => (item?.description || '').includes(marker));
}

// Human-readable result line for a manual push to N calendars. Pure.
export function summarizePushResult(ok: number, fail: number): string {
  return `Pushed to ${ok} calendar${ok === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}.`;
}

// Pick the Google calendar id(s) to push to (A3 last-mile): the connected, active PUSH-rule calendars; else
// fall back to the WRITABLE primary (owner/writer — never a reader-only primary, which would 403). Returns []
// when there's nowhere safe to push, so the caller can nudge the parent to connect a Push rule. Pure → tested.
export function selectPushTargets(
  connected: { id: string; direction: 'pull' | 'push'; active?: boolean; accountEmail?: string }[],
  list: { id: string; primary?: boolean; accessRole?: string }[],
  currentEmail?: string,
): string[] {
  // Only the SIGNED-IN account's token can write to its calendars, so a push target must belong to the current
  // account (or be a legacy connection with no accountEmail) — otherwise we'd push to another parent's calendar
  // with the wrong token (a guaranteed 403/404).
  const pushCals = (Array.isArray(connected) ? connected : [])
    .filter(c => c.direction === 'push' && c.active !== false && (!currentEmail || !c.accountEmail || c.accountEmail === currentEmail))
    .map(c => c.id);
  if (pushCals.length) return pushCals;
  const primary = (Array.isArray(list) ? list : []).find(c => c.primary && (c.accessRole === 'owner' || c.accessRole === 'writer'))?.id;
  return primary ? [primary] : [];
}

// Which events the bulk "Sync" push exports to a connected push calendar: EVERY Family-Hub-owned event,
// regardless of which member it's tagged with. This is a FAMILY calendar — a trip or any event created here
// belongs on each parent's calendar — so the push rule's `assignedTo` is a label, not a filter. Excludes
// `gcal-` events (they were PULLED from Google; pushing them back would echo them to their source). Pure → tested.
export function pushableLocalEvents<T extends { id: string }>(events: T[]): T[] {
  return (Array.isArray(events) ? events : []).filter(e => !e.id.startsWith('gcal-'));
}

// True when a Google event's description carries OUR dedupe marker — i.e. it's a copy WE pushed. The pull
// import skips these so a calendar that is both pulled AND pushed doesn't re-import our pushes as gcal- dupes.
export function isFamilyHubMarked(description?: string | null): boolean {
  return /\[FamilyHub-id:/.test(description || '');
}

// Events the silent auto-push should send from THIS device: Family-Hub-owned (non-gcal), within the sync
// window [fromDate, toDate] (by start date, inclusive), and not already pushed from here. Pure → tested.
export function selectAutoPushEvents<T extends { id: string; start?: string }>(
  events: T[], pushedIds: Set<string> | string[], fromDate: string, toDate: string,
): T[] {
  const pushed = pushedIds instanceof Set ? pushedIds : new Set(pushedIds);
  return pushableLocalEvents(events).filter(e => {
    if (pushed.has(e.id)) return false;
    const start = e.start || '';
    return start >= fromDate && start <= toDate;
  });
}
