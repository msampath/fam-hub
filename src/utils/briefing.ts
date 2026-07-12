// Morning-Briefing assembly (pure, unit-tested). The on-demand preview (and the future scheduled email)
// both build on this: today's agenda + calendar-driven nudges. Every nudge is a DRAFT/suggestion the
// parent acts on — NEVER a purchase (the no-payment invariant holds for the proactive agent too).
import type { CalendarEvent, Chore } from '../types';
import { buildDailyReminder } from './reminders';
import { parseLocalDate, addOneDayUTC } from './dates';

export interface BriefingNudge {
  kind: 'birthday' | 'anniversary' | 'trip' | 'supplies';
  text: string;        // the human-facing line
  date: string;        // YYYY-MM-DD of the triggering event
  listItem?: string;   // optional 1-tap "add to shopping list" DRAFT (never a checkout)
}

export interface Briefing {
  title: string;
  lines: string[];     // today's events + due chores (from buildDailyReminder)
  nudges: BriefingNudge[];
  agentSummary?: string; // optional ADK-concierge-authored narrative (set by /api/morning-briefing); the
                         // deterministic title/lines/nudges stay so the 1-tap nudge actions still work
}

// Friendly short date, e.g. "Tue Jun 30". Parsed as LOCAL so the weekday doesn't drift a day.
function friendlyDate(dateStr: string): string {
  const d = parseLocalDate(dateStr);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

const PATTERNS: { re: RegExp; build: (title: string, when: string) => BriefingNudge }[] = [
  { re: /\b(birthday|bday)\b/i, build: (t, w) => ({ kind: 'birthday', date: w, text: `🎁 ${t} on ${friendlyDate(w)} — add a gift to your list?`, listItem: `Gift for ${t.replace(/'s? birthday.*/i, '').trim() || t}` }) },
  { re: /\banniversary\b/i, build: (t, w) => ({ kind: 'anniversary', date: w, text: `💐 ${t} on ${friendlyDate(w)} — plan a card or something special?` }) },
  { re: /\b(trip|vacation|flight|travel|holiday)\b/i, build: (t, w) => ({ kind: 'trip', date: w, text: `🧳 ${t} on ${friendlyDate(w)} — time to pack and arrange pet/house care?` }) },
  { re: /\b(school supplies|supplies|supply list)\b/i, build: (t, w) => ({ kind: 'supplies', date: w, text: `🎒 ${t} on ${friendlyDate(w)} — stock up on supplies?`, listItem: 'School supplies' }) },
];

// Derive nudges from upcoming events within [today, today+horizonDays]. One nudge per matching event.
export function buildCalendarNudges(events: CalendarEvent[], today: string, horizonDays = 14): BriefingNudge[] {
  let end = today;
  for (let i = 0; i < horizonDays; i++) end = addOneDayUTC(end);
  const nudges: BriefingNudge[] = [];
  for (const e of events) {
    const date = (e.start || '').slice(0, 10);
    if (!date || date < today || date > end) continue;
    const title = (e.title || '').trim();
    if (!title) continue;
    for (const p of PATTERNS) {
      if (p.re.test(title)) { nudges.push(p.build(title, date)); break; }
    }
  }
  return nudges.sort((a, b) => a.date.localeCompare(b.date));
}

// Meal lines from the meal-plan collection (owner decision: meals live in the briefing + the Today
// strip, never as calendar events). Picks the NEWEST week's plans — one plan per meal (breakfast /
// lunch / dinner coexist) — and emits today + tomorrow lines per meal, chronological. Pure.
const MEAL_LINE_ORDER = ['breakfast', 'lunch', 'dinner'] as const;
const MEAL_LABEL: Record<string, [string, string]> = {
  breakfast: ['Breakfast today', 'Breakfast tomorrow'],
  lunch: ['Lunch today', 'Lunch tomorrow'],
  dinner: ['Dinner tonight', 'Tomorrow'],
};
export function buildDinnerLines(mealPlans: { weekStart?: string; meal?: string; days?: { date: string; dish: string }[] }[] | undefined, today: string): string[] {
  const all = (Array.isArray(mealPlans) ? mealPlans : []).filter(p => Array.isArray(p?.days));
  // Prefer the plan(s) that actually cover TODAY — picking purely by the latest weekStart silently
  // dropped THIS week's plan whenever a LATER week was also planned (mirrors copilotHarness.ts's fix).
  const current = all.filter(p => p.days!.some(d => d?.date === today));
  const sorted = (current.length ? current : all)
    .sort((a, b) => String(b.weekStart || '').localeCompare(String(a.weekStart || '')));
  const week = sorted[0]?.weekStart;
  const plans = sorted.filter(p => p.weekStart === week);
  const tomorrow = addOneDayUTC(today);
  const out: string[] = [];
  for (const meal of MEAL_LINE_ORDER) {
    const plan = plans.find(p => (p.meal || 'dinner') === meal);
    if (!plan) continue;
    const dishFor = (d: string) => plan.days!.find(x => x?.date === d && x?.dish)?.dish;
    const [todayLabel, tomorrowLabel] = MEAL_LABEL[meal];
    const now = dishFor(today);
    const next = dishFor(tomorrow);
    if (now) out.push(`🍽 ${todayLabel}: ${now}`);
    if (next) out.push(`🍽 ${tomorrowLabel}: ${next}`);
  }
  return out;
}

// The full on-demand briefing: today's agenda (events + due chores) + calendar-driven nudges
// (+ the meal lines when the newest week's plans cover today/tomorrow).
export function buildBriefing(events: CalendarEvent[], chores: Chore[], today: string, horizonDays = 14,
  mealPlans?: { weekStart?: string; meal?: string; days?: { date: string; dish: string }[] }[]): Briefing {
  const daily = buildDailyReminder(events, chores, today);
  return {
    title: daily?.title ?? 'Today: nothing scheduled',
    lines: [...(daily ? daily.body.split('\n') : []), ...buildDinnerLines(mealPlans, today)],
    nudges: buildCalendarNudges(events, today, horizonDays),
  };
}
