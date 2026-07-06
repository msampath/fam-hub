// AI starter chore plan — the pure half (docs/ai-chore-plan-generator.md): server-side sanitization of
// the model's raw plan, and the per-kid preview grouping.
import { describe, it, expect } from 'vitest';
import { sanitizeGeneratedChores, groupGeneratedByKid, CHORE_PLAN_STYLE_EXEMPLAR } from '../utils/chorePlan';
import type { FamilyMember } from '../types';

const KIDS = ['Ava', 'Max'];

describe('sanitizeGeneratedChores', () => {
  it('keeps well-formed rows and normalizes their fields', () => {
    const out = sanitizeGeneratedChores([
      { title: 'Make bed', assignedTo: 'Ava', points: 10, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Morning', notes: 'Flat blanket.' },
    ], KIDS);
    expect(out).toEqual([
      { title: 'Make bed', assignedTo: 'Ava', points: 10, timesPerDay: 1, repeatType: 'daily', scheduleTimeOfDay: 'Morning', notes: 'Flat blanket.' },
    ]);
  });

  it('tolerates the { chores: [...] } wrapper a drifting model emits', () => {
    const out = sanitizeGeneratedChores({ chores: [{ title: 'Read', assignedTo: 'Max' }] }, KIDS);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Read');
  });

  it('drops titleless rows and rows assigned to anyone who is not a real kid (placeholder/injection)', () => {
    const out = sanitizeGeneratedChores([
      { title: '', assignedTo: 'Ava' },
      { title: 'Sweep', assignedTo: 'Child_8' },   // exemplar placeholder must never reach the board
      { title: 'Hack', assignedTo: 'Everyone' },
      { title: 'Real', assignedTo: 'ava' },        // case-insensitive resolve → canonical roster name
    ], KIDS);
    expect(out).toEqual([expect.objectContaining({ title: 'Real', assignedTo: 'Ava' })]);
  });

  it('clamps points to 5–20, timesPerDay to 1–3, notes to 500 chars, and coerces repeatType/slot', () => {
    const [c] = sanitizeGeneratedChores([{
      title: 'Big job', assignedTo: 'Ava', points: 900, timesPerDay: 9,
      repeatType: 'hourly', scheduleTimeOfDay: 'midnight', notes: 'y'.repeat(600),
    }], KIDS);
    expect(c.points).toBe(20);
    expect(c.timesPerDay).toBe(3);
    expect(c.repeatType).toBe('daily');            // unknown cadence → daily
    expect(c.scheduleTimeOfDay).toBeUndefined();   // unknown slot → omitted (renders as Anytime)
    expect(c.notes).toHaveLength(500);
    const [low] = sanitizeGeneratedChores([{ title: 'Tiny', assignedTo: 'Ava', points: 1, timesPerDay: 0 }], KIDS);
    expect(low.points).toBe(5);
    expect(low.timesPerDay).toBe(1);
  });

  it('caps the batch at max and returns [] for garbage', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ title: `Chore ${i}`, assignedTo: 'Ava' }));
    expect(sanitizeGeneratedChores(many, KIDS, 40)).toHaveLength(40);
    expect(sanitizeGeneratedChores(null, KIDS)).toEqual([]);
    expect(sanitizeGeneratedChores('nonsense', KIDS)).toEqual([]);
    expect(sanitizeGeneratedChores({ foo: 1 }, KIDS)).toEqual([]);
  });
});

describe('groupGeneratedByKid', () => {
  const fam: FamilyMember[] = [
    { name: 'Mom', role: 'Parent', color: 'indigo' },
    { name: 'Ava', role: 'Kid', color: 'sky' },
    { name: 'Max', role: 'Kid', color: 'lime' },
  ];

  it('groups per kid in ROSTER order and omits kids with no chores', () => {
    const groups = groupGeneratedByKid([
      { title: 'B', assignedTo: 'Max' },
      { title: 'A', assignedTo: 'Ava' },
      { title: 'C', assignedTo: 'Max' },
    ], fam);
    expect(groups.map(g => g.kid)).toEqual(['Ava', 'Max']); // roster order, not emission order
    expect(groups[1].chores.map(c => c.title)).toEqual(['B', 'C']);
    expect(groupGeneratedByKid([{ title: 'A', assignedTo: 'Ava' }], fam).map(g => g.kid)).toEqual(['Ava']);
  });
});

describe('CHORE_PLAN_STYLE_EXEMPLAR', () => {
  it('is valid JSON (it is embedded verbatim in the system prompt)', () => {
    const parsed = JSON.parse(CHORE_PLAN_STYLE_EXEMPLAR);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(2);
  });
});
