import { describe, it, expect } from 'vitest';
import { daysBetweenISO, upsertVisit, buildHistoryFacts } from '../utils/historyFacts';
import type { VisitLogEntry } from '../types';

describe('daysBetweenISO', () => {
  it('counts whole days (UTC, no timezone drift) and tolerates datetimes', () => {
    expect(daysBetweenISO('2026-06-01', '2026-06-11')).toBe(10);
    expect(daysBetweenISO('2026-06-11', '2026-06-01')).toBe(-10);
    expect(daysBetweenISO('2026-06-01T09:00:00', '2026-06-02T23:00:00')).toBe(1);
  });
});

describe('upsertVisit', () => {
  const base: VisitLogEntry[] = [
    { id: 'v1', label: 'Woodland Park Zoo', category: 'Other', lastVisited: '2026-01-27' },
  ];

  it('inserts a new place', () => {
    const out = upsertVisit(base, { id: 'v2', label: 'Seattle Aquarium', lastVisited: '2026-05-18' });
    expect(out).toHaveLength(2);
    expect(out[1].label).toBe('Seattle Aquarium');
  });

  it('updates an existing place to the LATER date (case-insensitive match)', () => {
    const out = upsertVisit(base, { id: 'v9', label: 'woodland park zoo', lastVisited: '2026-06-10' });
    expect(out).toHaveLength(1);
    expect(out[0].lastVisited).toBe('2026-06-10');
  });

  it('never moves a visit backwards in time', () => {
    const out = upsertVisit(base, { id: 'v9', label: 'Woodland Park Zoo', lastVisited: '2025-12-01' });
    expect(out[0].lastVisited).toBe('2026-01-27'); // kept the newer one
  });

  it('is safe on a non-array input', () => {
    expect(upsertVisit(undefined as any, { id: 'v', label: 'X', lastVisited: '2026-06-01' })).toHaveLength(1);
  });
});

describe('buildHistoryFacts', () => {
  const today = '2026-06-18';
  const visits: VisitLogEntry[] = [
    { id: 'v1', label: 'Woodland Park Zoo', lastVisited: '2026-01-27' }, // ~142 days
    { id: 'v2', label: 'Seattle Aquarium', lastVisited: '2026-05-18' },  // 31 days
    { id: 'v3', label: 'YMCA', lastVisited: '2026-06-15' },              // 3 days
  ];

  it('lists places most-stale first with a days-ago count', () => {
    const out = buildHistoryFacts(today, visits);
    expect(out).toContain('HISTORY FACTS');
    const zooIdx = out.indexOf('Woodland Park Zoo');
    const ymcaIdx = out.indexOf('YMCA');
    expect(zooIdx).toBeGreaterThan(-1);
    expect(zooIdx).toBeLessThan(ymcaIdx); // zoo (stalest) appears before YMCA (freshest)
    expect(out).toContain('142 days ago (last 2026-01-27)');
    expect(out).toContain('3 days ago (last 2026-06-15)');
  });

  it('returns empty string when there are no visits', () => {
    expect(buildHistoryFacts(today, [])).toBe('');
    expect(buildHistoryFacts(today, undefined as any)).toBe('');
  });

  it('drops future-dated noise and caps to maxItems', () => {
    const many: VisitLogEntry[] = [
      { id: 'f', label: 'Future Place', lastVisited: '2026-12-01' }, // future → dropped
      ...Array.from({ length: 15 }, (_, i) => ({ id: `x${i}`, label: `Place ${i}`, lastVisited: '2026-06-01' })),
    ];
    const out = buildHistoryFacts(today, many, 12);
    expect(out).not.toContain('Future Place');
    expect(out.split('\n').filter(l => l.startsWith('- ')).length).toBe(12);
  });
});
