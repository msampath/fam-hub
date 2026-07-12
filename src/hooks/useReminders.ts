import { useEffect, useRef } from 'react';
import { toLocalDateStr } from '../utils/dates';
import { buildDailyReminder, shouldFireDailyReminder, dueEventReminders, type ReminderContent } from '../utils/reminders';
import type { CalendarEvent, Chore } from '../types';

function showReminderNotification(content: ReminderContent, tag: string) {
  const opts = { body: content.body, tag, icon: '/icon.svg', badge: '/icon.svg', renotify: true } as NotificationOptions;
  try {
    if ('serviceWorker' in navigator && navigator.serviceWorker?.ready) {
      navigator.serviceWorker.ready
        .then(reg => reg.showNotification(content.title, opts))
        .catch(() => { try { new Notification(content.title, opts); } catch { /* ignore */ } });
    } else {
      new Notification(content.title, opts);
    }
  } catch { /* notifications unsupported — ignore */ }
}

export function useReminders(
  events: CalendarEvent[],
  choresList: Chore[],
  remindersEnabled: boolean,
  reminderTime: number,
  reminderLeadMinutes: number,
) {
  const reminderFiredDateRef = useRef<string | null>(localStorage.getItem('famplan_reminder_lastfired'));
  const eventRemindersFiredRef = useRef<{ date: string; ids: Set<string> }>((() => {
    try {
      const raw = localStorage.getItem('famplan_event_reminders_fired');
      if (raw) { const p = JSON.parse(raw); return { date: p.date || '', ids: new Set<string>(p.ids || []) }; }
    } catch { /* ignore */ }
    return { date: '', ids: new Set<string>() };
  })());

  const reminderDataRef = useRef({ events, choresList });
  useEffect(() => { reminderDataRef.current = { events, choresList }; }, [events, choresList]);

  useEffect(() => {
    if (!remindersEnabled) return;
    const tick = () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = new Date();
      const today = toLocalDateStr(now);
      if (!shouldFireDailyReminder(now, reminderTime, reminderFiredDateRef.current, today)) return;
      const content = buildDailyReminder(reminderDataRef.current.events, reminderDataRef.current.choresList, today);
      if (!content) return;
      reminderFiredDateRef.current = today;
      localStorage.setItem('famplan_reminder_lastfired', today);
      // Tag includes the date: this fires at most once/day (guarded above), so same-day re-fires
      // legitimately collapse, but it never collides with a same-day event reminder's own tag below.
      showReminderNotification(content, `familyhub-daily-${today}`);
    };

    const tickEventReminders = () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = new Date();
      const today = toLocalDateStr(now);
      const fired = eventRemindersFiredRef.current;
      if (fired.date !== today) { fired.date = today; fired.ids = new Set(); }
      const due = dueEventReminders(reminderDataRef.current.events, today, now, reminderLeadMinutes, fired.ids);
      if (!due.length) return;
      // Tag per-event (d.id is `${dateStr}|${event.id}`, already unique per event/day) so two events
      // due close together don't collapse into a single visible notification (each fires at most once
      // per day via `fired`, so a legitimate same-event re-fire still collapses on its own tag).
      for (const d of due) { fired.ids.add(d.id); showReminderNotification({ title: d.title, body: d.body }, `familyhub-event-${d.id}`); }
      localStorage.setItem('famplan_event_reminders_fired', JSON.stringify({ date: fired.date, ids: [...fired.ids] }));
    };

    const runAll = () => { tick(); tickEventReminders(); };
    runAll();
    const iv = setInterval(runAll, 60 * 1000);
    return () => clearInterval(iv);
  }, [remindersEnabled, reminderTime, reminderLeadMinutes]);
}
