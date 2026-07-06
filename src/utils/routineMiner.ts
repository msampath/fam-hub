// Pattern-4 routine mining (owner-gated by design): mine the quick-add log for shopping items the
// family adds AGAIN AND AGAIN on the same weekday, surface them as REVIEWABLE Manage toggles, and —
// only for routines the parent explicitly ENABLED — stage a confirm-tier draft on that weekday's
// digest run. Learned rules NEVER inject silently: candidate → parent toggle → weekday draft →
// Approvals. Pure + tested; App/Manage/server do the wiring.
import type { LedgerEntry, QuickAddLogEntry, Routine } from '../types';
import { buildLedgerEntry } from './historyLog';

export type { Routine } from '../types';

export interface RoutineCandidate { text: string; weekday: number; count: number; weeks: number }

// Normalize a quick-add text into a comparable item key: lowercase, strip the add-verb prefix and a
// trailing "to (the) <store> (list)" phrase, collapse whitespace. "Add milk to the Costco list" → "milk".
export const normalizeRoutineText = (raw: string): string =>
  String(raw || '')
    .toLowerCase()
    .replace(/^\s*(add|buy|get|need|pick up|grab)\s+/i, '')
    .replace(/\s+(?:to|on|for)\s+(?:the\s+)?[\w'’ -]{2,24}?\s*(?:list)?\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);

const isoWeekKey = (d: Date) => {
  // Coarse week bucket (year + week-of-year approximation) — distinguishing weeks is all we need.
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000;
  return Math.floor(day / 7);
};

/**
 * Mine shopping-kind quick-add entries for weekday-consistent repeats: the same normalized item
 * added on >=minCount occasions spanning >=minWeeks distinct weeks, with a clear modal weekday.
 * Returns candidates sorted by strength. Deliberately conservative — a false "routine" suggestion
 * costs parent trust; a missed one costs nothing (they'll keep typing it).
 */
export function mineShoppingRoutines(
  log: QuickAddLogEntry[],
  opts: { minCount?: number; minWeeks?: number } = {},
): RoutineCandidate[] {
  const minCount = opts.minCount ?? 3;
  const minWeeks = opts.minWeeks ?? 2;
  const byItem = new Map<string, { weekdays: number[]; weeks: Set<number> }>();
  for (const e of Array.isArray(log) ? log : []) {
    if (!e || e.kind !== 'shopping' || !e.text) continue;
    const key = normalizeRoutineText(e.text);
    if (key.length < 2) continue;
    const at = new Date(String(e.createdAt || ''));
    if (Number.isNaN(at.getTime())) continue;
    const slot = byItem.get(key) || { weekdays: [], weeks: new Set<number>() };
    slot.weekdays.push(at.getDay());
    slot.weeks.add(isoWeekKey(at));
    byItem.set(key, slot);
  }
  const out: RoutineCandidate[] = [];
  for (const [text, { weekdays, weeks }] of byItem) {
    if (weekdays.length < minCount || weeks.size < minWeeks) continue;
    // Modal weekday must carry a majority — otherwise it's a frequent item, not a weekday routine.
    const counts = new Array(7).fill(0);
    for (const d of weekdays) counts[d]++;
    const modal = counts.indexOf(Math.max(...counts));
    if (counts[modal] * 2 < weekdays.length) continue;
    out.push({ text, weekday: modal, count: weekdays.length, weeks: weeks.size });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * Stage confirm-tier drafts for ENABLED routines whose weekday is today. Dedupe against anything
 * already pending or already on the shopping list (same normalized text) — a routine must never
 * nag about an item the family already handled.
 */
export function buildRoutineDrafts(
  routines: Routine[] | undefined,
  today: string,                       // YYYY-MM-DD (server-local)
  pendingLedger: LedgerEntry[],
  shoppingTexts: string[],
  makeId: () => string,
  stamp: { createdAt: string; createdByUserId?: string; createdByEmail?: string },
): LedgerEntry[] {
  const list = (routines || []).filter(r => r && r.enabled && typeof r.text === 'string' && r.text.trim());
  if (!list.length) return [];
  const weekday = new Date(`${today}T12:00:00`).getDay();
  const seen = new Set<string>([
    ...shoppingTexts.map(t => normalizeRoutineText(t)),
    ...pendingLedger
      .filter(e => e.status === 'pending' && e.tool === 'add_shopping_item')
      .map(e => normalizeRoutineText(String((e.payload as { text?: string } | undefined)?.text || ''))),
  ]);
  const out: LedgerEntry[] = [];
  for (const r of list) {
    if (r.weekday !== weekday) continue;
    const key = normalizeRoutineText(r.text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(buildLedgerEntry(makeId(), 'add_shopping_item', 'confirm', 'pending', {
      summary: `Routine: you usually add "${r.text.trim()}" on ${['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][weekday]}`,
      payload: { text: r.text.trim().slice(0, 60), ...(r.store ? { store: r.store } : {}) },
      proactiveDate: today, // same-day dedupe key, exactly like the other proactive drafts
    }, stamp));
  }
  return out;
}
