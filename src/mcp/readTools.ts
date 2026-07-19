// MCP READ tools — the gathering side of the toolbelt, for agents that must look things up before they
// act/reason (e.g. the Briefing agent: read events + chores + what's coming up, then derive nudges and
// delegate). Like find_places these are I/O (they read the visitor's household from Supabase via
// Persistence in server.ts); the PURE shaping below is unit-tested. Read-only — no tier/no-payment surface.
import type { CalendarEvent, Chore, Bill } from '../types';
import { dueChores } from '../utils/reminders';
import { addOneDayUTC } from '../utils/dates';
import { pickDocs, type KnowledgeDoc } from '../utils/localKnowledge';
import { sanitizeForPrompt } from '../utils/promptSafety';

export interface ReadToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown> };
}

export const READ_TOOL_DEFS: ReadToolDef[] = [
  {
    name: 'get_events',
    description: "List the family's calendar events. Returns each event's title, date, time (if any), "
      + 'category, allDay (true for holidays / all-day markers), and who it involves. Use this to answer '
      + '"what\'s on the calendar" or before scheduling around existing events. An all-day or Holiday-category '
      + 'event is informational and does NOT block a new timed plan — never treat it as a conflict. '
      + 'Pass from + to (YYYY-MM-DD) to scope to a date window — e.g. set both to a trip\'s dates to check that '
      + 'exact range for conflicts (without them you get the 30 earliest events, which may miss a future date).',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'number', description: 'Max events to return (default 30).' },
      from: { type: 'string', description: 'Only events on/after this date YYYY-MM-DD (optional).' },
      to: { type: 'string', description: 'Only events on/before this date YYYY-MM-DD (optional).' },
    } },
  },
  {
    name: 'get_chores',
    description: "List the kids' chores. By default returns only chores still DUE (not yet completed today); "
      + 'pass all=true for the full list. Each item has its title and who it is assigned to.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean', description: 'Include completed chores too (default false → due only).' } } },
  },
  {
    name: 'get_upcoming',
    description: 'List events coming up in the next N days (default 7), soonest first — the gathering step for '
      + 'a morning briefing or "what does this week look like".',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: 'How many days ahead to include (default 7).' } } },
  },
  {
    name: 'get_bills',
    description: 'List the household bills found from email (payee, amount, due date). These were parsed by '
      + 'the background email scan — use them to answer "what bills are due" or "what do we owe". You do NOT '
      + 'pay anything (no payment tool exists); you only report what is due.',
    inputSchema: { type: 'object', properties: { upcomingOnly: { type: 'boolean', description: 'Only bills due today or later (default false → all).' } } },
  },
  {
    name: 'search_local_knowledge',
    description: "Search the family's saved documents + ingested local newsletters (the household's editorial "
      + 'knowledge) for facts relevant to a query — e.g. local events ("what\'s happening this weekend"), a '
      + 'school policy, or a saved note. Returns matching excerpts. Ground your answer in these; never invent.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What to look for, e.g. "weekend events", "early release schedule".' } } },
  },
];

// ── PURE shapers (unit-tested) ────────────────────────────────────────────────────────────────────
const byStart = (a: CalendarEvent, b: CalendarEvent) => (a.start || '').localeCompare(b.start || '');

export function shapeEvent(e: CalendarEvent) {
  const date = (e.start || '').slice(0, 10);
  const endDate = (e.end || '').slice(0, 10);
  // Surface the END date for a multi-day event so the agent SEES the span (e.g. "Aisu oncall through Jul 19")
  // and can flag a conflict that falls anywhere in the range — not just on the start day. `allDay` (no clock
  // time) + `category` let the agent tell a holiday / all-day marker apart from a timed event, so it never
  // treats "Independence Day" as a booking conflict (a timed plan can coexist with an all-day holiday).
  return {
    title: e.title || 'Event', date,
    ...(endDate && endDate !== date ? { endDate } : {}),
    startTime: e.startTime || undefined,
    ...(e.startTime ? {} : { allDay: true }),
    ...(e.category ? { category: e.category } : {}),
    members: e.members && e.members.length ? e.members : undefined,
  };
}

// `from`/`to` (YYYY-MM-DD) scope to a date window BEFORE limiting — without them, sorting ascending + slicing
// 30 returns the EARLIEST events (mostly past for an active household), which would hide a future trip-date
// conflict. Conflict checks pass from=to=the trip dates so the window can't be truncated away. The match is a
// SPAN OVERLAP (start <= to AND end >= from), not start-only — else a multi-day event that STARTS before the
// window but ENDS inside it (an oncall/vacation spanning into the trip) would be silently dropped. Mirrors
// eventsOnDate's range logic in utils/reminders.
export function shapeEvents(events: CalendarEvent[], limit = 30, opts?: { from?: string; to?: string }) {
  const from = opts?.from ? opts.from.slice(0, 10) : undefined;
  const to = opts?.to ? opts.to.slice(0, 10) : undefined;
  return events
    .filter(e => {
      if (!from && !to) return true;
      const d = (e.start || '').slice(0, 10);
      if (!d) return false;
      const dEnd = (e.end || e.start || '').slice(0, 10);
      return (!from || dEnd >= from) && (!to || d <= to);
    })
    .sort(byStart)
    .slice(0, Math.max(0, limit))
    .map(shapeEvent);
}

export function shapeUpcoming(events: CalendarEvent[], today: string, days = 7) {
  let end = today;
  for (let i = 0; i < Math.max(0, days); i++) end = addOneDayUTC(end);
  return events
    .filter(e => {
      const d = (e.start || '').slice(0, 10);
      if (!d) return false;
      // Compare on the END date (falling back to start) for the lower bound so an in-progress multi-day
      // event that STARTED before today but is still running is included — the same fix shapeEvents got.
      const dEnd = (e.end || e.start || '').slice(0, 10);
      return dEnd >= today && d <= end;
    })
    .sort(byStart)
    .map(shapeEvent);
}

export function shapeChores(chores: Chore[], all = false) {
  const list = all ? chores : dueChores(chores);
  return list.map(c => ({ title: c.title, assignedTo: c.assignedTo || undefined, timesPerDay: c.timesPerDay || 1, completedCount: c.completedCount || 0 }));
}

export function shapeBills(bills: Bill[], today: string, upcomingOnly = false) {
  return bills
    .filter(b => !upcomingOnly || !b.dueDate || b.dueDate.slice(0, 10) >= today)
    .map(b => ({ payee: b.payee, amount: b.amount || undefined, dueDate: b.dueDate || undefined, account: b.account || undefined }))
    .sort((a, c) => (a.dueDate || '~').localeCompare(c.dueDate || '~')); // soonest due first, undated last
}

// Retrieve the most relevant saved docs/newsletters for a query → compact excerpts for the agent. Docs are
// UNTRUSTED (ingested newsletters are attacker-influenceable), so every field is run through
// sanitizeForPrompt before it reaches the agent — same prompt-injection defense the copilot's grounding uses.
const toExcerpts = (docs: KnowledgeDoc[], perDocChars: number) =>
  docs.map(d => ({
    name: sanitizeForPrompt(d.name, 80),
    folder: d.folder ? sanitizeForPrompt(d.folder, 60) : undefined,
    excerpt: sanitizeForPrompt((d.text || '').slice(0, perDocChars), perDocChars),
  }));

// Semantic when RAG_EMBEDDINGS_ENABLED (with keyword fallback inside), else keyword — for the MCP handler.
export async function shapeKnowledgeAsync(docs: KnowledgeDoc[], query: string, max = 3, perDocChars = 600) {
  return toExcerpts(await pickDocs(docs, query, max), perDocChars);
}
