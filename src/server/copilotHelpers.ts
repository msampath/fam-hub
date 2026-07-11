import { randomUUID } from 'crypto';
import { COPILOT_ACTIONS, selectorSatisfied } from '../mcp/actionContract';

// Shift a 'YYYY-MM-DD' by n days (UTC). Used to convert an exclusive all-day ICS DTEND
// (the day after the last day) into an inclusive end date.
export function shiftIsoDate(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().split('T')[0];
}

// Keep only events that are today-or-later (drop fully-past ones) so the planner can never list
// or propose a past day — a weak fallback model won't reliably filter dates itself. Compares on
// the event's END date (falling back to START), date-only; ISO 'YYYY-MM-DD' strings sort
// chronologically, so a lexical >= is a correct date comparison. Null/undated events are dropped.
export function filterUpcomingEvents(events: any[], today: string): any[] {
  if (!Array.isArray(events)) return [];
  return events.filter(e => {
    const when = String(e?.end || e?.start || '').slice(0, 10);
    return when !== '' && when >= today;
  });
}

// Collapse duplicate copilot actions (same type + key payload fields), so a model that emits the
// same create_event several times can't spray duplicate entries onto the calendar ("multiple
// entries all for June 17"). Order-preserving; first occurrence of each key wins.
export function dedupeActions(actions: any[]): any[] {
  if (!Array.isArray(actions)) return [];
  const seen = new Set<string>();
  const out: any[] = [];
  for (const a of actions) {
    const p = a?.payload || {};
    const key = [a?.type, p.title, p.start, p.text, p.assignedTo]
      .map(x => String(x ?? '').trim().toLowerCase()).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

export const ALLOWED_COPILOT_ACTIONS = new Set(COPILOT_ACTIONS);

// Collision key for find-vs-create: date + a normalized title (lowercased, punctuation/whitespace
// collapsed) so a model paraphrase ("Zoo!" vs "zoo") still matches an existing calendar event.
function eventCollisionKey(start: any, title: any): string {
  return `${String(start || '').slice(0, 10)}|${String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
}

export function sanitizeCopilotActions(actions: any[], existingEvents: any[] = []): any[] {
  if (!Array.isArray(actions)) return [];
  const existing = new Set((Array.isArray(existingEvents) ? existingEvents : []).map(e => eventCollisionKey(e?.start, e?.title)));
  return actions.filter(a => {
    if (!a || !ALLOWED_COPILOT_ACTIONS.has(a.type)) return false;
    if (!selectorSatisfied(a.type, a.payload)) return false;
    if (a.type === 'create_event') {
      const p = a.payload || {};
      if (p.start && p.title && existing.has(eventCollisionKey(p.start, p.title))) return false;
    }
    return true;
  });
}

export interface GroundingFact {
  id: string;              // 'P1' / 'E1' — matches the [P#]/[E#] tag in the FACTS block
  name: string;            // authoritative display name
  url?: string;            // a REAL link (place website/Maps, or the event page) — never model-written
  kind: 'place' | 'event';
  date?: string;           // events: the fixed YYYY-MM-DD (overrides the model's start)
}

export function sanitizeSuggestions(list: any, existingEvents: any[] = [], facts: GroundingFact[] = []): any[] {
  if (!Array.isArray(list)) return [];
  const factById = new Map<string, GroundingFact>();
  const factByName = new Map<string, GroundingFact>();
  for (const f of Array.isArray(facts) ? facts : []) {
    if (f?.id) factById.set(String(f.id).toUpperCase(), f);
    if (f?.name) factByName.set(String(f.name).trim().toLowerCase(), f);
  }
  const existing = new Set(
    (Array.isArray(existingEvents) ? existingEvents : []).map(e => eventCollisionKey(e?.start, e?.title)),
  );
  const seenInBatch = new Set<string>();
  const out: any[] = [];
  for (const s of list) {
    if (!s || typeof s.start !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(s.start.trim())) continue;
    const isPlace = s.type === 'place' || (s.type !== 'idea' && typeof s.ref === 'string' && !!s.ref.trim());
    let resolved: any;
    if (isPlace) {
      const refKey = typeof s.ref === 'string' ? s.ref.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : '';
      let fact = refKey ? factById.get(refKey) : undefined;
      if (!fact && !refKey && typeof s.title === 'string') fact = factByName.get(s.title.trim().toLowerCase());
      if (!fact) continue;
      const start = fact.kind === 'event' && fact.date ? fact.date : String(s.start).slice(0, 10);
      resolved = {
        start,
        title: String(fact.name).slice(0, 120),
        ...(fact.url ? { url: String(fact.url).slice(0, 400) } : {}),
        ...(typeof s.category === 'string' ? { category: s.category } : {}),
        ...(Array.isArray(s.members) ? { members: s.members.map(String).slice(0, 12) } : {}),
        ...(typeof s.note === 'string' ? { note: s.note.slice(0, 300) } : {}),
      };
    } else {
      if (typeof s.title !== 'string' || !s.title.trim()) continue;
      resolved = {
        start: String(s.start).slice(0, 10),
        title: String(s.title).slice(0, 120),
        ...(typeof s.category === 'string' ? { category: s.category } : {}),
        ...(Array.isArray(s.members) ? { members: s.members.map(String).slice(0, 12) } : {}),
        ...(typeof s.note === 'string' ? { note: s.note.slice(0, 300) } : {}),
      };
    }
    const k = eventCollisionKey(resolved.start, resolved.title);
    if (existing.has(k) || seenInBatch.has(k)) continue;
    seenInBatch.add(k);
    out.push(resolved);
    if (out.length >= 14) break;
  }
  return out;
}

function parseICalDate(icalDate: string): string {
  const isUtc = /z$/i.test(icalDate.trim());
  const clean = icalDate.replace(/[^0-9T]/g, '');
  if (clean.length >= 8) {
    const year = clean.substring(0, 4);
    const month = clean.substring(4, 6);
    const day = clean.substring(6, 8);
    if (clean.includes('T') && clean.length >= 15) {
      const hour = clean.substring(9, 11);
      const min = clean.substring(11, 13);
      const sec = clean.substring(13, 15);
      if (isUtc) {
        const d = new Date(Date.UTC(+year, +month - 1, +day, +hour, +min, +sec));
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      }
      return `${year}-${month}-${day}T${hour}:${min}:${sec}`;
    }
    return `${year}-${month}-${day}`;
  }
  return icalDate;
}

export function parseICS(text: string, category: string = 'School'): any[] {
  const events: any[] = [];
  const lines = text.split(/\r?\n/);
  let currentEvent: any = null;

  const unfoldedLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') && unfoldedLines.length > 0) {
      unfoldedLines[unfoldedLines.length - 1] += line.substring(1);
    } else if (line) {
      unfoldedLines.push(line);
    }
  }

  for (const line of unfoldedLines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      currentEvent = {};
    } else if (line.startsWith('END:VEVENT')) {
      if (currentEvent) {
        if (currentEvent.start) {
          const startVal = parseICalDate(currentEvent.start);
          let endVal = currentEvent.end ? parseICalDate(currentEvent.end) : undefined;
          if (endVal && !startVal.includes('T') && !endVal.includes('T')) {
            endVal = shiftIsoDate(endVal, -1);
            if (endVal < startVal) endVal = startVal;
          }
          events.push({
            id: 'ics-' + randomUUID(),
            title: currentEvent.title || 'Untitled Event',
            start: startVal,
            end: endVal,
            description: currentEvent.description || '',
            location: currentEvent.location || '',
            category: category,
            ageGroup: 'All age'
          });
        }
        currentEvent = null;
      }
    } else if (currentEvent) {
      const colonIdx = line.indexOf(':');
      if (colonIdx !== -1) {
        const keyPart = line.substring(0, colonIdx);
        const val = line.substring(colonIdx + 1);
        const key = keyPart.split(';')[0];

        if (key === 'SUMMARY') {
          currentEvent.title = val;
        } else if (key === 'DESCRIPTION') {
          currentEvent.description = val.replace(/\\n/g, '\n').replace(/\\,/g, ',');
        } else if (key === 'LOCATION') {
          currentEvent.location = val.replace(/\\,/g, ',');
        } else if (key === 'DTSTART') {
          currentEvent.start = val;
        } else if (key === 'DTEND') {
          currentEvent.end = val;
        }
      }
    }
  }
  return events;
}
