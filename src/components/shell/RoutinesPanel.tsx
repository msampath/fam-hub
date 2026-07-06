// Pattern-4 routines panel (Manage): shows the MINED candidates ("you added 'milk' on 4 Thursdays")
// as reviewable toggles. Enabling one persists it to settings.routines — only then does the weekday
// digest stage its confirm-tier draft (which still lands in Approvals). Learned rules surface here;
// they NEVER inject silently. Disabling removes it from settings.
import { useApp } from '../../AppContext';
import { C } from './theme';

const DAY = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

export default function RoutinesPanel() {
  const { routineCandidates, routines, setRoutines } = useApp();
  const enabledKey = (text: string, weekday: number) => `${text.toLowerCase()}|${weekday}`;
  const enabled = new Set(routines.filter(r => r.enabled).map(r => enabledKey(r.text, r.weekday)));

  // Union: every enabled routine (even if the candidate aged out of the log window) + fresh candidates.
  const rows = [
    ...routines.filter(r => r.enabled).map(r => ({ text: r.text, weekday: r.weekday, count: null as number | null })),
    ...routineCandidates
      .filter(c => !enabled.has(enabledKey(c.text, c.weekday)))
      .slice(0, 6)
      .map(c => ({ text: c.text, weekday: c.weekday, count: c.count })),
  ];

  const toggle = (text: string, weekday: number, on: boolean) => {
    const rest = routines.filter(r => !(r.text.toLowerCase() === text.toLowerCase() && r.weekday === weekday));
    setRoutines(on ? [...rest, { text, weekday, enabled: true }] : rest);
  };

  if (!rows.length) {
    return (
      <div className="text-[12px] font-semibold" style={{ color: C.ink }}>
        No routines spotted yet — when the same item gets added on the same weekday a few weeks running,
        it'll show up here as a suggestion you can turn on.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {rows.map(r => {
        const on = enabled.has(enabledKey(r.text, r.weekday));
        return (
          <label key={`${r.text}|${r.weekday}`} className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
            <span>
              “{r.text}” on {DAY[r.weekday]}
              {r.count !== null && <span className="font-semibold" style={{ color: C.muted }}> · seen {r.count}×</span>}
            </span>
            <input
              type="checkbox"
              checked={on}
              onChange={e => toggle(r.text, r.weekday, e.target.checked)}
              aria-label={`${on ? 'Disable' : 'Enable'} the ${r.text} routine on ${DAY[r.weekday]}`}
            />
          </label>
        );
      })}
      <div className="text-[11px] font-semibold" style={{ color: C.ink }}>
        An enabled routine stages a draft in Approvals on its weekday morning — nothing is added until you approve it.
      </div>
    </div>
  );
}
