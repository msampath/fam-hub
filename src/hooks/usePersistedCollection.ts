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

// Collections whose serialized blob can reach multi-MB (the docs corpus is sized at up to ~4 MB): their
// synchronous localStorage stringify+write is DEBOUNCED on the same timer as the cloud save instead of
// running on every value identity change (each mutation AND each cloud-pull echo paid it on the main
// thread). Everything else keeps the immediate write (crash-safety for small collections is free).
const LARGE_LOCAL_KEYS = new Set(['famplan_documents', 'famplan_copilotlog']);

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

  const localDirty = useRef(false); // a large-key localStorage write is pending (debounced)
  const writeLocal = (v: any) => { try { localStorage.setItem(localKey, JSON.stringify(v)); } catch { /* quota — cloud copy still lands */ } };

  useEffect(() => {
    if (LARGE_LOCAL_KEYS.has(localKey)) {
      localDirty.current = true; // written by the debounce timer / flush below
    } else {
      writeLocal(value); // local cache: always immediate
    }

    if (!householdId) {
      // Signed out / pre-load: nowhere to write — drop any pending cloud save (but never a pending
      // LOCAL write for a large key: flush it now so the cache can't go stale on sign-out).
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (localDirty.current) { writeLocal(value); localDirty.current = false; }
      return;
    }
    // Echo-guard: a value change while a load is suppressing writes is the PULLED data, not a local edit — do
    // not schedule a write for it. Do NOT clear a save already pending from a real edit (it must survive the
    // pull and fire after release, persisting the merged latest value). Large keys still cache the pulled
    // value locally (debounced) — that's the read cache, not a cloud write.
    if (suppressSync.current > 0) {
      if (localDirty.current && !timer.current) {
        timer.current = setTimeout(() => { timer.current = null; if (localDirty.current) { writeLocal(latest.current); localDirty.current = false; } }, SAVE_DEBOUNCE_MS);
      }
      return;
    }

    if (timer.current) clearTimeout(timer.current); // coalesce: a newer edit reschedules
    const fire = () => {
      if (localDirty.current) { writeLocal(latest.current); localDirty.current = false; }
      if (suppressSync.current > 0) { timer.current = setTimeout(fire, SAVE_DEBOUNCE_MS); return; } // load in flight → retry, don't drop
      timer.current = null;
      const t = target.current;
      if (t.householdId) saveHouseholdData(t.householdId, t.dataKey, latest.current);
    };
    timer.current = setTimeout(fire, SAVE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, householdId]);

  // Flush a pending save on unmount (best-effort; localStorage already holds it for small keys).
  useEffect(() => () => {
    if (localDirty.current) { writeLocal(latest.current); localDirty.current = false; }
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    const t = target.current;
    if (t.householdId && suppressSync.current === 0) saveHouseholdData(t.householdId, t.dataKey, latest.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
