import type { Authored, CopilotLogEntry, QuickAddLogEntry, LedgerEntry, RiskTier, LedgerStatus } from '../types';

// Bounds for the append-only audit/RL logs (copilotlog / quickaddlog). These are a ROLLING WINDOW
// of the most-recent entries, not a complete forever-archive: the whole array is one JSONB blob
// rewritten on every append, so we cap entry COUNT and per-entry ANSWER length to keep the blob
// (and each write) small. The RL signal is mostly prompt + suggestions + actions + model, not the
// full prose answer — hence the answer is truncated rather than stored verbatim.
export const LOG_CAP = 500;
export const MAX_LOGGED_ANSWER = 2000; // chars

// Same rolling-window cap for the concierge action ledger (data_key 'actionledger').
export const LEDGER_CAP = 500;

// Append `entry` and keep only the most-recent `cap` (newest at the end). Pure.
export function appendCapped<T>(list: T[], entry: T, cap: number): T[] {
  return [...(Array.isArray(list) ? list : []), entry].slice(-cap);
}

// Truncate a string for storage, marking that it was cut. Pure; tolerant of non-strings.
export function truncateForLog(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
}

// Build one structured copilot Q+A log entry from the /api/copilot response `data`. Stores the RAW
// (display-note-free) answer, truncated; the chosen model + fallback flag; and the returned
// suggestions/actions only when non-empty. `id` + `stamp` are passed in so this stays pure/testable.
export function buildCopilotLogEntry(
  id: string,
  prompt: string,
  data: { answer?: string; model?: string; usedFallback?: boolean; suggestions?: unknown; actions?: unknown } | null | undefined,
  stamp: Authored,
): CopilotLogEntry {
  const d = data || {};
  return {
    id,
    prompt,
    answer: truncateForLog(d.answer, MAX_LOGGED_ANSWER),
    model: d.model || undefined,
    usedFallback: !!d.usedFallback,
    suggestions: Array.isArray(d.suggestions) && d.suggestions.length ? (d.suggestions as CopilotLogEntry['suggestions']) : undefined,
    actions: Array.isArray(d.actions) && d.actions.length ? (d.actions as unknown[]) : undefined,
    ...stamp,
  };
}

// Build one concierge ledger entry. Pure (id + stamp passed in). `fields` carries the optional,
// status-dependent extras (summary/payload for an applied auto-action; before/changes for a staged
// update; sourceLogId to link back to the copilot turn). Undefined fields are omitted, not stored.
export function buildLedgerEntry(
  id: string,
  tool: string,
  riskTier: RiskTier,
  status: LedgerStatus,
  fields: { summary?: string; link?: string; refId?: string; refIds?: string[]; payload?: unknown; before?: unknown; changes?: unknown; sourceLogId?: string; proactiveDate?: string; goalId?: string } | null | undefined,
  stamp: Authored,
): LedgerEntry {
  const f = fields || {};
  const entry: LedgerEntry = { id, tool, riskTier, status, ...stamp };
  if (f.summary !== undefined) entry.summary = f.summary;
  if (f.link !== undefined) entry.link = f.link;
  if (f.refId !== undefined) entry.refId = f.refId;
  if (f.refIds !== undefined) entry.refIds = f.refIds;
  if (f.payload !== undefined) entry.payload = f.payload;
  if (f.before !== undefined) entry.before = f.before;
  if (f.changes !== undefined) entry.changes = f.changes;
  if (f.sourceLogId !== undefined) entry.sourceLogId = f.sourceLogId;
  if (f.proactiveDate !== undefined) entry.proactiveDate = f.proactiveDate;
  if (f.goalId !== undefined) entry.goalId = f.goalId;
  return entry;
}

// Build one quick-add log entry (raw text + classified kind + human-readable outcome). Pure.
export function buildQuickAddLogEntry(
  id: string,
  text: string,
  kind: string | undefined,
  summary: string,
  stamp: Authored,
): QuickAddLogEntry {
  return { id, text, kind: kind || undefined, summary, ...stamp };
}
