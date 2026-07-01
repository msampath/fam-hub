// Kids' activities ingestion (capability B3, the "planning" half). Provider-agnostic: consumes a
// NormalizedMessage from the shared email adapter (src/utils/email.ts). Same privacy contract as
// bills/packages: tight filter, parse in-memory, store ONLY parsed fields — never the email body.
// (PDFs + calendar links are already covered by the existing AI Import: /api/parse-pdf,
// /api/parse-calendar, /api/parse-text — this adds the EMAIL source.) Pure → unit-testable.
import type { CopilotSuggestion, Category } from '../types';
import { type NormalizedMessage, emailBlocks } from './email';
import { cleanTime } from './aiActions';

const VALID_CATEGORIES: Category[] = ['School', 'Camp', 'Sports', 'Arts', 'Holiday', 'Other'];

// A parsed kid activity/event — the ONLY thing kept (never the email body).
export interface ParsedActivity {
  title: string;
  date?: string;       // YYYY-MM-DD
  time?: string;       // 'HH:MM' 24h if stated
  location?: string;
  category?: string;   // School|Camp|Sports|Arts|Holiday|Other (clamped)
}

// Tight Gmail filter: kids' schedule/activity mail in a recent-ish window.
export function buildKidsActivityQuery(days = 60): string {
  return `newer_than:${days}d (subject:(camp OR practice OR rehearsal OR lesson OR "field trip" OR tryout OR game OR recital OR "class schedule" OR registration OR "sign up" OR roster) OR from:(school OR camp OR coach OR teamsnap OR classdojo OR sportsengine))`;
}

// Build the activity-extraction prompt. Email fields are sanitized via the shared emailBlocks() helper.
export function buildKidsActivityParsePrompt(messages: NormalizedMessage[]): string {
  return `You are extracting KIDS' ACTIVITIES / scheduled events (camps, practices, lessons, games, recitals, field trips, school events) from the emails below. Return JSON {"activities":[...]}.\n`
    + `For each dated activity, output: title (short, e.g. "Soccer practice"), date (YYYY-MM-DD), time ("HH:MM" 24h if stated), location (if stated), category (one of School, Camp, Sports, Arts, Holiday, Other). `
    + `Ignore marketing and anything with no specific date. If none, return {"activities":[]}.\n\n`
    + emailBlocks(messages);
}

// Map a parsed activity → a tap-to-add suggestion (a dated event the parent approves). Returns null
// unless there's a real, today-or-future date.
export function activityToSuggestion(a: ParsedActivity, todayStr: string): CopilotSuggestion | null {
  const date = String(a?.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < todayStr) return null;
  const title = String(a?.title || 'Activity').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Activity';
  const time = cleanTime(a?.time);
  const loc = String(a?.location || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const category = (VALID_CATEGORIES as string[]).includes(String(a?.category)) ? (a!.category as Category) : 'Other';
  const noteParts = [time ? `at ${time}` : '', loc ? `@ ${loc}` : ''].filter(Boolean);
  return {
    start: date,
    title,
    category,
    note: noteParts.join(' ').slice(0, 200) || undefined,
  };
}
