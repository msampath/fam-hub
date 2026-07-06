// Morning planner (§7a): the model PROPOSES, this validator STAGES. These tests pin the safety
// properties — nothing the model emits can auto-apply, escape the horizon, invent a goal, or
// duplicate what's already there.
import { describe, it, expect } from 'vitest';
import { validateMorningProposals, toLedgerEntries, buildMorningFacts, MAX_PROPOSALS } from '../utils/morningAgent';
import type { Goal, LedgerEntry, ShoppingItem } from '../types';

const TODAY = '2026-07-03';
const ctx = (over: Partial<Parameters<typeof validateMorningProposals>[1]> = {}) => ({ today: TODAY, ...over });
const shopping = (kind: 'shopping', text: string, extra: Record<string, unknown> = {}) => ({ kind, text, rationale: 'because facts', ...extra });
const event = (title: string, start: string, extra: Record<string, unknown> = {}) => ({ kind: 'event', title, start, rationale: 'because facts', ...extra });

describe('validateMorningProposals (safety gate)', () => {
  it('caps output at MAX_PROPOSALS', () => {
    const raw = Array.from({ length: 10 }, (_, i) => shopping('shopping', `Item ${i}`));
    expect(validateMorningProposals(raw, ctx())).toHaveLength(MAX_PROPOSALS);
  });

  it('drops proposals with no rationale (ungrounded) and unknown kinds', () => {
    const raw = [
      { kind: 'shopping', text: 'Umbrella' },                       // no rationale
      { kind: 'buy_now', text: 'Umbrella', rationale: 'rain' },     // unknown kind
      { kind: 'shopping', text: 'Umbrella', rationale: 'rain 80% during soccer' },
    ];
    const out = validateMorningProposals(raw, ctx());
    expect(out).toHaveLength(1);
    expect(out[0].tool).toBe('add_shopping_item');
  });

  it('drops event proposals with invalid, past, or beyond-horizon dates', () => {
    const raw = [
      event('Park day', 'not-a-date'),
      event('Park day', '2026-02-30'),      // not a real calendar date
      event('Park day', '2026-07-01'),      // past
      event('Park day', '2026-09-01'),      // beyond today+14
      event('Park day', '2026-07-05'),      // valid
    ];
    const out = validateMorningProposals(raw, ctx());
    expect(out).toHaveLength(1);
    expect((out[0].payload as { booking: { start: string } }).booking.start).toBe('2026-07-05');
  });

  it('strips an unknown goalId but keeps the proposal; keeps a valid open-goal id', () => {
    const goals: Goal[] = [
      { id: 'goal-1', text: 'Plan trip', status: 'active' },
      { id: 'goal-done', text: 'Old', status: 'done' },
    ];
    const out = validateMorningProposals([
      shopping('shopping', 'Park pass', { goalId: 'goal-1' }),
      shopping('shopping', 'Sunscreen', { goalId: 'goal-INVENTED' }),
      shopping('shopping', 'Snacks', { goalId: 'goal-done' }),      // done goal = not advanceable
    ], ctx({ goals }));
    expect(out.map(p => p.goalId)).toEqual(['goal-1', undefined, undefined]);
  });

  it('dedupes against the live shopping list, pending entries, and within the batch', () => {
    const live: ShoppingItem[] = [{ id: 's1', text: 'Milk', store: 'Grocery Store', completed: false }];
    const pending: LedgerEntry[] = [
      { id: 'l1', tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending', payload: { text: 'Umbrella' } },
      { id: 'l2', tool: 'suggest_event', riskTier: 'confirm', status: 'pending', payload: { booking: { title: 'Zoo day', start: '2026-07-05' } } },
    ];
    const out = validateMorningProposals([
      shopping('shopping', 'milk'),            // on the live list (case-insensitive)
      shopping('shopping', 'Umbrella'),        // already pending
      shopping('shopping', 'Sunscreen'),
      shopping('shopping', 'sunscreen'),       // batch duplicate
      event('Zoo day', '2026-07-05'),          // already pending
      event('Zoo day', '2026-07-06'),          // different date → distinct
    ], ctx({ shopping: live, pendingLedger: pending }));
    expect(out.map(p => p.summary && p.tool)).toEqual(['add_shopping_item', 'suggest_event']);
    expect((out[0].payload as { text: string }).text).toBe('Sunscreen');
  });

  it('clamps item/title/rationale lengths and normalizes an unknown store to Other', () => {
    const out = validateMorningProposals([
      shopping('shopping', 'X'.repeat(200), { store: 'Target', rationale: 'r'.repeat(500) }),
    ], ctx());
    const payload = out[0].payload as { text: string; store: string };
    expect(payload.text).toHaveLength(60);
    expect(payload.store).toBe('Other');
    expect(out[0].summary.length).toBeLessThanOrEqual(140);
  });

  it('drops an invalid startTime but keeps the event', () => {
    const out = validateMorningProposals([event('Swim', '2026-07-05', { startTime: '5pm' })], ctx());
    expect((out[0].payload as { booking: Record<string, unknown> }).booking.startTime).toBeUndefined();
  });

  it('tolerates garbage input shapes', () => {
    expect(validateMorningProposals(null, ctx())).toEqual([]);
    expect(validateMorningProposals('nonsense', ctx())).toEqual([]);
    expect(validateMorningProposals([null, 42, 'x', {}], ctx())).toEqual([]);
  });

  // Phase-3 facts cross-check: a rationale must cite something that EXISTS in the FACTS the model saw.
  describe('factsText cross-check (briefing-compose treatment)', () => {
    const FACTS = 'TODAY: 2026-07-03\n\nAGENDA:\n- Soccer practice 16:00 (Max)\nWEATHER: Rain 80% this afternoon.\nCHORES STILL OPEN TODAY:\n- Feed the dog (Ava)';

    it('keeps proposals whose rationale cites the facts; drops invented ones', () => {
      const out = validateMorningProposals([
        shopping('shopping', 'Umbrella', { rationale: 'Rain 80% during soccer practice' }),
        shopping('shopping', 'Gift wrap', { rationale: "Leo's birthday on Friday" }),   // no Leo, no birthday in FACTS
        event('Trampoline park', '2026-07-05', { rationale: 'Indoor pick for the rain forecast' }),
      ], ctx({ factsText: FACTS }));
      expect(out.map(p => p.summary)).toEqual([
        'Rain 80% during soccer practice',
        'Indoor pick for the rain forecast',
      ]);
    });

    it('without factsText the gate is off (backwards-compatible)', () => {
      const out = validateMorningProposals([
        shopping('shopping', 'Gift wrap', { rationale: "Leo's birthday on Friday" }),
      ], ctx());
      expect(out).toHaveLength(1);
    });
  });
});

describe('toLedgerEntries (staging shape)', () => {
  it('every staged entry is confirm-tier + pending — structurally, nothing can auto-apply', () => {
    const proposals = validateMorningProposals([
      shopping('shopping', 'Sunscreen'),
      event('Park day', '2026-07-05', { goalId: 'goal-1' }),
    ], ctx({ goals: [{ id: 'goal-1', text: 'Trip', status: 'active' } as Goal] }));
    let n = 0;
    const entries = toLedgerEntries(proposals, TODAY, () => `id-${n++}`, { createdAt: 'now', createdByUserId: 'concierge' });
    expect(entries).toHaveLength(2);
    for (const e of entries) {
      expect(e.riskTier).toBe('confirm');
      expect(e.status).toBe('pending');
      expect(e.proactiveDate).toBe(TODAY); // keys the same-day digest dedupe
    }
    expect(entries[0].goalId).toBeUndefined();
    expect(entries[1].goalId).toBe('goal-1'); // approval advances the goal (advanceGoalOnApproval)
  });
});

describe('buildMorningFacts', () => {
  it('includes agenda, open goals with ids, pending summaries, and the shopping list', () => {
    const facts = buildMorningFacts({
      today: TODAY,
      agendaText: 'Soccer at 4pm',
      weatherLine: 'Rain 80%',
      chores: [{ id: 'c1', title: 'Feed dog', assignedTo: 'Max', points: 5, completed: false, completedCount: 0, timesPerDay: 1 } as never],
      shopping: [{ id: 's1', text: 'Milk', store: 'Grocery Store', completed: false } as ShoppingItem],
      goals: [{ id: 'goal-1', text: 'Plan trip', status: 'active', nextAction: 'Book pass' } as Goal],
      pendingLedger: [{ id: 'l1', tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending', summary: 'Umbrella for rain' } as LedgerEntry],
    });
    expect(facts).toContain('TODAY: 2026-07-03');
    expect(facts).toContain('Soccer at 4pm');
    expect(facts).toContain('Rain 80%');
    expect(facts).toContain('Feed dog (Max)');
    expect(facts).toContain('- Milk');
    expect(facts).toContain('id=goal-1 "Plan trip" (active) — next: Book pass');
    expect(facts).toContain('Umbrella for rain');
  });

  it('marks an empty shopping list explicitly (so the model does not invent one)', () => {
    const facts = buildMorningFacts({ today: TODAY, agendaText: '' });
    expect(facts).toContain('(empty)');
    expect(facts).toContain('(nothing scheduled)');
  });
});
