import { useApp } from '../../AppContext';
import { useCalendar } from '../../CalendarContext';
import { C, brutShadow } from './theme';
import type { GoalStep } from '../../types';

// Goals the concierge is tracking (agentic A6): a compact, family-visible card of in-progress multi-step
// goals. The agent records a goal + its PLAN (steps[]) via set_goal; each step shows its state (done /
// waiting on you / to-do) and the goal advances as staged steps are approved. A "Continue" button re-asks
// the concierge to drive the next step. Goals are AGENT-created (ask the concierge in the bar); this card
// only displays + lets you complete/remove them — there's no manual add (a typed goal had no plan).
const STEP_DOT: Record<GoalStep['status'], { mark: string; color: string; label?: string }> = {
  done: { mark: '✓', color: C.emerald },
  blocked: { mark: '⏳', color: C.amber, label: 'waiting for your approval' },
  active: { mark: '▸', color: C.indigo },
  pending: { mark: '○', color: C.muted },
};

export default function GoalsStrip() {
  const { goalsList, toggleGoal, deleteGoal, toggleStep, kidMode } = useApp();
  const { handleSendCopilotMessage } = useCalendar();

  // 'active' = anything not finished/abandoned (covers legacy 'open' + the new active/waiting states).
  const active = goalsList.filter(g => g.status !== 'done' && g.status !== 'abandoned');
  const done = goalsList.filter(g => g.status === 'done');

  // Re-ask the concierge to drive the goal's next step (forced → the cloud agent, which holds the tools).
  // Pass the gathered CONTEXT (chosen date, itinerary, decisions) so it resumes without re-asking — robust
  // even after a reload/new session, when the chat history is gone.
  const continueGoal = (g: { text: string; nextAction?: string; context?: string }) =>
    handleSendCopilotMessage(
      `Continue this goal: "${g.text}".${g.nextAction ? ` Next step: ${g.nextAction}.` : ''}${g.context ? ` Context so far: ${g.context}` : ''}`,
      { forced: true },
    );

  return (
    <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.elevated}`, boxShadow: brutShadow(C.elevated, 4), background: C.card }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.muted }}>🎯 Goals the copilot is tracking</span>
        {active.length > 0 && <span className="ml-auto text-[11px] font-semibold" style={{ color: C.muted }}>{active.length} active</span>}
      </div>

      {active.length === 0 && done.length === 0 ? (
        <div className="text-[12px] font-semibold" style={{ color: C.ink }}>No goals yet — ask the copilot in the bar above for a multi-step plan (e.g. "plan a Mount Rainier day trip") and it'll track the plan here.</div>
      ) : (
        <div className="flex flex-col gap-2">
          {[...active, ...done].map(g => {
            const isDone = g.status === 'done';
            const steps = g.steps || [];
            const waiting = steps.some(s => s.status === 'blocked');
            return (
              <div key={g.id} className="flex flex-col gap-1 rounded-[12px] p-2" style={{ background: C.app, border: `2px solid ${waiting ? C.amber : C.elevated}` }}>
                <div className="flex items-center gap-2.5">
                  <button
                    type="button" role="checkbox" aria-checked={isDone} aria-label={`Mark "${g.text}" ${isDone ? 'active' : 'done'}`}
                    onClick={() => toggleGoal(g.id)}
                    className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[7px] text-[12px] font-bold"
                    style={{ border: `2px solid ${isDone ? C.emerald : C.elevated}`, background: isDone ? `${C.emerald}1f` : C.card, color: C.emerald }}
                  >{isDone ? '✓' : ''}</button>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold" style={{ color: isDone ? C.muted : C.primary, textDecoration: isDone ? 'line-through' : 'none' }}>{g.text}</div>
                    {!isDone && waiting && <div className="truncate text-[11px] font-bold" style={{ color: C.amber }}>⏳ Waiting on you — review in Approvals</div>}
                    {!isDone && !waiting && g.nextAction && <div className="truncate text-[11px] font-semibold" style={{ color: C.indigo }}>Next: {g.nextAction}</div>}
                  </div>
                  {!kidMode && <button type="button" onClick={() => deleteGoal(g.id)} aria-label={`Remove ${g.text}`} className="flex h-8 w-8 flex-shrink-0 items-center justify-center text-[13px] font-bold" style={{ color: C.ink }}>✕</button>}
                </div>

                {steps.length > 0 && (
                  <ul className="ml-8 flex flex-col gap-0.5">
                    {steps.map((s, i) => {
                      const d = STEP_DOT[s.status];
                      const blocked = s.status === 'blocked';
                      return (
                        <li key={i}>
                          {/* Tap to tick a step done/undone. A 'blocked' step waits on Approvals — non-interactive. */}
                          <button
                            type="button" role="checkbox" aria-checked={s.status === 'done'} disabled={blocked}
                            aria-label={`Mark step "${s.title}" ${s.status === 'done' ? 'not done' : 'done'}`}
                            onClick={() => toggleStep(g.id, i)}
                            className="flex w-full items-center gap-1.5 text-left text-[11px] font-semibold"
                            style={{ color: s.status === 'done' ? C.muted : C.ink, cursor: blocked ? 'default' : 'pointer' }}
                          >
                            <span style={{ color: d.color }}>{d.mark}</span>
                            <span className="truncate" style={{ textDecoration: s.status === 'done' ? 'line-through' : 'none' }}>{s.title}</span>
                            {d.label && <span className="flex-shrink-0" style={{ color: d.color }}>· {d.label}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {!isDone && !waiting && steps.some(s => s.status !== 'done') && (
                  <button
                    type="button" onClick={() => continueGoal(g)}
                    className="ml-8 mr-auto rounded-[8px] px-2.5 py-1 text-[11px] font-extrabold"
                    style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}
                  >Continue →</button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
