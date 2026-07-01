// Proactive morning agent (Pattern #1): the daily scheduler doesn't just EMAIL the briefing — it pre-stages
// approvable DRAFTS into the household's Approvals queue so they're waiting when the parent opens the app
// ("rain during soccer — I staged an umbrella; approve?"). PURE builder → unit-tested; the server wires it
// into runDailyDigest. No-payment invariant holds: every entry is a confirm-tier add_shopping_item DRAFT.
import type { CalendarEvent, LedgerEntry, Authored, Goal } from '../types';
import type { Briefing } from './briefing';
import { buildLedgerEntry } from './historyLog';

// Today's events that read as OUTDOOR (so a rainy forecast is worth a heads-up). Title keyword match.
const OUTDOOR_RE = /\b(soccer|baseball|football|practice|game|match|park|playground|picnic|hike|hiking|trail|field|outdoor|camping|beach|garden|bbq|barbecue|run|walk)\b/i;
const RAIN_PROB_THRESHOLD = 60; // precipitation_probability_max (%) at/above which we suggest an umbrella

export interface WeatherDaily { time?: string[]; precipitation_probability_max?: number[]; weather_code?: number[] }

const norm = (s: string) => String(s || '').toLowerCase().trim();

// Build the pending shopping-draft ledger entries for today. `existing` (the household's current ledger)
// de-dupes across days — a gift draft already pending isn't re-staged each morning.
export function buildProactiveLedger(
  briefing: Briefing,
  weather: WeatherDaily | null,
  events: CalendarEvent[],
  today: string,
  mkId: () => string,
  stamp: Authored,
  existing: LedgerEntry[] = [],
): LedgerEntry[] {
  const pendingTexts = new Set(
    (Array.isArray(existing) ? existing : [])
      .filter(e => e.status === 'pending' && e.tool === 'add_shopping_item' && e.payload && typeof (e.payload as any).text === 'string')
      .map(e => norm((e.payload as any).text)),
  );
  const out: LedgerEntry[] = [];
  const staged = new Set<string>();
  const add = (summary: string, text: string, store: string) => {
    const key = norm(text);
    if (!key || pendingTexts.has(key) || staged.has(key)) return; // don't re-stage an item already waiting
    staged.add(key);
    out.push(buildLedgerEntry(mkId(), 'add_shopping_item', 'confirm', 'pending', { summary, payload: { text, store }, proactiveDate: today }, stamp));
  };

  // 1) Calendar nudges that carry a 1-tap shopping listItem (gift, school supplies).
  for (const n of briefing?.nudges || []) {
    if (n.listItem) add(n.text, n.listItem, 'Other');
  }

  // 2) Rain likely during a today OUTDOOR event → stage an umbrella.
  const idx = (weather?.time || []).indexOf(today);
  const rainProb = idx >= 0 ? Number(weather?.precipitation_probability_max?.[idx]) : NaN;
  if (Number.isFinite(rainProb) && rainProb >= RAIN_PROB_THRESHOLD) {
    const outdoor = (Array.isArray(events) ? events : []).find(e => (e.start || '').slice(0, 10) === today && OUTDOOR_RE.test(e.title || ''));
    if (outdoor) add(`🌧️ Rain likely (${Math.round(rainProb)}%) during "${outdoor.title}" today — pack an umbrella?`, 'Umbrella', 'Other');
  }

  return out;
}

// Cross-day goal nudges for the morning digest (the agentic goal loop's scheduler half): a one-line
// reminder per IN-PROGRESS goal so a multi-day goal doesn't stall silently. A goal waiting on an approval
// already has its real blocking entry in Approvals — so this is an EMAIL nudge, not a fabricated approvable
// row. Pure → unit-tested. Returns [] when no goal is open.
export function buildGoalNudges(goals: Goal[]): string[] {
  const out: string[] = [];
  for (const g of Array.isArray(goals) ? goals : []) {
    if (g.status === 'done' || g.status === 'abandoned') continue;
    const steps = g.steps || [];
    if (steps.some(s => s.status === 'blocked')) out.push(`🎯 "${g.text}" — waiting on your approval in the app.`);
    else if (g.nextAction) out.push(`🎯 "${g.text}" — next: ${g.nextAction}.`);
    else {
      const remaining = steps.filter(s => s.status !== 'done').length;
      out.push(remaining ? `🎯 "${g.text}" — ${remaining} step${remaining > 1 ? 's' : ''} left.` : `🎯 "${g.text}" — in progress.`);
    }
  }
  return out.slice(0, 5); // keep the email tidy
}
