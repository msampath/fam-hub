import { describe, it, expect } from 'vitest';
import { buildDemoSeed } from '../utils/demoSeed';

const TODAY = '2026-06-21';

describe('buildDemoSeed', () => {
  const seed = buildDemoSeed(TODAY, 'anon-123');

  it('seeds the expected collections', () => {
    expect(Object.keys(seed).sort()).toEqual(['bills', 'chores', 'documents', 'events', 'members', 'settings', 'shopping']);
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
