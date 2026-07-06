// Pattern-4 routine mining: conservative by design — a false "routine" costs parent trust. And the
// draft builder must be un-naggable: enabled-only, weekday-only, deduped against pending + the list.
import { describe, it, expect } from 'vitest';
import { mineShoppingRoutines, buildRoutineDrafts, normalizeRoutineText } from '../utils/routineMiner';
import type { LedgerEntry, QuickAddLogEntry } from '../types';

const entry = (text: string, iso: string, kind = 'shopping'): QuickAddLogEntry =>
  ({ id: iso + text, text, kind, createdAt: iso } as QuickAddLogEntry);

// Thursdays across four weeks (2026-06-11/18/25, 2026-07-02) + noise.
const THURSDAYS = ['2026-06-11', '2026-06-18', '2026-06-25', '2026-07-02'];

describe('normalizeRoutineText', () => {
  it('strips add-verbs and trailing store phrases', () => {
    expect(normalizeRoutineText('Add milk to the Costco list')).toBe('milk');
    expect(normalizeRoutineText('buy organic milk')).toBe('organic milk');
    expect(normalizeRoutineText('  Milk ')).toBe('milk');
  });
});

describe('mineShoppingRoutines', () => {
  it('finds a weekday-consistent repeat and reports its modal weekday', () => {
    const log = THURSDAYS.map(d => entry('add milk to costco', `${d}T18:00:00Z`));
    const out = mineShoppingRoutines(log);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ text: 'milk', count: 4 });
    expect(out[0].weekday).toBe(new Date('2026-06-11T18:00:00Z').getDay());
  });

  it('rejects: too few, single-week bursts, scattered weekdays, non-shopping kinds', () => {
    const burst = [entry('add eggs', '2026-06-11T08:00:00Z'), entry('add eggs', '2026-06-11T09:00:00Z'), entry('add eggs', '2026-06-11T10:00:00Z')];
    const scattered = ['2026-06-08', '2026-06-16', '2026-06-24', '2026-07-02'].map(d => entry('add bread', `${d}T18:00:00Z`)); // Mon/Tue/Wed/Thu
    const wrongKind = THURSDAYS.map(d => entry('soccer practice', `${d}T18:00:00Z`, 'event'));
    expect(mineShoppingRoutines([...burst, ...scattered, ...wrongKind])).toHaveLength(0);
  });

  it('tolerates garbage entries', () => {
    expect(mineShoppingRoutines([null, {}, entry('x', 'not-a-date')] as any)).toEqual([]);
  });
});

describe('buildRoutineDrafts', () => {
  const stamp = { createdAt: '2026-07-09T14:00:00Z', createdByUserId: 'concierge' };
  const mkId = (() => { let i = 0; return () => `led-${++i}`; })();
  const THURSDAY = '2026-07-09'; // a Thursday

  it('stages ONLY enabled routines whose weekday is today, as confirm-tier pending drafts', () => {
    const out = buildRoutineDrafts(
      [
        { text: 'milk', weekday: 4, enabled: true },
        { text: 'bread', weekday: 1, enabled: true },     // wrong weekday
        { text: 'eggs', weekday: 4, enabled: false },     // not enabled → NEVER staged
      ],
      THURSDAY, [], [], mkId, stamp,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending', proactiveDate: THURSDAY });
    expect((out[0].payload as { text: string }).text).toBe('milk');
  });

  it('dedupes against the live list and already-pending drafts', () => {
    const pending: LedgerEntry[] = [
      { id: 'p1', tool: 'add_shopping_item', riskTier: 'confirm', status: 'pending', payload: { text: 'Milk' } } as LedgerEntry,
    ];
    const out = buildRoutineDrafts(
      [{ text: 'milk', weekday: 4, enabled: true }, { text: 'yogurt', weekday: 4, enabled: true }],
      THURSDAY, pending, ['Add yogurt to the grocery store list'], mkId, stamp,
    );
    expect(out).toHaveLength(0); // milk pending, yogurt on the list (normalized match)
  });
});
