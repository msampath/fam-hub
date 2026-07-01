// Server-side AVAILABILITY classifier for the copilot harness. The weak local models can't be
// trusted to read a free-text event title and infer that "OOO"/"no school"/"last day" means a
// person is FREE (qwen-class models get this exactly backwards), so — exactly like DATE FACTS —
// we classify each upcoming event OFF/free vs BUSY deterministically, per person, and hand the
// model an authoritative AVAILABILITY block to read instead of interpreting titles. Pure/testable.
// Availability is per person; the grounding harness is the quality lever, not the model.
import { weekdayOf, addDaysISO } from './copilotHarness';
import { sanitizeForPrompt } from './promptSafety';

// Title keywords that mean a person is OFF/free (time-off), not busy. Kept deliberately conservative —
// the explicit per-event freeBusy='free' control is the authoritative path for ambiguous cases. "off"
// is matched ONLY in clear time-off PHRASES ("off work"/"off today"/…) or as a standalone title ("Off");
// bare \boff\b was too broad — it flipped busy commitments to free ("Play-off game", "Send-off party",
// "One-off task", "Off to work"). "holiday" is intentionally NOT a keyword (the Holiday *category* maps
// to OFF, and "Holiday Party" is busy).
export const OFF_KEYWORDS = [
  'ooo', 'out of office', 'pto', 'vacation', 'no school',
  'day off', 'off work', 'off today', 'off all day', 'off sick', 'time off', 'last day',
];
// Match keywords on WORD boundaries (not substrings) so "Return laptop" doesn't hit "pto" and
// "vacationland" doesn't hit "vacation". Keywords contain no regex metacharacters.
const OFF_RE = new RegExp(`\\b(?:${OFF_KEYWORDS.join('|')})\\b`, 'i');
// Phrases that LOOK like an OFF keyword but are actually BUSY commitments — checked FIRST so they win.
// "PTO meeting" = Parent-Teacher Org (busy); "day off-site" = an off-site work day; "drop/kick/pick/
// face off" are busy commitments that contain "off". Kept narrow so genuine time-off stays OFF.
const OFF_FALSE_POSITIVE_RE = /\b(?:pto meeting|day off-?site|(?:drop|kick|pick|face)[\s-]?off)\b/i;
// A title that is JUST "off" (a bare day-off marker) → OFF. "Off to work" / "Off-site" are NOT standalone.
const OFF_STANDALONE_RE = /^\s*off\s*$/i;

// Both whole-family sentinels the app uses: 'Everyone' (event-editor default) and 'Family' (the
// Google-sync default assignee + an AddEventModal option). Either means the whole household, so an
// OFF event tagged with either marks the family off (availability + the long-weekend gate).
const WHOLE_FAMILY_TAGS = ['everyone', 'family'];
export function isWholeFamilyTag(tag: string): boolean {
  return WHOLE_FAMILY_TAGS.includes(String(tag).trim().toLowerCase());
}

// Named DAY-OFF holidays — a deterministic backstop so a holiday-calendar event that wasn't tagged
// `category:'Holiday'` (e.g. a Google "Father's Day" event via a differently-named calendar → stays
// `category:'Other'`) still reads as OFF. ANCHORED to the whole title (allowing "Day"/"Eve"/"(observed)"
// decorations) so a busy event that merely MENTIONS a holiday ("Memorial Day work shift", "Father's Day
// brunch shift") is NOT misread as time-off. Limited to genuine days off (no Halloween/Valentine's).
const HOLIDAY_NAME_RE = /^\s*(?:new year(?:'s)?(?: day| eve)?|(?:martin luther king(?: jr\.?)?|mlk)(?: day)?|presidents?'?s? day|washington'?s birthday|memorial day|juneteenth(?: national independence day)?|independence day|fourth of july|4th of july|labor day|thanksgiving(?: day)?|christmas(?: day| eve)?|mother'?s day|father'?s day|veterans?'?s? day)\s*(?:\d{4})?\s*(?:\([^)]*\))?\s*$/i;

// Classify a single event as OFF (time-off → the person is MORE available) or BUSY (the event
// occupies the person). An explicit per-event freeBusy flag wins (the owner's override closes the
// "OOO sync meeting" keyword misfire AND lets a "Father's Day work shift" be marked busy); otherwise
// category 'Holiday' wins; otherwise a named-holiday title; otherwise a busy-phrase false-positive;
// otherwise a standalone "Off" or a title keyword; otherwise BUSY.
export function classifyEvent(e: { title?: string; category?: string; freeBusy?: string }): 'OFF' | 'BUSY' {
  if (e?.freeBusy === 'free') return 'OFF';
  if (e?.freeBusy === 'busy') return 'BUSY';
  if (String(e?.category || '').trim().toLowerCase() === 'holiday') return 'OFF';
  const title = String(e?.title || '');
  if (HOLIDAY_NAME_RE.test(title)) return 'OFF';        // the title IS a named holiday → day off
  if (OFF_FALSE_POSITIVE_RE.test(title)) return 'BUSY';  // busy "*off" phrases win over the keywords
  if (OFF_STANDALONE_RE.test(title)) return 'OFF';       // the whole title is just "Off"
  return OFF_RE.test(title) ? 'OFF' : 'BUSY';
}

type Line = { date: string; status: 'OFF' | 'BUSY'; reason: string; time: string };

// The dates an event covers that fall inside the [today, today+days) window, clamped to the window
// (a multi-day vacation only marks the in-window days; spans entirely outside are dropped). ISO
// 'YYYY-MM-DD' strings compare chronologically, so lexical comparison is a correct date comparison.
function datesInWindow(start: string, end: string, today: string, windowEndExcl: string): string[] {
  const out: string[] = [];
  let d = start < today ? today : start;
  // guard caps the loop so a malformed/huge range can't spin (window is only ~12 days anyway).
  for (let guard = 0; d < windowEndExcl && d <= end && guard < 400; guard++) {
    out.push(d);
    d = addDaysISO(d, 1);
  }
  return out;
}

// Build the authoritative AVAILABILITY block: per-person OFF/BUSY for every in-window day that has
// a classified event. Availability is per person — an event tagged to one member doesn't occupy
// the others; an untagged or "Everyone" event affects the whole family. Returns '' when there's
// nothing in-window (so buildHarnessUserPrompt injects no block).
export function buildAvailabilityBlock(today: string, events: any[], memberNames: string[], days = 12): string {
  const roster = (Array.isArray(memberNames) ? memberNames : []).map(String).filter(Boolean);
  // Map lowercased → canonical roster name so a tag like "aisu"/"Aisu " resolves to the roster
  // person instead of spawning a ghost "extra" row (which made the model think the real member free).
  const rosterByLc = new Map(roster.map(r => [r.trim().toLowerCase(), r]));
  // With no roster we can't scope to a person, so collapse everything under a single "Family" row.
  const familyLabel = roster.length ? 'Everyone' : 'Family';
  const windowEndExcl = addDaysISO(today, days);

  const byPerson = new Map<string, Line[]>();
  const push = (person: string, line: Line) => {
    const lines = byPerson.get(person) || [];
    // Dedupe identical lines so two overlapping events don't print the same row twice.
    if (!lines.some(l => l.date === line.date && l.status === line.status && l.reason === line.reason && l.time === line.time)) {
      lines.push(line);
    }
    byPerson.set(person, lines);
  };

  // Trim a 'HH:MM[:SS]' to 'HH:MM'; '' when absent/malformed.
  const hhmm = (t: any): string => (typeof t === 'string' && /^\d{1,2}:\d{2}/.test(t.trim()) ? t.trim().slice(0, 5) : '');

  for (const e of Array.isArray(events) ? events : []) {
    const start = String(e?.start || '').slice(0, 10);
    if (!start) continue;
    const end = String(e?.end || e?.start || '').slice(0, 10);
    const status = classifyEvent(e);
    const reason = sanitizeForPrompt(e?.title, 40);
    // Surface a BUSY appointment's clock window so a day with a 2pm appt doesn't read as wholly free
    // (Bug 5: the copilot booked an afternoon outing over an existing afternoon appointment).
    const st = hhmm(e?.startTime);
    const time = status === 'BUSY' && st ? (hhmm(e?.endTime) ? `${st}–${hhmm(e?.endTime)}` : st) : '';

    const tagged = Array.isArray(e?.members) ? e.members.map(String).filter(Boolean) : [];
    let people: string[];
    if (!roster.length) people = [familyLabel];
    else if (!tagged.length || tagged.some(isWholeFamilyTag)) people = [familyLabel];
    else people = tagged.map(m => rosterByLc.get(m.trim().toLowerCase()) || m); // canonicalize known names

    // Attach a BUSY appointment's clock window only on the event's actual start day — a multi-day
    // timed event must not stamp the same hours on every spanned day (a conference 9–5 Mon–Wed
    // doesn't recur 9–5 each day for outing purposes).
    for (const date of datesInWindow(start, end, today, windowEndExcl)) {
      const lineTime = date === start ? time : '';
      for (const person of people) push(person, { date, status, reason, time: lineTime });
    }
  }

  if (!byPerson.size) return '';

  // Order: roster names first (in roster order), then any other tagged names (sorted), then the
  // family-wide row last.
  const extras = [...byPerson.keys()].filter(p => p !== familyLabel && !roster.includes(p)).sort();
  const ordered = [...roster.filter(p => byPerson.has(p)), ...extras];
  if (byPerson.has(familyLabel)) ordered.push(familyLabel);

  const sections = ordered.map(person => {
    const lines = byPerson.get(person)!
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date) || a.status.localeCompare(b.status))
      .map(l => `  - ${weekdayOf(l.date)} ${l.date}: ${l.status}${l.time ? ` ${l.time}` : ''}${l.reason ? ` (${l.reason})` : ''}`);
    return [`- ${sanitizeForPrompt(person, 60)}:`, ...lines].join('\n');
  });

  return [
    'AVAILABILITY (authoritative per-person free/busy — trust these labels over titles):',
    ...sections,
    'Days not listed for a person have no known commitments — treat that person as free.',
  ].join('\n');
}
