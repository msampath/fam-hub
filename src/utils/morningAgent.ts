// Proactive MORNING PLANNER (completes the capstone §7a flagship): each morning, ONE grounded model
// call per opted-in household reads the day's verified FACTS (agenda, weather, chores, shopping,
// open goals, what's already pending) and proposes up to MAX_PROPOSALS concrete next actions — a
// shopping item, an event suggestion, or the next step of a tracked goal (a proposal carrying that
// goal's id). DETERMINISTIC code then validates every proposal and stages it as a CONFIRM-tier
// pending LedgerEntry. The model proposes; the code stages; the parent approves in the app —
// structurally, nothing produced here can auto-apply. This replaces nothing: the deterministic
// nudges (buildProactiveLedger) still run and this plans ALONGSIDE them, falling back to them alone
// whenever the model is unreachable.
// KAGGLE_EVAL: Agent (proactive closed-app planning) + Security (server-authoritative confirm-tier
// staging — see validateMorningProposals: tier/status are hardcoded, never model-supplied).
import { Type } from '@google/genai';
import { SHOP_STORES } from '../constants';
import type { Authored, Chore, Goal, LedgerEntry, ShoppingItem } from '../types';
import { buildLedgerEntry } from './historyLog';
import { addDaysISO } from './copilotHarness';

export const MAX_PROPOSALS = 3;
const MAX_RATIONALE = 140;
const HORIZON_DAYS = 14; // proposals may only target [today, today+14] — same window as the nudges

// Anti-runaway output cap (the SCAN_GENCONFIG lesson: a flash repetition loop must truncate cheaply,
// not burn 8k tokens across the fallback chain on a money path that runs for every household daily).
export const MORNING_GENCONFIG = { maxOutputTokens: 1024, temperature: 0.4 };

export const MORNING_PLANNER_SYSTEM = `You are the family's morning planner. From the FACTS provided (today's agenda, weather, chores, shopping list, tracked goals, and drafts already pending), propose 0-${MAX_PROPOSALS} concrete, immediately useful next actions for the parent to approve. Rules:
- Respond with ONLY the JSON object. Propose NOTHING when nothing is genuinely useful — an empty list is a good answer.
- Each proposal is ONE of:
  - kind "shopping": something specific to buy soon, grounded in a FACT (an upcoming event needs supplies, rain needs an umbrella, a staple is missing). Set "text" (the item) and optionally "store".
  - kind "event": a specific, dated activity worth putting on the calendar (a free slot + good weather, a goal's planned outing). Set "title", "start" (YYYY-MM-DD, today or later, within ${HORIZON_DAYS} days), optionally "startTime" (HH:MM).
- TRACKED GOALS: if an open goal's next step can be advanced by a shopping item or event proposal, make that proposal and set "goalId" to that goal's exact id. Never invent a goalId.
- Every proposal needs a short "rationale" naming the FACT it serves ("Rain 80% during soccer today", "Leo's birthday Friday").
- Do NOT repeat anything already on the shopping list or already pending approval. Do NOT propose payments, bookings, or purchases — only list items and calendar suggestions.`;

// @google/genai Type.* form (the Gemini SDK's schema dialect — same pattern as COPILOT_SCHEMA).
export const MORNING_PLANNER_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    proposals: {
      type: Type.ARRAY,
      description: `0-${MAX_PROPOSALS} concrete next actions grounded in the FACTS.`,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: ['shopping', 'event'], description: 'What to stage: a shopping-list item or a calendar suggestion.' },
          text: { type: Type.STRING, description: 'kind "shopping": the item to buy (short).' },
          store: { type: Type.STRING, enum: [...SHOP_STORES], description: 'kind "shopping": which store list (optional; defaults to Other).' },
          title: { type: Type.STRING, description: 'kind "event": the activity title (short).' },
          start: { type: Type.STRING, description: 'kind "event": YYYY-MM-DD, today or later.' },
          startTime: { type: Type.STRING, description: 'kind "event": optional HH:MM start time.' },
          rationale: { type: Type.STRING, description: 'The FACT this serves, one short sentence.' },
          goalId: { type: Type.STRING, description: 'EXACT id of the open goal this advances (only when it truly does).' },
        },
        required: ['kind', 'rationale'],
      },
    },
  },
  required: ['proposals'],
};

// Compact, bounded FACTS block — the planner reasons ONLY over these (never told to fetch anything).
export function buildMorningFacts(input: {
  today: string;
  agendaText: string;            // briefingToText output (today's events + due chores + nudges)
  weatherLine?: string | null;
  chores?: Chore[];
  shopping?: ShoppingItem[];
  goals?: Goal[];
  pendingLedger?: LedgerEntry[];
}): string {
  const lines: string[] = [`TODAY: ${input.today}`, '', 'AGENDA:', input.agendaText.trim() || '(nothing scheduled)'];
  if (input.weatherLine) lines.push('', `WEATHER: ${input.weatherLine}`);
  const chores = (input.chores || []).filter(c => (c.completedCount ?? 0) < (c.timesPerDay || 1)).slice(0, 12);
  if (chores.length) lines.push('', 'CHORES STILL OPEN TODAY:', ...chores.map(c => `- ${c.title} (${c.assignedTo})`));
  const shopping = (input.shopping || []).filter(s => !s.completed).slice(0, 20);
  lines.push('', 'SHOPPING LIST (already on it — do not repeat):', shopping.length ? shopping.map(s => `- ${s.text}`).join('\n') : '(empty)');
  const goals = (input.goals || []).filter(g => g.status === 'open' || g.status === 'active' || g.status === 'waiting').slice(0, 6);
  if (goals.length) {
    lines.push('', 'TRACKED GOALS (advance one via a proposal carrying its goalId):');
    for (const g of goals) {
      const next = g.nextAction || (g.steps || []).find(s => s.status !== 'done')?.title || '';
      lines.push(`- id=${g.id} "${g.text}" (${g.status})${next ? ` — next: ${next}` : ''}`);
    }
  }
  const pending = (input.pendingLedger || []).filter(e => e.status === 'pending').slice(0, 10);
  if (pending.length) lines.push('', 'ALREADY PENDING APPROVAL (do not repeat):', ...pending.map(e => `- ${e.summary || e.tool}`));
  return lines.join('\n');
}

// A validated proposal, staged-shape: exactly the two tools whose approval paths already exist
// client-side (add_shopping_item appends to the list; suggest_event's booking payload becomes a
// calendar event) — so staging these requires ZERO new apply code. goalId (when valid) rides along
// and advanceGoalOnApproval picks it up — the scheduled goal re-check loop.
export interface StagedProposal {
  tool: 'add_shopping_item' | 'suggest_event';
  summary: string;
  payload: unknown;
  goalId?: string;
}

const norm = (s: unknown) => String(s || '').toLowerCase().trim();
const isISODate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// Validate + clamp the model's raw proposals into stageable shapes. Pure and paranoid: unknown kinds
// drop, dates outside [today, today+14] drop, unknown goalIds are STRIPPED (the proposal survives),
// duplicates (vs the live list, pending entries, and within the batch) drop, everything is length-
// clamped. The output NEVER carries a tier or status — callers stage confirm/pending, hardcoded.
export function validateMorningProposals(
  raw: unknown,
  ctx: {
    today: string;
    shopping?: ShoppingItem[];       // live list (don't re-propose what's already on it)
    pendingLedger?: LedgerEntry[];   // pending entries (don't re-stage what's already waiting)
    goals?: Goal[];                  // open goals (goalId allowlist)
  },
): StagedProposal[] {
  const list = Array.isArray(raw) ? raw : [];
  const maxDate = addDaysISO(ctx.today, HORIZON_DAYS);
  const openGoalIds = new Set(
    (ctx.goals || []).filter(g => g.status === 'open' || g.status === 'active' || g.status === 'waiting').map(g => g.id),
  );
  const pending = (ctx.pendingLedger || []).filter(e => e.status === 'pending');
  const seenShopping = new Set<string>([
    ...(ctx.shopping || []).filter(s => !s.completed).map(s => norm(s.text)),
    ...pending.filter(e => e.tool === 'add_shopping_item').map(e => norm((e.payload as { text?: string } | undefined)?.text)),
  ]);
  const seenEvents = new Set<string>(
    pending.filter(e => e.tool === 'suggest_event')
      .map(e => { const b = (e.payload as { booking?: { title?: string; start?: string } } | undefined)?.booking; return norm(`${b?.title}|${b?.start}`); }),
  );

  const out: StagedProposal[] = [];
  for (const p of list) {
    if (out.length >= MAX_PROPOSALS) break;
    if (!p || typeof p !== 'object') continue;
    const prop = p as Record<string, unknown>;
    const rationale = String(prop.rationale || '').trim().slice(0, MAX_RATIONALE);
    if (!rationale) continue; // ungrounded proposals don't stage
    const goalId = typeof prop.goalId === 'string' && openGoalIds.has(prop.goalId) ? prop.goalId : undefined;

    if (prop.kind === 'shopping') {
      const text = String(prop.text || '').trim().slice(0, 60);
      if (!text || seenShopping.has(norm(text))) continue;
      seenShopping.add(norm(text));
      const store = SHOP_STORES.includes(prop.store as (typeof SHOP_STORES)[number]) ? (prop.store as string) : 'Other';
      out.push({ tool: 'add_shopping_item', summary: rationale, payload: { text, store }, goalId });
    } else if (prop.kind === 'event') {
      const title = String(prop.title || '').trim().slice(0, 80);
      const start = String(prop.start || '').trim();
      if (!title || !isISODate(start) || start < ctx.today || start > maxDate) continue;
      const key = norm(`${title}|${start}`);
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      const startTime = /^\d{2}:\d{2}$/.test(String(prop.startTime || '')) ? String(prop.startTime) : undefined;
      out.push({ tool: 'suggest_event', summary: rationale, payload: { booking: { title, start, ...(startTime ? { startTime } : {}) } }, goalId });
    }
    // unknown kind → dropped
  }
  return out;
}

// Wrap validated proposals as CONFIRM-tier pending ledger entries (the digest path). proactiveDate
// keys the same-day dedupe, exactly like buildProactiveLedger's entries.
export function toLedgerEntries(
  proposals: StagedProposal[],
  today: string,
  mkId: () => string,
  stamp: Authored,
): LedgerEntry[] {
  return proposals.map(p =>
    buildLedgerEntry(mkId(), p.tool, 'confirm', 'pending', {
      summary: p.summary,
      payload: p.payload,
      proactiveDate: today,
      goalId: p.goalId,
    }, stamp));
}
