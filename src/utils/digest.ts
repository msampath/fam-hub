// Server-side daily-digest scheduling (the closed-app autonomy layer). Pure timing helper so the scheduler
// fires once per day at the configured hour without a cron dependency — mirrors reminders.shouldFireDailyReminder
// but server-local. The digest CONTENT reuses utils/briefing.buildBriefing.

// Whether the daily digest should run now: at/after `sendHour` (0–23, server-local) and not already run today.
export function shouldRunDigestNow(now: Date, sendHour: number, lastRunDate: string | null, todayStr: string): boolean {
  if (lastRunDate === todayStr) return false;
  return now.getHours() >= sendHour;
}
