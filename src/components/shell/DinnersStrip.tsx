import { useApp } from '../../AppContext';
import { C, brutShadow } from './theme';
import { toLocalDateStr, parseLocalDate } from '../../utils/dates';

// This week's dinners (the meal planner): a read-only strip of day chips from the newest MealPlan.
// The agent writes plans via set_meal_plan (owner decision: dinners are NOT calendar events — they
// live here + in the briefing). ✨ marks days the agent proposed (source:'generated') vs dictated.
// Read-only by design (kid-safe as-is): changes go through the copilot ("swap Thursday to rajma").
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const MEAL_ORDER = { breakfast: 0, lunch: 1, dinner: 2 } as const;

export default function DinnersStrip() {
  const { mealPlans, copilotName, deleteMealPlan, kidMode } = useApp();
  // Newest week's plans — a week can carry SEPARATE plans per meal (dinner + lunch coexist; the
  // dinner-only refusal of "plan next week's lunches" was a live bug). Breakfast → lunch → dinner.
  const sorted = [...mealPlans].sort((a, b) => (b.weekStart || '').localeCompare(a.weekStart || ''));
  const week = sorted[0]?.weekStart;
  const plans = sorted
    .filter(p => p.weekStart === week)
    .sort((a, b) => MEAL_ORDER[a.meal || 'dinner'] - MEAL_ORDER[b.meal || 'dinner']);
  const today = toLocalDateStr(new Date());

  return (
    <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.elevated}`, boxShadow: brutShadow(C.elevated, 4), background: C.card }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.muted }}>🍽 This week's meals</span>
        {plans.length > 0 && <span className="ml-auto text-[11px] font-semibold" style={{ color: C.muted }}>say "swap Thursday to …" to change a day</span>}
      </div>

      {plans.length === 0 ? (
        <div className="text-[12px] font-semibold" style={{ color: C.ink }}>
          No meal plan yet — give {copilotName} your week ("Mon paneer butter masala, Tue tacos…") and it'll plan the meals AND the shopping list.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {plans.map(plan => {
            const meal = plan.meal || 'dinner';
            return (
              <div key={`${plan.weekStart}-${meal}`} className="flex items-start gap-2">
              <div className="flex flex-1 gap-2 overflow-x-auto pb-1">
                {plan.days.map(d => {
                  const isToday = d.date === today;
                  const dow = DAY_LABEL[parseLocalDate(d.date).getDay()];
                  return (
                    <div
                      key={d.date}
                      aria-current={isToday ? 'date' : undefined}
                      aria-label={`${dow} ${meal}: ${d.dish}`}
                      title={d.note || undefined}
                      className="min-w-[108px] max-w-[160px] flex-shrink-0 rounded-[12px] px-2.5 py-2"
                      style={{ background: C.app, border: `2px solid ${isToday ? C.indigo : C.elevated}` }}
                    >
                      <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: isToday ? C.indigo : C.muted }}>
                        {meal !== 'dinner' ? `${meal} · ` : ''}{dow} {d.date.slice(5).replace('-', '/')}{isToday ? ' · today' : ''}
                      </div>
                      <div className="mt-0.5 text-[12px] font-semibold leading-tight" style={{ color: C.primary }}>
                        {d.source === 'generated' ? '✨ ' : ''}{d.dish}
                      </div>
                      {d.note && <div className="mt-0.5 truncate text-[10px] font-semibold" style={{ color: C.muted }}>{d.note}</div>}
                    </div>
                  );
                })}
              </div>
              {/* Manual delete (completes CRUD alongside the copilot's delete_meal_plan). Kid mode hides it. */}
              {!kidMode && (
                <button
                  type="button"
                  onClick={() => deleteMealPlan({ meal, weekStart: plan.weekStart })}
                  aria-label={`Clear the ${meal} plan`}
                  title={`Clear the ${meal} plan`}
                  className="mt-0.5 flex-shrink-0 rounded-[8px] px-2 py-1 text-[11px] font-bold"
                  style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.muted }}
                >
                  Clear
                </button>
              )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
