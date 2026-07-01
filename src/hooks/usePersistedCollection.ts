import { useEffect, useRef } from 'react';
import type React from 'react';
import { saveHouseholdData } from '../supabase';

// Guarded read of a persisted array from localStorage: a corrupted/half-written `famplan_*` value used to
// throw inside a useState lazy initializer and WHITE-SCREEN the app on render. Returns [] on null/garbage.
export function safeParseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Persist one collection: localStorage cache always + Supabase when signed in (and not mid-initial-load).
// One hook call per collection replaces ~10 identical effects.
//
// `suppressSync` is a depth counter owned by the app shell (see useEchoWriteGuard): the cloud write is
// skipped while a load is in flight (suppressSync.current > 0), which prevents echo-writes / dropped writes.
//
// DEBOUNCE (§5.3): a burst of edits to the same collection (e.g. checking off several chores) used to fire one
// full-collection upsert PER change. We now coalesce them into ONE upsert after a short quiet period.
// localStorage stays immediate. The echo-guard is preserved precisely:
//   - The "local edit vs. pulled-data echo" decision is made SYNCHRONOUSLY at commit time (suppressSync check),
//     exactly as before — a change committed during a load never schedules a write.
//   - A write already pending from a real local edit is NOT cancelled by a load's value change; and if the
//     debounce timer fires while a load is in flight it RETRIES (never drops), so the edit lands once after
//     suppression releases (writing the merged latest value). No echo, no lost write.
const SAVE_DEBOUNCE_MS = 800;

export function usePersistedCollection(
  localKey: string,
  dataKey: string,
  value: any,
  householdId: string | null,
  suppressSync: React.MutableRefObject<number>,
) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  latest.current = value;
  // Latest write target, read by the timer/unmount-flush without going stale across renders.
  const target = useRef({ householdId, dataKey });
  target.current = { householdId, dataKey };

  useEffect(() => {
    localStorage.setItem(localKey, JSON.stringify(value)); // local cache: always immediate

    if (!householdId) {
      // Signed out / pre-load: nowhere to write — drop any pending cloud save.
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      return;
    }
    // Echo-guard: a value change while a load is suppressing writes is the PULLED data, not a local edit — do
    // not schedule a write for it. Do NOT clear a save already pending from a real edit (it must survive the
    // pull and fire after release, persisting the merged latest value).
    if (suppressSync.current > 0) return;

    if (timer.current) clearTimeout(timer.current); // coalesce: a newer edit reschedules
    const fire = () => {
      if (suppressSync.current > 0) { timer.current = setTimeout(fire, SAVE_DEBOUNCE_MS); return; } // load in flight → retry, don't drop
      timer.current = null;
      const t = target.current;
      if (t.householdId) saveHouseholdData(t.householdId, t.dataKey, latest.current);
    };
    timer.current = setTimeout(fire, SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, householdId]);

  // Flush a pending save on unmount (best-effort; localStorage already holds it).
  useEffect(() => () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    const t = target.current;
    if (t.householdId && suppressSync.current === 0) saveHouseholdData(t.householdId, t.dataKey, latest.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
