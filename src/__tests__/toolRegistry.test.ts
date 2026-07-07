import { describe, it, expect } from 'vitest';
import { TOOL_REGISTRY, ALLOWED_COPILOT_ACTIONS } from '../utils/toolRegistry';
import { ALLOWED_COPILOT_ACTIONS as SERVER_ALLOWED } from '../../server';
import type { FamilyMember, CalendarEvent, ShoppingItem } from '../types';

const FAM: FamilyMember[] = [
  { name: 'Aisu', role: 'Kid', color: '#fff' },
  { name: 'Leo', role: 'Kid', color: '#000' },
  { name: 'Dad', role: 'Parent', color: '#abc' },
];
const STORES: readonly ShoppingItem['store'][] = ['Costco', 'Indian Store', 'Grocery Store', 'Other'];
const ctx = { familyMembers: FAM, events: [] as CalendarEvent[], today: '2026-06-20', validStores: STORES };

// The client registry and the server allowlist MUST stay in lockstep — server.ts re-validates the
// same action types, so a drift would let one accept what the other drops.
describe('toolRegistry allowlist parity', () => {
  it('matches the server allowlist exactly', () => {
    expect(new Set(ALLOWED_COPILOT_ACTIONS)).toEqual(SERVER_ALLOWED);
  });
  it('registers exactly the known tools (home_control deferred to C2 — not registered yet)', () => {
    expect([...ALLOWED_COPILOT_ACTIONS].sort()).toEqual(
      ['add_chore', 'add_shopping_item', 'add_to_cart', 'clear_chores', 'create_event', 'delete_chore', 'delete_document', 'delete_event', 'delete_shopping_item', 'move_document', 'reserve', 'set_goal', 'set_meal_plan', 'update_chore', 'update_event'],
    );
  });
  it('doc tools: move = auto (reversible), delete = confirm (destructive)', () => {
    expect(TOOL_REGISTRY.move_document.riskTier).toBe('auto');
    expect(TOOL_REGISTRY.delete_document.riskTier).toBe('confirm');
  });
});

describe('chore / shopping delete + edit tools (confirm tier, client-resolved)', () => {
  it('all four are confirm-tier, stage-for-confirm', () => {
    for (const t of ['delete_chore', 'clear_chores', 'update_chore', 'delete_shopping_item']) {
      expect(TOOL_REGISTRY[t].riskTier).toBe('confirm');
      expect(TOOL_REGISTRY[t].applyMode).toBe('confirm');
    }
  });
  it('delete_chore shape-checks a reference (title or id), null without one', () => {
    expect(TOOL_REGISTRY.delete_chore.validate({ title: 'Make bed' }, ctx)).toEqual({ title: 'Make bed' });
    expect(TOOL_REGISTRY.delete_chore.validate({}, ctx)).toBeNull();
  });
  it('clear_chores always validates (no payload needed — the client stages every chore)', () => {
    expect(TOOL_REGISTRY.clear_chores.validate({}, ctx)).toEqual({ all: true });
  });
  it('delete_shopping_item shape-checks text or id, null without one', () => {
    expect(TOOL_REGISTRY.delete_shopping_item.validate({ text: 'milk' }, ctx)).toEqual({ text: 'milk' });
    expect(TOOL_REGISTRY.delete_shopping_item.validate({}, ctx)).toBeNull();
  });
  it('delete_event is confirm-tier and shape-checks a reference (title +/- start, or id); null without one', () => {
    expect(TOOL_REGISTRY.delete_event.riskTier).toBe('confirm');
    expect(TOOL_REGISTRY.delete_event.validate({ title: 'Zoo Day' }, ctx)).toEqual({ title: 'Zoo Day' });
    expect(TOOL_REGISTRY.delete_event.validate({ title: 'Zoo Day', start: '2026-07-05' }, ctx)).toEqual({ title: 'Zoo Day', start: '2026-07-05' });
    expect(TOOL_REGISTRY.delete_event.validate({ id: 'evt-1' }, ctx)).toEqual({ id: 'evt-1' });
    expect(TOOL_REGISTRY.delete_event.validate({ start: '2026-07-05' }, ctx)).toBeNull(); // no title/id
    expect(TOOL_REGISTRY.delete_event.validate({}, ctx)).toBeNull();
  });
  it('update_chore builds {ref, changes} of only the supplied fields; null without a ref or a change', () => {
    const u = TOOL_REGISTRY.update_chore.validate({ matchTitle: 'Make bed', points: 25, repeatType: 'weekly' }, ctx) as any;
    expect(u).toEqual({ ref: { matchTitle: 'Make bed' }, changes: { points: 25, repeatType: 'weekly' } });
    expect(TOOL_REGISTRY.update_chore.validate({ matchTitle: 'Make bed' }, ctx)).toBeNull(); // no field to change
    expect(TOOL_REGISTRY.update_chore.validate({ points: 25 }, ctx)).toBeNull();             // no target ref
  });
});

describe('set_goal tool (A6 — goals as tracked objects, auto tier, client-owned)', () => {
  it('is auto-tier auto-apply', () => {
    expect(TOOL_REGISTRY.set_goal.riskTier).toBe('auto');
    expect(TOOL_REGISTRY.set_goal.applyMode).toBe('auto');
  });
  it('builds a goal with a clamped steps plan, defaulting status to active and minting an id', () => {
    const goal = TOOL_REGISTRY.set_goal.validate({ text: 'Plan a Mount Rainier day trip', steps: [{ title: 'Pick the venue' }, 'Reserve the pass'] }, ctx) as any;
    expect(goal).toMatchObject({ text: 'Plan a Mount Rainier day trip', status: 'active' });
    expect(goal.id).toMatch(/^goal-/);
    expect(goal.steps).toEqual([{ title: 'Pick the venue', status: 'pending' }, { title: 'Reserve the pass', status: 'pending' }]);
  });
  it('reuses a supplied id (update) and returns null without goal text', () => {
    const goal = TOOL_REGISTRY.set_goal.validate({ id: 'goal-x', text: 'Updated', status: 'waiting' }, ctx) as any;
    expect(goal).toMatchObject({ id: 'goal-x', text: 'Updated', status: 'waiting' });
    expect(TOOL_REGISTRY.set_goal.validate({ steps: [{ title: 'orphan' }] }, ctx)).toBeNull();
  });
  it('carries the gathered `context` (so Continue resumes without re-asking)', () => {
    const goal = TOOL_REGISTRY.set_goal.validate({ id: 'goal-x', text: 'Rainier trip', context: 'Date: Jul 6; venue: Paradise; party 4' }, ctx) as any;
    expect(goal.context).toBe('Date: Jul 6; venue: Paradise; party 4');
  });
});

describe('set_meal_plan tool (weekly dinner planner, auto tier, client-owned)', () => {
  it('is auto-tier auto-apply', () => {
    expect(TOOL_REGISTRY.set_meal_plan.riskTier).toBe('auto');
    expect(TOOL_REGISTRY.set_meal_plan.applyMode).toBe('auto');
  });
  it('builds a sorted week, weekStart = Monday of the earliest day, clamps + drops garbage', () => {
    const plan = TOOL_REGISTRY.set_meal_plan.validate({ days: [
      { date: '2026-06-24', dish: 'Tacos', note: 'quick — soccer night' },        // Wed
      { date: '2026-06-22', dish: 'Paneer butter masala', source: 'given' },      // Mon
      { date: '2026-06-23', dish: 'X'.repeat(200), source: 'nonsense' },          // dish clamped, source dropped
      { date: '2026-09-01', dish: 'Too far out' },                                // outside today+21 → dropped
      { date: 'garbage', dish: 'Bad date' },
      { date: '2026-06-24', dish: 'Rajma', source: 'generated' },                 // dupe date — LAST wins
    ] }, ctx) as any;
    expect(plan.weekStart).toBe('2026-06-22');
    expect(plan.status).toBe('active');
    expect(plan.id).toMatch(/^meal-/);
    expect(plan.days.map((d: any) => d.date)).toEqual(['2026-06-22', '2026-06-23', '2026-06-24']);
    expect(plan.days[0]).toEqual({ date: '2026-06-22', dish: 'Paneer butter masala', source: 'given' });
    expect(plan.days[1].dish).toHaveLength(80);
    expect(plan.days[1].source).toBeUndefined();
    expect(plan.days[2]).toMatchObject({ dish: 'Rajma', source: 'generated' });
  });
  it('weekStart lands on Monday even when the earliest day is a Sunday', () => {
    const plan = TOOL_REGISTRY.set_meal_plan.validate({ days: [{ date: '2026-06-21', dish: 'Roast chicken' }] }, ctx) as any;
    expect(plan.weekStart).toBe('2026-06-15'); // 2026-06-21 is a Sunday → its week's Monday
  });
  it('plans ANY meal — lunch when asked, dinner by default, garbage → dinner (the lunches-refusal bug)', () => {
    const lunch = TOOL_REGISTRY.set_meal_plan.validate({ meal: 'lunch', days: [{ date: '2026-06-22', dish: 'Puliodharai', note: 'we have everything we need' }] }, ctx) as any;
    expect(lunch.meal).toBe('lunch');
    expect(lunch.days[0].note).toBe('we have everything we need');
    expect((TOOL_REGISTRY.set_meal_plan.validate({ days: [{ date: '2026-06-22', dish: 'Dal' }] }, ctx) as any).meal).toBe('dinner');
    expect((TOOL_REGISTRY.set_meal_plan.validate({ meal: 'brunch', days: [{ date: '2026-06-22', dish: 'Dal' }] }, ctx) as any).meal).toBe('dinner');
  });
  it('null when nothing valid survives (empty, garbage, or all out-of-window)', () => {
    expect(TOOL_REGISTRY.set_meal_plan.validate({}, ctx)).toBeNull();
    expect(TOOL_REGISTRY.set_meal_plan.validate({ days: [] }, ctx)).toBeNull();
    expect(TOOL_REGISTRY.set_meal_plan.validate({ days: [{ date: '2025-01-01', dish: 'Ancient' }] }, ctx)).toBeNull();
    expect(TOOL_REGISTRY.set_meal_plan.validate({ days: [{ date: '2026-06-24' }] }, ctx)).toBeNull(); // no dish
  });
});

describe('draft tools (B3–B4, no-payment invariant)', () => {
  it('add_to_cart is a confirm-tier draft with an Amazon link, no checkout', () => {
    expect(TOOL_REGISTRY.add_to_cart.riskTier).toBe('confirm');
    const d = TOOL_REGISTRY.add_to_cart.validate({ text: 'AA batteries', quantity: 4 }, ctx) as any;
    expect(d.summary).toContain('AA batteries');
    expect(d.link).toMatch(/^https:\/\/www\.amazon\.com\/s\?k=/);
  });
});

describe('reserve tool (confirm-tier draft, no payment)', () => {
  it('is confirm tier / confirm applyMode', () => {
    expect(TOOL_REGISTRY.reserve.riskTier).toBe('confirm');
    expect(TOOL_REGISTRY.reserve.applyMode).toBe('confirm');
  });
  it('validate builds a draft summary + a constructed (non-model) booking link', () => {
    const d = TOOL_REGISTRY.reserve.validate({ title: 'Cafe Flora', start: '2026-06-28', startTime: '19:00' }, ctx) as any;
    expect(d.summary).toContain('Cafe Flora');
    expect(d.link).toMatch(/^https:\/\/www\.google\.com\/search\?q=/);
  });
  it('validate returns null without a venue title', () => {
    expect(TOOL_REGISTRY.reserve.validate({ start: '2026-06-28' }, ctx)).toBeNull();
  });
});

describe('applyMode / riskTier per tool', () => {
  it('internal creates are auto-tier auto-apply', () => {
    for (const t of ['create_event', 'add_chore', 'add_shopping_item']) {
      expect(TOOL_REGISTRY[t].riskTier).toBe('auto');
      expect(TOOL_REGISTRY[t].applyMode).toBe('auto');
    }
  });
  it('update_event is confirm-tier, stage-for-confirm', () => {
    expect(TOOL_REGISTRY.update_event.riskTier).toBe('confirm');
    expect(TOOL_REGISTRY.update_event.applyMode).toBe('confirm');
  });
});

// validate must DELEGATE to the aiActions builders (the trust boundary), not reimplement clamping.
describe('validate delegates to aiActions builders', () => {
  it('create_event → clamped CalendarEvent (cop- id, default category)', () => {
    const ev = TOOL_REGISTRY.create_event.validate({ title: 'Zoo', start: '2026-06-21' }, ctx) as CalendarEvent;
    expect(ev).toMatchObject({ title: 'Zoo', start: '2026-06-21', category: 'Other' });
    expect(ev.id).toMatch(/^cop-/);
  });
  it('create_event → null without a title', () => {
    expect(TOOL_REGISTRY.create_event.validate({ start: '2026-06-21' }, ctx)).toBeNull();
  });

  it('add_chore → fans out multi-kid intent to every kid', () => {
    const chores = TOOL_REGISTRY.add_chore.validate({ title: 'brush teeth', assignedTo: 'both kids' }, ctx) as any[];
    expect(chores).toHaveLength(2);
    expect(chores.map(c => c.assignedTo).sort()).toEqual(['Aisu', 'Leo']);
  });
  it('add_chore → null without a title', () => {
    expect(TOOL_REGISTRY.add_chore.validate({ assignedTo: 'Leo' }, ctx)).toBeNull();
  });

  it('add_shopping_item → normalizes + clamps an invalid store to Grocery Store', () => {
    const items = TOOL_REGISTRY.add_shopping_item.validate({ text: 'milk', store: 'Nope' }, ctx) as any[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ text: 'milk', store: 'Grocery Store' });
  });
  it('add_shopping_item → accepts an items[] payload and returns null when all blank', () => {
    expect(TOOL_REGISTRY.add_shopping_item.validate({ items: [{ text: '   ' }] }, ctx)).toBeNull();
  });

  it('update_event → null when no target matches', () => {
    expect(TOOL_REGISTRY.update_event.validate({ matchTitle: 'Nope', start: '2026-06-22' }, ctx)).toBeNull();
  });
  it('update_event → change set against a matching event', () => {
    const events: CalendarEvent[] = [{ id: 'e1', title: 'Soccer', start: '2026-06-20', category: 'Sports' }];
    const u = TOOL_REGISTRY.update_event.validate({ matchTitle: 'Soccer', start: '2026-06-22' }, { ...ctx, events }) as any;
    expect(u).toMatchObject({ id: 'e1', changes: { start: '2026-06-22' } });
  });
});
