// Deterministic "DATE FACTS" grounding for the local copilot. The small local models plan well but
// cannot reliably compute the day of the week (qwen2.5:14b called Jun 19 both "Saturday" AND
// "Monday" in one answer), so instead of trusting them we hand them the weekday for every upcoming
// date plus the exact weekend dates, and the harness system prompt
// forbids them from computing their own. Pure/testable — no I/O.

import { sanitizeForPrompt } from './promptSafety';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Weekday name for an ISO 'YYYY-MM-DD' (UTC, so it never drifts with the host timezone).
export function weekdayOf(iso: string): string {
  return WEEKDAYS[new Date(iso.slice(0, 10) + 'T00:00:00Z').getUTCDay()];
}

export function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Build the authoritative DATE FACTS block: today, the next `days` dates with weekdays, the next
// two weekends spelled out, and known events tagged with their weekday.
export function buildDateFacts(today: string, events: { title: string; start: string; end?: string }[] = [], days = 12, nowLabel?: string): string {
  const upcoming: string[] = [];
  const saturdays: string[] = [];
  const sundays: string[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(today, i);
    const wd = weekdayOf(iso);
    upcoming.push(`  - ${wd} ${iso}${i === 0 ? ' (TODAY)' : ''}`);
    if (wd === 'Saturday') saturdays.push(iso);
    if (wd === 'Sunday') sundays.push(iso);
  }
  const weekend = (label: string, i: number) => {
    const parts = [saturdays[i] && `Saturday ${saturdays[i]}`, sundays[i] && `Sunday ${sundays[i]}`].filter(Boolean);
    return parts.length ? `  - ${label}: ${parts.join(', ')}` : '';
  };
  // Empty-state guard: spell out "no commitments" so a small model doesn't hallucinate placeholders.
  // Multi-day events are annotated "(through <end>)" so DATE FACTS doesn't read as a one-day event
  // while AVAILABILITY/LONG WEEKEND span the whole range (the two blocks would otherwise contradict).
  const eventLines = events.length
    ? events.map(e => {
        const start = e.start.slice(0, 10);
        const end = e.end ? String(e.end).slice(0, 10) : '';
        const span = end && end !== start ? ` (through ${weekdayOf(end)} ${end})` : '';
        return `  - ${weekdayOf(start)} ${start}: ${sanitizeForPrompt(e.title, 100)}${span}`;
      }).join('\n')
    : '  - (none) — the family has no existing commitments in this window.';
  // nowLabel is the server-local wall-clock time (e.g. "3:15 PM"); injecting it prevents after-hours
  // suggestions ("go to the zoo" at 5pm) and reinforces the date anchor.
  return [
    'DATE FACTS (authoritative — use these weekdays VERBATIM; do NOT compute your own):',
    `Today is ${weekdayOf(today)}, ${today}${nowLabel ? ` at ${sanitizeForPrompt(nowLabel, 16)}` : ''}.`,
    'Upcoming days:',
    upcoming.join('\n'),
    'Weekends:',
    [weekend('Upcoming weekend', 0), weekend('Following weekend', 1)].filter(Boolean).join('\n'),
    'Known calendar events:',
    eventLines,
  ].join('\n');
}

// Recent chat turns, flattened into a labeled block so the model can resolve references like
// "that" / "the suggestions" / "extend it" — the copilot is otherwise stateless per request. Each
// turn is sanitized (no newlines → can't break the block) and length-capped; only the last few are
// kept so the prompt + latency stay bounded. The FACTS blocks are CURRENT and override anything
// said earlier. Returns '' when there's nothing to include.
export function buildConversationBlock(
  history: { role?: string; text?: string }[],
  maxTurns = 6,
  maxLen = 700,
): string {
  const turns = (Array.isArray(history) ? history : [])
    .filter(m => m && typeof m.text === 'string' && m.text.trim())
    .slice(-maxTurns);
  if (!turns.length) return '';
  const lines = turns.map(m => `${m.role === 'assistant' ? 'You' : 'Parent'}: ${sanitizeForPrompt(m.text, maxLen)}`);
  return [
    'RECENT CONVERSATION (context only — for resolving references like "that"/"the suggestions"/"extend it"; the FACTS blocks above are CURRENT and override anything said earlier):',
    ...lines,
  ].join('\n');
}

// The user-message half of the harnessed prompt: DATE FACTS + optional AVAILABILITY + optional
// WEATHER FACTS + optional HISTORY FACTS + roster + optional recent conversation + the parent's
// request. The rules live in the system prompt (COPILOT_HARNESS_SYSTEM), so this stays lean. The
// optional blocks are server-built and injected only when present; the model reads them rather than
// guessing.
export function buildHarnessUserPrompt(
  today: string,
  events: any[],
  memberNames: string[],
  question: string,
  availability?: string,
  weather?: string,
  history?: string,
  conversation?: string,
  longWeekend?: string,
  places?: string,
  eventsNearby?: string,
  nowLabel?: string,
  homeLabel?: string,
  localKnowledge?: string,
  savedDocs?: string,
): string {
  // HOME sits right under DATE FACTS, ALWAYS present when set (independent of the grounding fetch), so
  // the model never lacks the family's location and never asks the parent for a city/ZIP it already has.
  const homeBlock = homeLabel && homeLabel.trim()
    ? `\n\nHOME: ${sanitizeForPrompt(homeLabel, 80)} — the family's home base. You already have their location; treat "near me"/"nearby"/"close by" as near here and NEVER ask the parent for a city or ZIP.`
    : '';
  // LONG WEEKEND sits right after DATE FACTS — it's a server-computed extension of the same dates.
  const lwBlock = longWeekend ? `\n\n${longWeekend.trim()}` : '';
  const availBlock = availability ? `\n\n${availability.trim()}` : '';
  const weatherBlock = weather ? `\n\n${weather.trim()}` : '';
  // PLACES + EVENTS sit right after WEATHER so the model can match indoor/outdoor to the forecast.
  const placesBlock = places ? `\n\n${places.trim()}` : '';
  const eventsBlock = eventsNearby ? `\n\n${eventsNearby.trim()}` : '';
  const historyBlock = history ? `\n\n${history.trim()}` : '';
  // LOCAL KNOWLEDGE (saved docs) sits after the world-grounding blocks — household-specific facts.
  const knowledgeBlock = localKnowledge ? `\n\n${localKnowledge.trim()}` : '';
  // SAVED DOCS — the names the model may move_document / delete_document by (it must use these exact names).
  const docsBlock = savedDocs && savedDocs.trim()
    ? `\n\nSAVED DOCS (the family's Library documents — you may move_document or delete_document these, referencing the EXACT name shown): ${sanitizeForPrompt(savedDocs, 1200)}`
    : '';
  const convoBlock = conversation ? `\n\n${conversation.trim()}` : '';
  const safeMembers = (Array.isArray(memberNames) ? memberNames : []).map(m => sanitizeForPrompt(m, 60)).filter(Boolean);
  return `${buildDateFacts(today, events, 28, nowLabel)}${homeBlock}${lwBlock}${availBlock}${weatherBlock}${placesBlock}${eventsBlock}${historyBlock}${knowledgeBlock}${docsBlock}

Active family members: ${safeMembers.join(', ') || '(none specified)'}.${convoBlock}

Parent's request: "${question}"`;
}
