// Pure validation/build helpers for AI-produced payloads (quick-add + agentic copilot).
// These are the trust boundary for model output: they clamp/coerce every field before
// it becomes app data. Kept pure (no React/state) so they're unit-testable; the App
// handlers are thin glue that call these then the state setters.
import type { CalendarEvent, Chore, Category, FamilyMember, ShoppingItem, Goal, GoalStep, CopilotSuggestion, MealPlan, MealPlanDay } from '../types';
import { uuid } from './uuid';
import { fallbackStore } from '../constants';
import { parseLocalDate, toLocalDateStr } from './dates';

const VALID_CATEGORIES: Category[] = ['School', 'Camp', 'Sports', 'Arts', 'Holiday', 'Other'];

// Resolve an AI-suggested assignee to a real member name. Prefer a real Kid (the chore
// board only renders Kid columns), else first Kid, else first member, else 'Family'.
export function resolveAssignee(name: any, familyMembers: FamilyMember[]): string {
  const n = (name ?? '').toString();
  if (familyMembers.some(m => m.role === 'Kid' && m.name === n)) return n;
  return familyMembers.find(m => m.role === 'Kid')?.name || familyMembers[0]?.name || 'Family';
}

// Multi-kid intent: a single chore quick-add like "both kids brush teeth" should create the chore
// for EVERY kid, not just the first (the model returns a single `assignedTo` string). Resolve a
// payload assignee to the FULL list of assignees:
//   - "both" / "all" / "each" / "every(one|body)" / "kids" → every Kid on the roster
//   - a delimited list ("Leo and Mia", "Leo, Mia") that resolves to ≥2 real kids → those kids
//   - anything else → the single resolveAssignee() result (unchanged behavior)
// Falls back to a single assignee when there are no kids, so 0/1-kid households degrade sensibly.
const MULTI_KID_RE = /\b(both|all|each|every(?:one|body)?|kids)\b/i;
export function resolveAssignees(name: any, familyMembers: FamilyMember[]): string[] {
  const kidNames = familyMembers.filter(m => m.role === 'Kid').map(m => m.name);
  const n = (name ?? '').toString().trim();

  // An EXACT real-kid name wins over the multi-kid keyword heuristic — a kid literally named "All"
  // (or "Kids") must be assigned to that one kid, not fanned out to everyone.
  const exactKid = kidNames.find(k => k.toLowerCase() === n.toLowerCase());
  if (exactKid) return [exactKid];

  if (kidNames.length && MULTI_KID_RE.test(n)) return kidNames;

  // Explicit list of real kids ("Leo and Mia", "Leo, Mia & Ana").
  const parts = n.split(/\s*(?:,|&|\band\b)\s*/i).map(s => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const matched: string[] = [];
    for (const part of parts) {
      const k = kidNames.find(k => k.toLowerCase() === part.toLowerCase());
      if (k && !matched.includes(k)) matched.push(k);
    }
    // ANY real-kid match in an explicit list wins — "Leo and Grandma" must resolve to Leo, not
    // fall through to resolveAssignee("Leo and Grandma"), whose fallback is the FIRST kid.
    if (matched.length) return matched;
  }

  return [resolveAssignee(name, familyMembers)];
}

// Clamp AI member tags to the real roster (+ Family/Everyone) so prompt-injected strings
// can't leak into events (and out to Google Calendar). Falls back to ['Everyone'].
export function resolveMembers(members: any, familyMembers: FamilyMember[]): string[] {
  if (!Array.isArray(members)) return ['Everyone'];
  const allowed = new Set([...familyMembers.map(m => m.name), 'Family', 'Everyone']);
  const clean = members.map(String).filter(n => allowed.has(n));
  return clean.length ? clean : ['Everyone'];
}

// Build a validated CalendarEvent from an AI payload, or null if it lacks a title.
// Accept only a well-formed 'HH:MM' (24h) time from AI output; else undefined.
export function cleanTime(t: any): string | undefined {
  if (typeof t !== 'string') return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

export function buildEventFromPayload(
  p: any, idPrefix: string, familyMembers: FamilyMember[], todayStr: string,
): CalendarEvent | null {
  if (!p?.title) return null;
  return {
    id: `${idPrefix}-${uuid()}`,
    title: String(p.title).slice(0, 200), // cap so a misbehaving/attacked model can't store a huge title
    start: (p.start ? String(p.start) : todayStr).slice(0, 10),
    end: p.end ? String(p.end).slice(0, 10) : undefined,
    startTime: cleanTime(p.startTime),
    endTime: cleanTime(p.endTime),
    // Carry an AI-provided description (e.g. a suggestion's weather/what-to-bring note), clamped.
    description: typeof p.description === 'string' ? p.description.slice(0, 2000) : '',
    location: '',
    category: VALID_CATEGORIES.includes(p.category) ? p.category : 'Other',
    ageGroup: 'All ages',
    members: resolveMembers(p.members, familyMembers),
  };
}

// Resolve an AI `update_event` payload against the CURRENT events and build a validated partial
// change set, or null if the target can't be uniquely identified or nothing actually changes.
// The model identifies the target by `id` (when it has one) else `matchTitle` (+ `matchStart` to
// disambiguate duplicate titles). Only the fields the model supplied become `changes`, each run
// through the same clampers as create. id/sourceId are never touched. Pure → unit-testable; the
// caller stages this behind a confirm-before-apply step (it MUTATES an existing event).
export function buildEventUpdateFromPayload(
  p: any,
  events: CalendarEvent[],
  familyMembers: FamilyMember[],
): { id: string; before: CalendarEvent; changes: Partial<CalendarEvent> } | null {
  if (!p || typeof p !== 'object') return null;
  const list = Array.isArray(events) ? events : [];

  // 1) Resolve the target event.
  let target: CalendarEvent | undefined;
  if (p.id) target = list.find(e => e.id === String(p.id));
  if (!target && p.matchTitle) {
    const mt = String(p.matchTitle).trim().toLowerCase();
    let matches = list.filter(e => String(e.title).trim().toLowerCase() === mt);
    if (matches.length > 1 && p.matchStart) {
      const ms = String(p.matchStart).slice(0, 10);
      matches = matches.filter(e => e.start === ms);
    }
    if (matches.length === 1) target = matches[0];
  }
  if (!target) return null;

  // 2) Build a partial change set from ONLY the supplied fields (each clamped/coerced).
  const changes: Partial<CalendarEvent> = {};
  if (typeof p.title === 'string' && p.title.trim()) changes.title = String(p.title).slice(0, 200);
  if (typeof p.start === 'string' && p.start.trim()) changes.start = String(p.start).slice(0, 10);
  if ('end' in p) changes.end = p.end ? String(p.end).slice(0, 10) : undefined;
  if ('startTime' in p) changes.startTime = cleanTime(p.startTime);
  if ('endTime' in p) changes.endTime = cleanTime(p.endTime);
  if (typeof p.description === 'string') changes.description = String(p.description).slice(0, 2000);
  if (p.category !== undefined) changes.category = VALID_CATEGORIES.includes(p.category) ? p.category : target.category;
  if (p.members !== undefined) changes.members = resolveMembers(p.members, familyMembers);
  // Availability override (free/busy) — lets the agent mark an event free/busy WITHOUT deleting it (e.g. a
  // holiday the family wants ignored as a blocker). Only 'free'|'busy' accepted; anything else is ignored.
  if (p.freeBusy !== undefined) { const fb = String(p.freeBusy).toLowerCase(); if (fb === 'free' || fb === 'busy') changes.freeBusy = fb; }

  // Drop no-op fields (same value as the target) so the confirm card only shows real changes.
  const cleaned: Partial<CalendarEvent> = {};
  for (const [k, v] of Object.entries(changes) as [keyof CalendarEvent, any][]) {
    const cur = (target as any)[k];
    const same = k === 'members'
      ? JSON.stringify(cur || []) === JSON.stringify(v || [])
      : (cur ?? undefined) === (v ?? undefined);
    if (!same) (cleaned as any)[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return null;

  return { id: target.id, before: target, changes: cleaned };
}

// Build a validated RESERVATION DRAFT from an AI payload (capability B3). Per the no-payment
// invariant this is a DRAFT only: a summary + a booking deep-link the parent opens to book
// themselves — the agent never books or pays. The link is constructed from the venue name (never a
// model-supplied URL — anti-hallucination). Returns null without a venue title. Reused (same shape)
// for Amazon add-to-cart in B4.
// A calendar-event stub carried on a reservation/handoff draft so an APPROVED booking can land on the
// calendar (A3 last-mile). Only present when a real date is known.
export interface BookingStub { title: string; start: string; startTime?: string }

export function buildReservationDraft(p: any): { summary: string; link: string; booking?: BookingStub } | null {
  if (!p?.title) return null;
  const venue = String(p.title).replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!venue) return null;
  const startTime = cleanTime(p.startTime);
  const start = p.start && /^\d{4}-\d{2}-\d{2}/.test(String(p.start)) ? String(p.start).slice(0, 10) : '';
  const when = [start, startTime || ''].filter(Boolean).join(' ');
  const summary = `Reserve: ${venue}${when ? ` — ${when}` : ''}`.slice(0, 120);
  const link = `https://www.google.com/search?q=${encodeURIComponent(`${venue} reservation ${when}`.trim())}`;
  // Carry a booking stub only when we have a real date — drives the on-approval calendar event.
  const booking: BookingStub | undefined = start ? { title: venue, start, ...(startTime ? { startTime } : {}) } : undefined;
  return { summary, link, ...(booking ? { booking } : {}) };
}

// Parse a clock value to 24h "HH:MM", accepting BOTH 24h ("18:00") and 12h AM/PM ("6:30 PM") — handoff
// fields are FREE TEXT the agent gathered from a booking page, and US reservation pages overwhelmingly
// show 12h times, so a naive HH:MM grab would land a 6:30 PM dinner at 06:30. Returns undefined if unparseable.
function parseClockTo24h(v: string): string | undefined {
  const m = String(v || '').match(/\b(\d{1,2}):([0-5]\d)\s*([AaPp][Mm])?/);
  if (!m) return undefined;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  else if (ap === 'am' && h === 12) h = 0;
  if (h > 23) return undefined;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// Extract a booking stub from a handoff's gathered fields (label/value pairs) — find a Date field
// (YYYY-MM-DD) and an optional Time field (24h or 12h AM/PM). Scans ALL matching-labelled fields for a value
// that actually holds the pattern, so a non-date "date" field can't suppress a valid date in a later field.
// Returns null without a valid date, so a handoff with no concrete date just keeps its link. Pure → unit-tested.
export function bookingFromFields(title: string, fields?: { label?: string; value?: string }[]): BookingStub | null {
  const t = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!t || !Array.isArray(fields)) return null;
  const valuesFor = (re: RegExp) => fields.filter(f => re.test(String(f?.label || ''))).map(f => String(f?.value || ''));
  const start = valuesFor(/date/i).map(v => v.match(/\d{4}-\d{2}-\d{2}/)?.[0]).find(Boolean);
  if (!start) return null;
  const startTime = valuesFor(/time/i).map(parseClockTo24h).find(Boolean);
  return { title: t, start, ...(startTime ? { startTime } : {}) };
}

// Amazon add-to-cart DRAFT (B4) — confirm tier, NO checkout (no-payment invariant): a prefilled
// search/cart link the parent opens and checks out THEMSELVES in the Amazon app. Built from the item
// name (never a model URL). Null without an item.
export function buildCartDraft(p: any): { summary: string; link: string } | null {
  const raw = p?.text ?? p?.title;
  if (!raw) return null;
  const item = String(raw).replace(/\s+/g, ' ').trim().slice(0, 100);
  if (!item) return null;
  const qty = Number(p?.quantity);
  const q = Number.isFinite(qty) && qty > 1 ? ` ×${Math.min(99, Math.round(qty))}` : '';
  return {
    summary: `Add to Amazon cart: ${item}${q}`.slice(0, 120),
    link: `https://www.amazon.com/s?k=${encodeURIComponent(item)}`,
  };
}

// Home Assistant control DRAFT (B5) — stepup tier (physical world → confirm + PIN). Validates the
// requested action only; execution against HA is wired in C2 (behind HA_BASE_URL). Null on a bad action.
const HA_ACTIONS = ['arm', 'disarm', 'lock', 'unlock', 'thermostat'];
export function buildHaActionDraft(p: any): { summary: string; action: string } | null {
  const action = String(p?.action || '').toLowerCase().trim();
  if (!HA_ACTIONS.includes(action)) return null;
  const target = String(p?.entity ?? p?.target ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const value = p?.value !== undefined ? String(p.value).slice(0, 24) : '';
  const summary = `${action[0].toUpperCase()}${action.slice(1)}${target ? ` ${target}` : ''}${value ? ` → ${value}` : ''}`.slice(0, 120);
  return { summary, action };
}

// Build a validated Goal from an AI `set_goal` payload (agentic A6 — goals as tracked objects). The
// agent supplies a goal `text` and an optional plan (`steps[]`); we clamp lengths, default an unknown
// status to 'active', and either reuse the supplied `id` (to UPDATE an existing goal) or mint one (new
// goal). Pure → unit-testable; the App upserts the result into the goals collection. Null without text.
const GOAL_STEP_STATUS: readonly string[] = ['pending', 'active', 'done', 'blocked'];
const GOAL_STATUS: readonly string[] = ['open', 'active', 'waiting', 'done', 'abandoned'];
export function buildGoalFromPayload(p: any): Goal | null {
  if (!p || typeof p !== 'object' || !p.text || !String(p.text).trim()) return null;
  const steps: GoalStep[] = (Array.isArray(p.steps) ? p.steps : [])
    .map((s: any): GoalStep | null => {
      const rawTitle = typeof s === 'string' ? s : s?.title;
      if (!rawTitle || !String(rawTitle).trim()) return null;
      const status = (GOAL_STEP_STATUS.includes(s?.status) ? s.status : 'pending') as GoalStep['status'];
      return { title: String(rawTitle).slice(0, 200), status };
    })
    .filter((s: GoalStep | null): s is GoalStep => s !== null)
    .slice(0, 20);
  const goal: Goal = {
    id: p.id ? String(p.id) : 'goal-' + uuid(),
    text: String(p.text).slice(0, 300),
    status: (GOAL_STATUS.includes(p.status) ? p.status : 'active') as Goal['status'],
  };
  if (p.nextAction && String(p.nextAction).trim()) goal.nextAction = String(p.nextAction).slice(0, 200);
  if (steps.length) goal.steps = steps;
  if (p.category && String(p.category).trim()) goal.category = String(p.category).slice(0, 40);
  // The gathered facts (chosen date, itinerary, decisions) so Continue can resume self-sufficiently. Clamped.
  if (p.context && String(p.context).trim()) goal.context = String(p.context).slice(0, 1000);
  return goal;
}

// Build a validated MealPlan from an AI `set_meal_plan` payload (the weekly dinner planner). Same
// contract as set_goal: pure + clamped, client-applied via upsertMealPlan (replace-by-weekStart).
// Days must be REAL ISO dates inside [today−7 .. today+21] (a dinner plan is near-term by nature —
// anything else is a model hallucination); dupes collapse (last wins — an adjustment turn re-issues
// the week), output sorted. Null when nothing valid survives.
export function buildMealPlanFromPayload(p: any, todayStr: string): MealPlan | null {
  if (!p || typeof p !== 'object' || !Array.isArray(p.days)) return null;
  const today = parseLocalDate(todayStr);
  const lo = new Date(today); lo.setDate(lo.getDate() - 7);
  const hi = new Date(today); hi.setDate(hi.getDate() + 21);
  const byDate = new Map<string, MealPlanDay>();
  for (const d of p.days.slice(0, 14)) {
    const date = String(d?.date || '').slice(0, 10);
    const dish = String(d?.dish || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dish) continue;
    const t = parseLocalDate(date);
    if (Number.isNaN(t.getTime()) || toLocalDateStr(t) !== date || t < lo || t > hi) continue;
    const day: MealPlanDay = { date, dish: dish.slice(0, 80) };
    if (d?.note && String(d.note).trim()) day.note = String(d.note).trim().slice(0, 200);
    if (d?.source === 'given' || d?.source === 'generated') day.source = d.source;
    byDate.set(date, day);
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);
  if (!days.length) return null;
  // weekStart = the Monday of the earliest day (getDay(): 0=Sun → back 6; 1=Mon → back 0).
  const first = parseLocalDate(days[0].date);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
  // Which meal the plan covers — dinner unless the family said otherwise ("plan next week's LUNCHES").
  const meal = (['breakfast', 'lunch', 'dinner'] as const).find(m => m === p.meal) ?? 'dinner';
  return { id: 'meal-' + uuid(), weekStart: toLocalDateStr(first), meal, days, status: 'active' };
}

export interface MealPlanDelete { meal?: 'breakfast' | 'lunch' | 'dinner'; weekStart?: string; all?: boolean }
// Validate a delete_meal_plan payload — completes CRUD on the planner (the agent could create/update
// but not delete: "I cannot delete the entire meal plan"). Remove by meal and/or weekStart, or
// {all:true} to clear every plan. At least ONE selector is required so an empty/garbage payload can
// NEVER mean "delete everything". Pure; client-applied like set_meal_plan (auto-tier). Null if empty.
export function buildMealPlanDelete(p: any): MealPlanDelete | null {
  if (!p || typeof p !== 'object') return null;
  const out: MealPlanDelete = {};
  if (p.all === true) out.all = true;
  const meal = (['breakfast', 'lunch', 'dinner'] as const).find(m => m === p.meal);
  if (meal) out.meal = meal;
  const ws = String(p.weekStart || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(ws)) out.weekStart = ws;
  return (out.all || out.meal || out.weekStart) ? out : null;
}

// Stable key for a copilot suggestion (date + lowercased title) — used to mark which suggestions
// have already been added so the ＋Create button can flip to ✓ Added. Pure.
export function suggestionKey(s: { start?: string; title?: string }): string {
  return `${String(s?.start || '').slice(0, 10)}|${String(s?.title || '').trim().toLowerCase()}`;
}

// Build a validated tap-to-add SUGGESTION (the agent's `suggest_event` tool → a ＋Add chip in chat). Unlike
// create_event this writes nothing — the parent taps the chip to add it. Clamp every field so a misbehaving
// model can't smuggle a huge title or a non-http(s) url; falls back to today's date. Null without a title.
// Mirrors the server's sanitizeSuggestions clamps for the agent path (the local copilot has its own).
export function buildSuggestionFromPayload(p: any, todayStr: string): CopilotSuggestion | null {
  if (!p || typeof p !== 'object' || !p.title || !String(p.title).trim()) return null;
  const start = typeof p.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.start) ? p.start.slice(0, 10) : todayStr;
  const out: CopilotSuggestion = { start, title: String(p.title).slice(0, 120) };
  if (VALID_CATEGORIES.includes(p.category)) out.category = p.category;
  if (Array.isArray(p.members)) { const m = p.members.map(String).slice(0, 12); if (m.length) out.members = m; }
  if (typeof p.note === 'string' && p.note.trim()) out.note = p.note.slice(0, 300);
  if (typeof p.url === 'string' && /^https?:\/\//i.test(p.url)) out.url = p.url.slice(0, 400);
  return out;
}

// Clamp an AI-supplied number to a sane integer range, falling back when it isn't finite. Stops a
// misbehaving/attacked model from minting a billion-XP or negative/fractional chore.
function clampInt(v: any, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// Build one validated Chore from a payload for an already-resolved assignee (shared field-clamping
// for both the singular and the multi-kid builders below).
function buildChoreFor(p: any, assignedTo: string): Chore {
  return {
    id: 'chore-' + uuid(),
    title: String(p.title).slice(0, 200),
    assignedTo,
    points: clampInt(p.points, 10, 1, 1000),
    completed: false,
    completedCount: 0,
    timesPerDay: clampInt(p.timesPerDay, 1, 1, 20),
    repeatType: p.repeatType === 'weekly' ? 'weekly' : 'daily',
    scheduleTimeOfDay: p.scheduleTimeOfDay ? String(p.scheduleTimeOfDay) : undefined,
    // Latent-bug fix (chore-plan spec): every field EXCEPT notes was copied here, so AI-added chores
    // silently dropped their "how/why" guidance — the most valuable part of a generated plan.
    notes: p.notes ? String(p.notes).slice(0, 500) : undefined,
  };
}

// Build a single validated Chore from an AI payload, or null if it lacks a title.
export function buildChoreFromPayload(p: any, familyMembers: FamilyMember[]): Chore | null {
  if (!p?.title) return null;
  return buildChoreFor(p, resolveAssignee(p.assignedTo, familyMembers));
}

// Build one Chore PER resolved assignee — so "both kids brush teeth" yields a chore for every kid
// (each with its own id). Returns [] without a title. The caller dedupes against existing chores.
export function buildChoresFromPayload(p: any, familyMembers: FamilyMember[]): Chore[] {
  if (!p?.title) return [];
  return resolveAssignees(p.assignedTo, familyMembers).map(a => buildChoreFor(p, a));
}

// Shape-check a chore/shopping reference for a destructive delete (confirm tier). The MCP validate
// ctx carries events, not chores/shopping — so resolution against the live list (and miss-reporting)
// happens client-side, exactly like delete_document. The validator only confirms the model named a
// target: an id and/or a title/text. Returns the reference, or null if neither was supplied.
export function buildChoreRef(p: any): { id?: string; title?: string } | null {
  if (!p || typeof p !== 'object') return null;
  const id = p.id ? String(p.id) : undefined;
  const title = p.title ? String(p.title).trim().slice(0, 200) : undefined;
  if (!id && !title) return null;
  return { ...(id ? { id } : {}), ...(title ? { title } : {}) };
}
export function buildShoppingItemRef(p: any): { id?: string; text?: string } | null {
  if (!p || typeof p !== 'object') return null;
  const id = p.id ? String(p.id) : undefined;
  const text = p.text ? String(p.text).trim().slice(0, 200) : undefined;
  if (!id && !text) return null;
  return { ...(id ? { id } : {}), ...(text ? { text } : {}) };
}
// Shape-check an EVENT reference for a destructive delete (confirm tier) — same client-resolve pattern
// as buildChoreRef (events are client-owned, so the App resolves against the live list on approval).
// `start` (YYYY-MM-DD) disambiguates same-named events. Returns null if no title/id was named.
export function buildEventRef(p: any): { id?: string; title?: string; start?: string } | null {
  if (!p || typeof p !== 'object') return null;
  const id = p.id ? String(p.id) : undefined;
  const title = p.title ? String(p.title).trim().slice(0, 200) : undefined;
  const start = typeof p.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(p.start) ? p.start.slice(0, 10) : undefined;
  if (!id && !title) return null;
  return { ...(id ? { id } : {}), ...(title ? { title } : {}), ...(start ? { start } : {}) };
}

// Resolve which LIVE events a delete_event approval targets — pure + tested (the App calls this at approve
// time). `refId` → exactly that event. Else exact (case-insensitive) title, narrowed by `start` (YYYY-MM-DD)
// when given. `ambiguous` flags a TITLE-ONLY reference (no id, no start) that matches MORE THAN ONE event:
// recurring series are stored as N same-titled events, so the caller must NOT silently bulk-delete those on a
// single approval (the parent only ever saw one title) — it should ask for a date instead. A title+start
// match that hits several (same title, same date) is NOT ambiguous: the scope was specified, just report it.
export function resolveEventDeletion(
  events: CalendarEvent[],
  ref: { refId?: string; title?: string; start?: string },
): { victims: CalendarEvent[]; ambiguous: boolean } {
  const list = Array.isArray(events) ? events : [];
  if (ref.refId) return { victims: list.filter(e => e.id === ref.refId), ambiguous: false };
  const wantTitle = String(ref.title || '').trim().toLowerCase();
  const wantStart = String(ref.start || '').slice(0, 10);
  if (!wantTitle) return { victims: [], ambiguous: false };
  const victims = list.filter(e => String(e.title).trim().toLowerCase() === wantTitle && (!wantStart || e.start === wantStart));
  return { victims, ambiguous: !wantStart && victims.length > 1 };
}

// Build a validated chore EDIT (confirm tier): a target reference (id and/or matchTitle — mirroring
// update_event's match convention) plus a clamped partial of ONLY the editable fields the model
// supplied. Resolution against the live chores and the no-op check happen client-side. Returns null
// without a target reference or with no field to change.
export function buildChoreUpdate(p: any, familyMembers: FamilyMember[]): {
  ref: { id?: string; matchTitle?: string };
  changes: Partial<Chore>;
} | null {
  if (!p || typeof p !== 'object') return null;
  const id = p.id ? String(p.id) : undefined;
  const matchTitle = p.matchTitle ? String(p.matchTitle).trim().slice(0, 200) : undefined;
  if (!id && !matchTitle) return null;
  const changes: Partial<Chore> = {};
  if (typeof p.title === 'string' && p.title.trim()) changes.title = String(p.title).slice(0, 200);
  if (p.points !== undefined) changes.points = clampInt(p.points, 10, 1, 1000);
  if (p.timesPerDay !== undefined) changes.timesPerDay = clampInt(p.timesPerDay, 1, 1, 20);
  if (p.repeatType !== undefined) changes.repeatType = p.repeatType === 'weekly' ? 'weekly' : 'daily';
  if (p.scheduleTimeOfDay !== undefined) changes.scheduleTimeOfDay = p.scheduleTimeOfDay ? String(p.scheduleTimeOfDay) : undefined;
  if (typeof p.assignedTo === 'string' && p.assignedTo.trim()) changes.assignedTo = resolveAssignee(p.assignedTo, familyMembers);
  if (Object.keys(changes).length === 0) return null;
  return { ref: { ...(id ? { id } : {}), ...(matchTitle ? { matchTitle } : {}) }, changes };
}

// Stable identity for a chore "definition" — title + assignee + cadence + slot, lowercased. Unlike
// events (which dedupe on add), chores used to stack a duplicate every time the same quick-add ran;
// the add handler now skips a candidate whose key already exists. Merges aren't needed (a chore has
// no members array to combine), so a collision is simply skipped.
export function choreDedupeKey(c: {
  title?: string; assignedTo?: string; repeatType?: string; timesPerDay?: number; scheduleTimeOfDay?: string;
}): string {
  return [
    String(c?.title || '').trim().toLowerCase(),
    String(c?.assignedTo || '').trim().toLowerCase(),
    c?.repeatType === 'weekly' ? 'weekly' : 'daily',
    Number(c?.timesPerDay) || 1,
    String(c?.scheduleTimeOfDay || '').trim().toLowerCase(),
  ].join('|');
}

// True when `candidate` is identical (by choreDedupeKey) to a chore already in `existing`.
export function isDuplicateChore(candidate: Chore, existing: Chore[]): boolean {
  const key = choreDedupeKey(candidate);
  return (Array.isArray(existing) ? existing : []).some(c => choreDedupeKey(c) === key);
}

// Normalize AI {text, store} entries into ShoppingItems, dropping blanks and clamping
// the store to the valid set (default 'Grocery Store').
export function normalizeShoppingItems(
  items: { text?: string; store?: string }[], validStores: readonly ShoppingItem['store'][],
): ShoppingItem[] {
  return (items || [])
    .filter(i => i.text && i.text.trim())
    .map(i => ({
      id: 'shop-' + uuid(),
      text: i.text!.trim().slice(0, 200),
      completed: false,
      // Unknown/model-invented store → the household's general-grocery list when it exists, else the
      // LAST list (the "Other"-position by convention). Was hardcoded 'Grocery Store' pre-Phase-5.
      store: validStores.includes(i.store as ShoppingItem['store']) ? (i.store as string) : fallbackStore(validStores),
    }));
}
