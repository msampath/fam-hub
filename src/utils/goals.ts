// Pure goal-loop reducers (A6 agentic goal loop) — extracted from App.tsx so the index-walking logic is
// unit-testable. A goal carries a `steps[]` plan; reversible steps apply in-turn, and each staged/external
// step is "blocked" on a human approval that, once granted, advances the goal. These three functions are
// the heart of that loop.
import type { Goal, GoalStep } from '../types';

// Reconcile an incoming set_goal step plan against the goal's existing steps. The agent re-sends the FULL
// plan when it UPDATEs/continues a goal (set_goal with the same id), and that payload arrives with every
// step defaulted to 'pending' and NO ledgerId. A naive replace would wipe in-flight progress (done/blocked)
// and break the step↔Approvals link. So: match by title and KEEP the existing step's status + ledgerId
// unless the agent explicitly sent a real (non-'pending') status for it. New titles come through as-is.
export function mergeGoalSteps(existing: GoalStep[] | undefined, incoming: GoalStep[] | undefined): GoalStep[] | undefined {
  if (!incoming) return existing;                 // text-only update → keep the current plan
  if (!existing?.length) return incoming;
  return incoming.map(s => {
    const prev = existing.find(p => p.title === s.title);
    return prev && s.status === 'pending' ? prev : s; // preserve progress + ledgerId across a re-emit
  });
}

// Mark the goal's next still-'pending' step 'blocked' (waiting on the human) and link it to the Approvals
// entry, flipping the goal to 'waiting'. No-op (goal unchanged) when no pending step remains.
export function blockNextGoalStep(goal: Goal, ledgerId: string): Goal {
  const steps = [...(goal.steps || [])];
  const ti = steps.findIndex(s => s.status === 'pending');
  if (ti < 0) return goal;
  steps[ti] = { ...steps[ti], status: 'blocked', ledgerId };
  return { ...goal, status: 'waiting', steps };
}

// Advance the goal when its tied Approvals entry is approved: mark the step linked to that entry (by
// ledgerId) 'done'. If no step carries that id, fall back to the first still-'blocked' step (NOT any
// not-done step — so approving one entry can't silently complete a 'pending'/'active' step whose own
// approval hasn't landed). Then point at the next remaining step, or close the goal when none remain.
export function advanceGoalStep(goal: Goal, ledgerId: string): Goal {
  const steps = [...(goal.steps || [])];
  let ti = steps.findIndex(s => s.ledgerId === ledgerId);
  if (ti < 0) ti = steps.findIndex(s => s.status === 'blocked');
  if (ti >= 0) steps[ti] = { ...steps[ti], status: 'done', ledgerId: undefined };
  const nextPending = steps.find(s => s.status !== 'done');
  return { ...goal, steps, status: nextPending ? 'active' : 'done', nextAction: nextPending?.title };
}
