import { useApp } from '../../AppContext';
import { C, brutShadow } from './theme';
import { toLocalDateStr, parseLocalDate } from '../../utils/dates';

// This week's dinners (the meal planner): a read-only strip of day chips from the newest MealPlan.
// The agent writes plans via set_meal_plan (owner decision: dinners are NOT calendar events — they
// live here + in the briefing). ✨ marks days the agent proposed (source:'generated') vs dictated.
// Read-only by design (kid-safe as-is): changes go through the copilot ("swap Thursday to rajma").
const DAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function DinnersStrip() {
  const { mealPlans, copilotName } = useApp();
  // Newest week first (upsert keeps them sorted; sort defensively for legacy/local blobs).
  const plan = [...mealPlans].sort((a, b) => (b.weekStart || '').localeCompare(a.weekStart || ''))[0];
  const today = toLocalDateStr(new Date());

  return (
    <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.elevated}`, boxShadow: brutShadow(C.elevated, 4), background: C.card }}>
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.muted }}>🍽 This week's dinners</span>
        {plan && <span className="ml-auto text-[11px] font-semibold" style={{ color: C.muted }}>say "swap Thursday to …" to change a day</span>}
      </div>

      {!plan ? (
        <div className="text-[12px] font-semibold" style={{ color: C.ink }}>
          No dinner plan yet — give {copilotName} your week ("Mon paneer butter masala, Tue tacos…") and it'll plan the dinners AND the shopping list.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plan.days.map(d => {
            const isToday = d.date === today;
            const dow = DAY_LABEL[parseLocalDate(d.date).getDay()];
            return (
              <div
                key={d.date}
                aria-current={isToday ? 'date' : undefined}
                aria-label={`${dow} dinner: ${d.dish}`}
                title={d.note || undefined}
                className="min-w-[108px] max-w-[160px] flex-shrink-0 rounded-[12px] px-2.5 py-2"
                style={{ background: C.app, border: `2px solid ${isToday ? C.indigo : C.elevated}` }}
              >
                <div className="text-[10px] font-extrabold uppercase tracking-wide" style={{ color: isToday ? C.indigo : C.muted }}>
                  {dow} {d.date.slice(5).replace('-', '/')}{isToday ? ' · today' : ''}
                </div>
                <div className="mt-0.5 text-[12px] font-semibold leading-tight" style={{ color: C.primary }}>
                  {d.source === 'generated' ? '✨ ' : ''}{d.dish}
                </div>
                {d.note && <div className="mt-0.5 truncate text-[10px] font-semibold" style={{ color: C.muted }}>{d.note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
