// Deterministic guard: an agent must NOT stage a delete of an all-day / Holiday-category event unless the
// family's message explicitly asked to remove it. Holidays + all-day markers (no-school, OOO, a holiday) are
// informational — they never BLOCK a new timed plan — so an unrequested delete of one is a data-loss mistake
// (the model drifting past its prompt). This is the server-authoritative backstop behind the prompt fix: the
// prompt tells the agent not to flag holidays; this refuses to STAGE the delete if it does anyway. Pure → tested.
import type { CalendarEvent } from '../types';
import { resolveEventDeletion } from './aiActions';

// An event is "protected" from an unrequested delete when it has no clock time (all-day: holidays, no-school,
// OOO) OR its category is Holiday. These coexist with a new timed outing, so they're never a booking conflict.
export function isHolidayOrAllDay(e: { startTime?: string; category?: string } | undefined): boolean {
  if (!e) return false;
  if (!e.startTime) return true;
  return String(e.category || '').trim().toLowerCase() === 'holiday';
}

// A delete verb ALONE isn't proof the family wants a HOLIDAY gone: "clear the driveway", "drop the
// kids", "cancel the noise" all carry an incidental verb that used to disable the whole guard globally.
// Instead, a protected delete counts as EXPLICIT only when the message pairs a delete verb with either
// an event-referencing word OR the victim's own title — so an incidental verb elsewhere in the sentence
// no longer switches off the data-loss protection. Erring toward PROTECT (a wrongly-kept holiday is
// recoverable by a manual delete; a wrongly-executed delete is data loss).
const DELETE_VERB_RE = /\b(delete|remove|cancel|clear|get rid of|take off|drop)\b/i;
const EVENT_CONTEXT_RE = /\b(event|events|holiday|holidays|calendar|appointment|reminder|no[- ]?school|day off|it|that|this|them|those)\b/i;

// Does the user text name this event? True when a "significant" title word (3+ chars) appears in the text.
function titleMentioned(userText: string, titles: (string | undefined)[]): boolean {
  const hay = userText.toLowerCase();
  return titles.some(t => String(t || '')
    .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3)
    .some(w => hay.includes(w)));
}

export interface HolidayGuardResult<T> { kept: T[]; dropped: { title: string }[] }

// Filter delete actions that would remove a protected (all-day/holiday) event WITHOUT the family asking. Each
// action is read via `read` (shape-agnostic: the agent path passes {tool,artifact}; the local path {type,payload}).
// Drops a delete only when EVERY resolved target is protected (a mixed match — also hitting a real timed event —
// is kept for human review). An explicit delete verb in `userText` disables the guard (the removal is intended).
export function filterUnrequestedHolidayDeletes<T>(
  actions: T[],
  events: CalendarEvent[],
  userText: string,
  read: (a: T) => { isDeleteEvent: boolean; ref: { id?: string; title?: string; start?: string } },
): HolidayGuardResult<T> {
  const list = Array.isArray(actions) ? actions : [];
  const text = String(userText || '');
  const hasDeleteVerb = DELETE_VERB_RE.test(text);
  const kept: T[] = [];
  const dropped: { title: string }[] = [];
  for (const a of list) {
    const { isDeleteEvent, ref } = read(a);
    if (!isDeleteEvent) { kept.push(a); continue; }
    const { victims } = resolveEventDeletion(events, { refId: ref.id, title: ref.title, start: ref.start });
    if (victims.length > 0 && victims.every(isHolidayOrAllDay)) {
      // Keep the protected delete ONLY if the family explicitly asked: a delete verb AND either an
      // event-referencing word or this event named by title. Otherwise it's an unrequested delete → drop.
      const explicit = hasDeleteVerb
        && (EVENT_CONTEXT_RE.test(text) || titleMentioned(text, [ref.title, ...victims.map(v => v.title)]));
      if (!explicit) {
        dropped.push({ title: ref.title || victims[0]?.title || 'event' });
        continue;
      }
    }
    kept.push(a);
  }
  return { kept, dropped };
}
