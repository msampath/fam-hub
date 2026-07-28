import { useEffect, useRef } from 'react';
import { toLocalDateStr } from '../utils/dates';
import { selectPushTargets, selectAutoPushEvents, shouldAutoPull } from '../utils/googleEvent';
import type { CalendarEvent, ConnectedCalendar, GoogleCalendarListEntry, HiddenEvent } from '../types';

export function useGoogleSync({
  email,
  appMode,
  connectedCalendars,
  googleCalendarsList,
  events,
  getGoogleToken,
  syncGoogleCalendars,
  pushEventToGoogleCalendars,
}: {
  email: string | undefined;
  appMode: string;
  connectedCalendars: ConnectedCalendar[];
  googleCalendarsList: GoogleCalendarListEntry[];
  events: CalendarEvent[];
  getGoogleToken: () => Promise<string | null>;
  syncGoogleCalendars: (tokenOverride?: string, connsOverride?: ConnectedCalendar[], hiddenOverride?: HiddenEvent[], pullOnly?: boolean) => Promise<void>;
  pushEventToGoogleCalendars: (ev: CalendarEvent, calendarIds: string[]) => Promise<string>;
}) {
  const autoPushInFlightRef = useRef(false);
  const pushFailuresRef = useRef(new Map<string, number>()); // per-event consecutive push failures
  useEffect(() => {
    if (!email || autoPushInFlightRef.current) return;
    const targets = selectPushTargets(connectedCalendars, googleCalendarsList, email);
    if (!targets.length) return;
    const key = `famplan_autopushed_${email}`;
    let pushed: string[] = [];
    try { pushed = JSON.parse(localStorage.getItem(key) || '[]'); } catch { pushed = []; }
    const now = new Date();
    const fromDate = toLocalDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const toDate = toLocalDateStr(new Date(now.getFullYear(), now.getMonth() + 5, 0));
    const toPush = selectAutoPushEvents(events, pushed, fromDate, toDate);
    if (!toPush.length) return;
    autoPushInFlightRef.current = true;
    (async () => {
      try {
        const token = await getGoogleToken();
        if (!token) return;
        const done = new Set(pushed);
        for (const ev of toPush) {
          // Give up on an event after 3 consecutive failures — a permanently-failing push otherwise
          // re-attempts on every effect re-run (each events change) forever, spamming the API.
          if ((pushFailuresRef.current.get(ev.id) || 0) >= 3) continue;
          try {
            await pushEventToGoogleCalendars(ev, targets);
            done.add(ev.id);
            pushFailuresRef.current.delete(ev.id);
          } catch {
            pushFailuresRef.current.set(ev.id, (pushFailuresRef.current.get(ev.id) || 0) + 1);
          }
        }
        try { localStorage.setItem(key, JSON.stringify([...done].slice(-1000))); } catch { /* non-fatal */ }
      } finally {
        autoPushInFlightRef.current = false;
      }
    })();
    // getGoogleToken/pushEventToGoogleCalendars are stable enough here (re-runs are driven by the
    // data deps); documented omission, matching the auto-pull effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email, connectedCalendars, googleCalendarsList, events]);

  const autoPullDoneRef = useRef(false);
  useEffect(() => {
    if (!shouldAutoPull({ backendMode: appMode, email, alreadyRan: autoPullDoneRef.current, connected: connectedCalendars })) return;
    autoPullDoneRef.current = true;
    (async () => {
      const token = await getGoogleToken();
      if (!token) return;
      await syncGoogleCalendars(token, undefined, undefined, true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode, email, connectedCalendars]);
}
