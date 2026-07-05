import { describe, it, expect } from 'vitest';
import { buildDemoSeed } from '../utils/demoSeed';

const TODAY = '2026-06-21';

describe('buildDemoSeed', () => {
  const seed = buildDemoSeed(TODAY, 'anon-123');

  it('seeds the expected collections', () => {
    expect(Object.keys(seed).sort()).toEqual(['actionledger', 'bills', 'chores', 'documents', 'events', 'goals', 'members', 'settings', 'shopping']);
  });

  it('seeds exactly ONE pending confirm-tier approval so the Approvals queue is visible on arrival', () => {
    expect(seed.actionledger).toHaveLength(1);
    const e: any = seed.actionledger[0];
    // suggest_event = an APPROVAL (agent executes on OK), not a USER_COMPLETES handoff (Actions).
    expect(e).toMatchObject({ tool: 'suggest_event', riskTier: 'confirm', status: 'pending' });
    expect(e.summary).toBeTruthy();
    // Approving rides the generic booking-payload apply path — the payload must carry a valid booking.
    expect((e.payload as any).booking.title).toBeTruthy();
    expect((e.payload as any).booking.start >= TODAY).toBe(true);
    // NOT a morning-planner draft: proactiveDate keys the digest's same-day dedupe and must stay unset.
    expect(e.proactiveDate).toBeUndefined();
    // Distinct from planner-proposable items (Grandma's birthday / Discover Pass) → no dedupe collision
    // when the judge taps the briefing's "Stage drafts".
    expect(/birthday|discover pass/i.test((e.payload as any).booking.title)).toBe(false);
  });

  it('seeds an in-progress goal (GoalsStrip lands populated; the morning planner can advance it)', () => {
    expect(seed.goals).toHaveLength(1);
    const g: any = seed.goals[0];
    expect(g.status).toBe('active');
    expect(g.nextAction).toBeTruthy();
    expect(g.steps.some((s: any) => s.status === 'active')).toBe(true);
  });

  it("seeds a birthday event inside the nudge horizon (briefing demo beat lands populated)", () => {
    expect(seed.events.some((e: any) => /birthday/i.test(e.title))).toBe(true);
  });

  it('seeds bills (parsed fields only) so the bills_agent has data in the demo', () => {
    expect(seed.bills.length).toBeGreaterThan(0);
    expect(seed.bills.every((b: any) => b.id && b.payee && b.dueDate)).toBe(true);
  });

  it('seeds a newsletter doc so local-knowledge grounding has corpus in the demo', () => {
    expect(seed.documents.length).toBeGreaterThan(0);
    expect(seed.documents.every((d: any) => d.id && d.name && d.text && d.folder)).toBe(true);
  });

  it('links the "You" parent to the anonymous visitor and adds two kids', () => {
    const you = seed.members.find((m: any) => m.name === 'You');
    expect(you).toMatchObject({ role: 'Parent', userId: 'anon-123' });
    expect(you.color).toBeTruthy();
    const kids = seed.members.filter((m: any) => m.role === 'Kid').map((m: any) => m.name).sort();
    expect(kids).toEqual(['Ava', 'Max']);
  });

  it('dates every event today-or-later and tags real members', () => {
    for (const e of seed.events) {
      expect(e.start >= TODAY).toBe(true);
      expect(e.id).toBeTruthy();
      expect(Array.isArray(e.members) && e.members.length).toBeTruthy();
    }
  });

  it('assigns chores to the seeded kids', () => {
    const assignees = new Set(seed.chores.map((c: any) => c.assignedTo));
    expect([...assignees].every(a => ['Ava', 'Max'].includes(a as string))).toBe(true);
    expect(seed.chores.every((c: any) => c.id && c.repeatType && c.timesPerDay >= 1)).toBe(true);
  });

  it('seeds shopping items with valid stores', () => {
    const stores = new Set(['Costco', 'Indian Store', 'Grocery Store', 'Other']);
    expect(seed.shopping.length).toBeGreaterThan(0);
    expect(seed.shopping.every((s: any) => s.id && s.text && stores.has(s.store))).toBe(true);
  });

  it('seeds a home location so the grounded copilot works (mandatory-location gate satisfied)', () => {
    expect(seed.settings).toHaveLength(1);
    const s = seed.settings[0];
    expect(Number.isFinite(s.homeLat) && Number.isFinite(s.homeLng)).toBe(true);
    expect(s.homeLabel).toBeTruthy();
  });

  it('generates unique ids across all seeded records', () => {
    const ids = [...seed.events, ...seed.chores, ...seed.shopping].map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
