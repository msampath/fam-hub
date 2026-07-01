import { describe, it, expect } from 'vitest';
import { verifyActions, buildCriticNote } from '../utils/copilotCritic';

const ctx = { memberNames: ['Leo', 'Mia'], today: '2026-06-25' };

describe('verifyActions (A7 critic)', () => {
  it('passes a clean chore + event', () => {
    const issues = verifyActions([
      { type: 'add_chore', payload: { assignedTo: 'Leo', title: 'Dishes' } },
      { type: 'create_event', payload: { title: 'Dentist', start: '2026-07-01' } },
    ], ctx);
    expect(issues).toEqual([]);
  });

  it('flags a chore for someone not on the roster', () => {
    const issues = verifyActions([{ type: 'add_chore', payload: { assignedTo: 'Leoo', title: 'x' } }], ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].reason).toMatch(/not a family member/);
  });

  it('allows group phrases like "both kids"', () => {
    expect(verifyActions([{ type: 'add_chore', payload: { assignedTo: 'both kids', title: 'x' } }], ctx)).toEqual([]);
  });

  it('flags a past date and a malformed date', () => {
    const issues = verifyActions([
      { type: 'create_event', payload: { title: 'a', start: '2020-01-01' } },
      { type: 'create_event', payload: { title: 'b', start: 'next friday' } },
    ], ctx);
    expect(issues.map(i => i.reason).join(' ')).toMatch(/past/);
    expect(issues.map(i => i.reason).join(' ')).toMatch(/not a valid/);
  });

  it('flags a missing event title and a chore with no assignee', () => {
    const issues = verifyActions([
      { type: 'create_event', payload: { start: '2026-07-01' } },
      { type: 'add_chore', payload: { title: 'x' } },
    ], ctx);
    expect(issues).toHaveLength(2);
  });

  it('builds a corrective note listing each issue', () => {
    const note = buildCriticNote([{ index: 0, type: 'add_chore', reason: 'bad' }]);
    expect(note).toMatch(/action #1 \(add_chore\): bad/);
    expect(note).toMatch(/Re-emit/);
  });
});
