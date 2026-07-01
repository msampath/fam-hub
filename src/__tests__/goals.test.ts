import { describe, it, expect } from 'vitest';
import { mergeGoalSteps, blockNextGoalStep, advanceGoalStep } from '../utils/goals';
import type { Goal, GoalStep } from '../types';

const goal = (steps: GoalStep[], over: Partial<Goal> = {}): Goal =>
  ({ id: 'g1', text: 'Plan a Mount Rainier day trip', status: 'active', steps, ...over } as Goal);

describe('mergeGoalSteps — re-emitting set_goal must not wipe in-flight progress', () => {
  it('preserves a done/blocked step (+ledgerId) when the agent re-sends the plan as all-pending', () => {
    const existing: GoalStep[] = [
      { title: 'Pick the venue', status: 'done' },
      { title: 'Reserve the pass', status: 'blocked', ledgerId: 'led-9' },
      { title: 'Add to calendar', status: 'pending' },
    ];
    const incoming: GoalStep[] = [
      { title: 'Pick the venue', status: 'pending' },
      { title: 'Reserve the pass', status: 'pending' },
      { title: 'Add to calendar', status: 'pending' },
    ];
    expect(mergeGoalSteps(existing, incoming)).toEqual([
      { title: 'Pick the venue', status: 'done' },
      { title: 'Reserve the pass', status: 'blocked', ledgerId: 'led-9' }, // ledgerId survives the re-emit
      { title: 'Add to calendar', status: 'pending' },
    ]);
  });
  it('accepts an explicit non-pending status from the agent, and adds genuinely new steps', () => {
    const existing: GoalStep[] = [{ title: 'A', status: 'blocked', ledgerId: 'led-1' }];
    const incoming: GoalStep[] = [{ title: 'A', status: 'done' }, { title: 'B', status: 'pending' }];
    expect(mergeGoalSteps(existing, incoming)).toEqual([{ title: 'A', status: 'done' }, { title: 'B', status: 'pending' }]);
  });
  it('keeps the current plan on a text-only update (no incoming steps)', () => {
    const existing: GoalStep[] = [{ title: 'A', status: 'done' }];
    expect(mergeGoalSteps(existing, undefined)).toBe(existing);
  });
});

describe('blockNextGoalStep — stage a step as "waiting on you"', () => {
  it('blocks the first pending step, links the ledger entry, and flips the goal to waiting', () => {
    const g = blockNextGoalStep(goal([{ title: 'A', status: 'done' }, { title: 'B', status: 'pending' }]), 'led-5');
    expect(g.status).toBe('waiting');
    expect(g.steps).toEqual([{ title: 'A', status: 'done' }, { title: 'B', status: 'blocked', ledgerId: 'led-5' }]);
  });
  it('is a no-op when no pending step remains', () => {
    const g0 = goal([{ title: 'A', status: 'done' }]);
    expect(blockNextGoalStep(g0, 'led-5')).toBe(g0);
  });
});

describe('advanceGoalStep — resume the goal on approval', () => {
  it('marks the step linked by ledgerId done and points at the next step', () => {
    const g = advanceGoalStep(goal([
      { title: 'A', status: 'blocked', ledgerId: 'led-5' },
      { title: 'B', status: 'pending' },
    ]), 'led-5');
    expect(g.steps![0]).toEqual({ title: 'A', status: 'done', ledgerId: undefined });
    expect(g.status).toBe('active');
    expect(g.nextAction).toBe('B');
  });
  it('closes the goal when the last step completes', () => {
    const g = advanceGoalStep(goal([{ title: 'A', status: 'blocked', ledgerId: 'led-5' }]), 'led-5');
    expect(g.status).toBe('done');
    expect(g.nextAction).toBeUndefined();
  });
  it('falls back to the first BLOCKED step (never a pending/active one) when no ledgerId matches', () => {
    const g = advanceGoalStep(goal([
      { title: 'A', status: 'active' },
      { title: 'B', status: 'blocked', ledgerId: 'led-7' },
      { title: 'C', status: 'pending' },
    ]), 'led-NOPE');
    // Must NOT complete A (active, no approval landed) — only the blocked B.
    expect(g.steps!.find(s => s.title === 'B')!.status).toBe('done');
    expect(g.steps!.find(s => s.title === 'A')!.status).toBe('active');
  });
});
