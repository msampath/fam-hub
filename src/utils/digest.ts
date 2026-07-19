// Server-side daily-digest scheduling (the closed-app autonomy layer). Pure timing helper so the scheduler
// fires once per day at the configured hour without a cron dependency — mirrors reminders.shouldFireDailyReminder.
// The digest CONTENT reuses utils/briefing.buildBriefing.

// The household's LOCAL calendar date + wall-clock hour for a given instant. On the Cloud Run (UTC)
// deploy, the process timezone is NOT the household's — so sendHour and "today" must be computed in the
// household's own timeZone (an IANA name the client stamps into digestprefs), not with getHours()/getDate().
// Falls back to server-local when no/invalid timeZone is given. Pure (Intl only) → unit-testable.
export function localDateHour(now: Date, timeZone?: string): { date: string; hour: number } {
  try {
    if (timeZone) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
      }).formatToParts(now);
      const get = (t: string) => parts.find(p => p.type === t)?.value || '';
      const date = `${get('year')}-${get('month')}-${get('day')}`;
      let hour = Number(get('hour'));
      if (hour === 24) hour = 0; // some ICU builds emit '24' for midnight
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(hour)) return { date, hour };
    }
  } catch { /* invalid timeZone → server-local fallback */ }
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, hour: now.getHours() };
}

// Whether the daily digest should run now: at/after `sendHour` (0–23, household-LOCAL) and not already
// run on the household-local `todayStr`. Both are pre-computed by the caller via localDateHour().
export function shouldRunDigestNow(localHour: number, sendHour: number, lastRunDate: string | null, todayStr: string): boolean {
  if (lastRunDate === todayStr) return false;
  return localHour >= sendHour;
}
