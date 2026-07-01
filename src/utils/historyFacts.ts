// Deterministic "HISTORY FACTS" grounding (Pattern 1): the server turns the household's per-place
// visit log into a "days since last visit" block, so the weak local model can favor places the
// family hasn't been to recently WITHOUT having to count days itself (same idea as DATE FACTS).
// "Surface, don't optimize" — the block reports staleness; the prompt tells the model to suggest,
// not blindly maximize novelty. Pure/testable — no I/O. Mirrors weatherFacts.ts / availability.ts.
import type { VisitLogEntry } from '../types';
import { sanitizeForPrompt } from './promptSafety';

// Whole days between two ISO 'YYYY-MM-DD' dates (UTC, so no host-timezone drift). Negative if b<a.
export function daysBetweenISO(a: string, b: string): number {
  const da = new Date(a.slice(0, 10) + 'T00:00:00Z').getTime();
  const db = new Date(b.slice(0, 10) + 'T00:00:00Z').getTime();
  return Math.round((db - da) / 86_400_000);
}

// Upsert a visit: if the label already exists (case-insensitive), keep the MOST RECENT lastVisited;
// else insert. Pure — returns a new array. Keeps the log bounded to one row per place.
export function upsertVisit(log: VisitLogEntry[], entry: VisitLogEntry): VisitLogEntry[] {
  const list = Array.isArray(log) ? log : [];
  const key = entry.label.trim().toLowerCase();
  let found = false;
  const next = list.map(v => {
    if (v.label.trim().toLowerCase() !== key) return v;
    found = true;
    // Keep the later date (don't let re-logging an old event overwrite a newer visit).
    const lastVisited = entry.lastVisited > v.lastVisited ? entry.lastVisited : v.lastVisited;
    return { ...v, lastVisited, category: entry.category ?? v.category };
  });
  return found ? next : [...next, entry];
}

// Build the HISTORY FACTS block: each place with whole days since the last visit, most-stale first.
// Returns '' when there's nothing to say (so the caller can skip injection entirely).
export function buildHistoryFacts(today: string, visits: VisitLogEntry[], maxItems = 12): string {
  const list = (Array.isArray(visits) ? visits : [])
    .filter(v => v && v.label && v.lastVisited)
    .map(v => ({ label: sanitizeForPrompt(v.label, 80), days: daysBetweenISO(v.lastVisited, today), last: String(v.lastVisited).slice(0, 10) }))
    .filter(v => v.label && v.days >= 0) // drop future-dated noise
    .sort((a, b) => b.days - a.days)     // most-stale (longest since visit) first
    .slice(0, maxItems);
  if (!list.length) return '';
  const lines = list.map(v => `- ${v.label}: ${v.days} day${v.days === 1 ? '' : 's'} ago (last ${v.last})`);
  return [
    'HISTORY FACTS (days since the family last visited each place; favor places not visited recently, but only SUGGEST — let the parent choose, do not force novelty):',
    ...lines,
    "Places not listed have no recorded visit — don't claim the family has or hasn't been somewhere that isn't here.",
  ].join('\n');
}
