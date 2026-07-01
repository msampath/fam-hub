import { describe, it, expect } from 'vitest';
import { mergeBills } from '../utils/billsStore';
import type { Bill } from '../types';

let n = 0;
const stamp = () => ({ id: `bill-${++n}`, createdAt: '2026-06-24' });

describe('mergeBills', () => {
  it('adds new bills, stamping id + createdAt', () => {
    const out = mergeBills([], [{ payee: 'PSE', amount: '$84.20', dueDate: '2026-07-01' }], stamp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ payee: 'PSE', amount: '$84.20', dueDate: '2026-07-01' });
    expect(out[0].id).toMatch(/^bill-/);
  });

  it('dedupes by payee|dueDate across re-scans', () => {
    const existing: Bill[] = [{ id: 'b1', payee: 'PSE', dueDate: '2026-07-01' }];
    const out = mergeBills(existing, [
      { payee: 'pse', dueDate: '2026-07-01' },          // same (case-insensitive) → skip
      { payee: 'Comcast', dueDate: '2026-07-05' },      // new
    ], stamp);
    expect(out.map(b => b.payee)).toEqual(['PSE', 'Comcast']);
  });

  it('drops entries with no payee and clamps a bad dueDate', () => {
    const out = mergeBills([], [
      { payee: '   ', amount: '$5' },                   // no payee → dropped
      { payee: 'Water', dueDate: 'not-a-date' },        // bad date → undefined
    ], stamp);
    expect(out).toHaveLength(1);
    expect(out[0].payee).toBe('Water');
    expect(out[0].dueDate).toBeUndefined();
  });

  it('caps the collection to the most recent N', () => {
    const existing: Bill[] = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, payee: `P${i}`, dueDate: '2026-01-01' }));
    const out = mergeBills(existing, [{ payee: 'NEW', dueDate: '2026-12-31' }], stamp, 100);
    expect(out).toHaveLength(100);
    expect(out[out.length - 1].payee).toBe('NEW'); // newest kept
    expect(out[0].payee).toBe('P1');               // oldest dropped
  });
});
