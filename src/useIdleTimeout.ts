import { useEffect, useRef } from 'react';

// User-activity events that count as "not idle".
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel'] as const;

/** Default idle window: 30 minutes. */
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Pure: has the session been idle at least `timeoutMs`? (extracted for unit testing) */
export function isIdle(lastActivityMs: number, nowMs: number, timeoutMs: number): boolean {
  return nowMs - lastActivityMs >= timeoutMs;
}

/**
 * Fire `onIdle` once after `timeoutMs` of no user activity. No-op while `enabled` is false
 * (signed out, already locked, or "Off"). Activity (mouse/keyboard/touch/scroll) resets the
 * timer; a tab hidden longer than the window is treated as idle on return. Uses a coarse
 * interval check rather than resetting a timer on every event (cheap, robust). Fires at most
 * once per enabled period — the caller decides what idle means (here: lock the screen).
 */
export function useIdleTimeout(enabled: boolean, onIdle: () => void, timeoutMs: number = IDLE_TIMEOUT_MS): void {
  const lastActivity = useRef(Date.now());
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const firedRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    lastActivity.current = Date.now();
    firedRef.current = false;

    const mark = () => { lastActivity.current = Date.now(); };
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, mark, { passive: true }));

    const fireIfIdle = () => {
      if (firedRef.current) return;
      if (isIdle(lastActivity.current, Date.now(), timeoutMs)) {
        firedRef.current = true;
        onIdleRef.current();
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') fireIfIdle();
    };
    document.addEventListener('visibilitychange', onVisible);

    const interval = setInterval(fireIfIdle, 30 * 1000);

    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, mark));
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, [enabled, timeoutMs]);
}
