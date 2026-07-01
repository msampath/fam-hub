// Deterministic LONG WEEKEND grounding for the copilot. Even the 14B local model (and devstral)
// reliably MIS-identify a long weekend — dropping the holiday that makes it long (Juneteenth), or
// pulling in a normal adjacent weekday — and the error is confirmed MODEL-AGNOSTIC, so a prompt
// rule can't fix it. So, exactly like DATE FACTS, we SERVER-COMPUTE the off-day window and inject it
// as an authoritative block: the model only lists one activity per listed day; it never reasons
// about which days are off. Pure/testable — no I/O.
import { addDaysISO, weekdayOf } from './copilotHarness';
import { classifyEvent, isWholeFamilyTag } from './availability';

// The nth (1-based) `weekday` (0=Sun…6=Sat) of `month` (1-based) in `year`, as ISO 'YYYY-MM-DD'.
// n = -1 → the LAST such weekday of the month. All math in UTC so it never drifts with the host tz.
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n === -1) {
    const last = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of `month`
    const offset = (last.getUTCDay() - weekday + 7) % 7;
    last.setUTCDate(last.getUTCDate() - offset);
    return last.toISOString().slice(0, 10);
  }
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  const day = 1 + offset + (n - 1) * 7;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// US federal OBSERVANCE: a fixed-date holiday on a Saturday is observed the prior Friday; on a
// Sunday the following Monday — and the observed weekday is the one that actually creates the long
// weekend. Mark BOTH the literal date (usually a weekend day anyway) and the observed weekday off.
// (Cross-year is fine: New Year on a Saturday adds the prior Dec 31, and the window-year set in
// computeOffDays spans both years.)
function withObserved(m: Map<string, string>, iso: string, name: string) {
  m.set(iso, name);
  const wd = weekdayOf(iso);
  if (wd === 'Saturday') m.set(addDaysISO(iso, -1), `${name} (observed)`);
  else if (wd === 'Sunday') m.set(addDaysISO(iso, 1), `${name} (observed)`);
}

// The small set of US federal/observed holidays families actually plan long weekends around — a
// BACKSTOP for holidays that aren't synced onto the calendar (Juneteenth / Memorial Day etc. aren't
// OFF keywords and may not be a Holiday-category event). ISO date → display name. Fixed-date
// holidays carry their observed-weekday shift; Thanksgiving carries the near-universal Friday bridge.
export function usHolidays(year: number): Map<string, string> {
  const m = new Map<string, string>();
  withObserved(m, `${year}-01-01`, "New Year's Day");
  m.set(nthWeekday(year, 1, 1, 3), 'MLK Day');           // 3rd Mon Jan
  m.set(nthWeekday(year, 2, 1, 3), "Presidents' Day");   // 3rd Mon Feb
  m.set(nthWeekday(year, 5, 1, -1), 'Memorial Day');     // last Mon May
  withObserved(m, `${year}-06-19`, 'Juneteenth');
  withObserved(m, `${year}-07-04`, 'Independence Day');
  m.set(nthWeekday(year, 9, 1, 1), 'Labor Day');         // 1st Mon Sep
  const thanksgiving = nthWeekday(year, 11, 4, 4);       // 4th Thu Nov
  m.set(thanksgiving, 'Thanksgiving');
  m.set(addDaysISO(thanksgiving, 1), 'Day after Thanksgiving'); // Fri — near-universal day off
  withObserved(m, `${year}-12-25`, 'Christmas Day');
  return m;
}

// Map of every OFF/no-commitment day in [today, today+days) → a reason ('' for a plain weekend).
// Off = weekends ∪ the US-holiday backstop ∪ days the WHOLE family is off via calendar events.
// FAMILY-WIDE gate: a calendar OFF event only marks the day off when every roster member is off that
// day (an untagged / "Everyone" OFF event covers all). A single-member OFF event — one kid's "No
// school" while the parents work — no longer inflates a family long weekend; that per-person nuance
// lives in AVAILABILITY. EXCEPTION: a Holiday-category event bypasses the gate (everyone-off by
// nature). With no roster we can't scope, so any OFF event marks the day (preserves the pre-roster
// behavior). A specific reason (holiday/event name) is never overwritten by a blank one.
export function computeOffDays(today: string, events: any[], memberNames: string[] = [], days = 12): Map<string, string> {
  const off = new Map<string, string>();
  const add = (iso: string, reason: string) => {
    const cur = off.get(iso);
    if (cur === undefined) off.set(iso, reason);
    else if (!cur && reason) off.set(iso, reason); // upgrade a blank weekend reason to a named one
  };

  const windowEndExcl = addDaysISO(today, days);

  // Weekends (blank reason).
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(today, i);
    const wd = weekdayOf(iso);
    if (wd === 'Saturday' || wd === 'Sunday') add(iso, '');
  }

  // US-holiday backstop across the year(s) the window spans.
  const years = new Set([Number(today.slice(0, 4)), Number(windowEndExcl.slice(0, 4))]);
  for (const y of years) {
    for (const [iso, name] of usHolidays(y)) {
      if (iso >= today && iso < windowEndExcl) add(iso, name);
    }
  }

  // OFF calendar events, gated to family-wide off-days. Collect per-day coverage first, then a day is
  // off only when an OFF event applies to all OR every roster member is covered by one.
  const roster = (Array.isArray(memberNames) ? memberNames : []).map(s => String(s).trim()).filter(Boolean);
  const rosterLc = roster.map(r => r.toLowerCase());
  const byDay = new Map<string, { covered: Set<string>; all: boolean; reason: string }>();
  for (const e of Array.isArray(events) ? events : []) {
    if (classifyEvent(e) !== 'OFF') continue;
    const start = String(e?.start || '').slice(0, 10);
    if (!start) continue;
    const end = String(e?.end || e?.start || '').slice(0, 10);
    const reason = String(e?.title || '').trim();
    const tagged = Array.isArray(e?.members) ? e.members.map((m: any) => String(m).trim()).filter(Boolean) : [];
    // A Holiday-CATEGORY event is everyone-off by nature, so it's family-wide regardless of who it's
    // tagged to (a holiday on the calendar always makes the long weekend, even if no parent marked
    // themselves off). Otherwise family-wide = no roster, untagged, or a whole-family tag
    // ("Everyone" OR "Family" — the latter is the default assignee for imported Google/ICS calendars).
    const isHoliday = String(e?.category || '').trim().toLowerCase() === 'holiday';
    const appliesToAll = isHoliday || !roster.length || !tagged.length || tagged.some(isWholeFamilyTag);
    let d = start < today ? today : start;
    for (let guard = 0; d < windowEndExcl && d <= end && guard < 400; guard++) {
      const slot = byDay.get(d) || { covered: new Set<string>(), all: false, reason: '' };
      // A Holiday is the actual family-wide cause, so its title wins the day's label over a coincident
      // single-member event; otherwise the first OFF event supplies the reason.
      if (isHoliday && reason) slot.reason = reason;
      else if (!slot.reason && reason) slot.reason = reason;
      if (appliesToAll) slot.all = true;
      else for (const m of tagged) { const lc = m.toLowerCase(); if (rosterLc.includes(lc)) slot.covered.add(lc); }
      byDay.set(d, slot);
      d = addDaysISO(d, 1);
    }
  }
  for (const [d, slot] of byDay) {
    const familyOff = slot.all || (roster.length > 0 && rosterLc.every(r => slot.covered.has(r)));
    if (familyOff) add(d, slot.reason);
  }
  return off;
}

// The authoritative LONG WEEKEND block, or '' when there's no long weekend in the window. A "long
// weekend" is the FIRST contiguous run of off-days that spans both a Saturday and a Sunday AND
// extends past them with an adjacent off Friday/Monday (a bare Sat+Sun is an ordinary weekend, left
// to DATE FACTS). The block lists exactly the off days and explicitly names any directly-adjacent
// NORMAL weekday so the model can't pull it in (the Bug-4 "included Mon 6/22" failure).
export function buildLongWeekendBlock(today: string, events: any[], memberNames: string[] = [], days = 12): string {
  const off = computeOffDays(today, events, memberNames, days);
  const windowEndExcl = addDaysISO(today, days);

  // Walk the window collecting contiguous off-runs.
  type Run = { dates: string[] };
  const runs: Run[] = [];
  let cur: string[] = [];
  for (let i = 0; i < days; i++) {
    const iso = addDaysISO(today, i);
    if (off.has(iso)) {
      cur.push(iso);
    } else if (cur.length) {
      runs.push({ dates: cur });
      cur = [];
    }
  }
  if (cur.length) runs.push({ dates: cur });

  // First qualifying run: contains a Sat AND a Sun, and is longer than the bare weekend (≥3 days).
  const run = runs.find(r => {
    const wds = r.dates.map(weekdayOf);
    return r.dates.length >= 3 && wds.includes('Saturday') && wds.includes('Sunday');
  });
  if (!run) return '';

  const dayLines = run.dates.map(iso => {
    const reason = off.get(iso) || '';
    return `  - ${weekdayOf(iso)} ${iso}${reason ? `: ${reason}` : ''}`;
  });

  // Directly-adjacent NORMAL weekdays (Mon–Fri, in-window, not off, not today) — call them out so
  // the model treats them as regular days.
  const adjacent: string[] = [];
  const consider = (iso: string) => {
    if (iso < today || iso >= windowEndExcl) return;
    if (iso === today) return;
    if (off.has(iso)) return;
    const wd = weekdayOf(iso);
    if (wd === 'Saturday' || wd === 'Sunday') return;
    adjacent.push(`${wd} ${iso}`);
  };
  consider(addDaysISO(run.dates[0], -1));
  consider(addDaysISO(run.dates[run.dates.length - 1], 1));

  return [
    'LONG WEEKEND (authoritative — these are the ONLY days off; cover EXACTLY these days, one activity per day):',
    ...dayLines,
    ...(adjacent.length
      ? [`Adjacent NORMAL days (a regular work/school day — NOT part of the long weekend; do not plan the long-weekend outings here): ${adjacent.join(', ')}.`]
      : []),
  ].join('\n');
}
