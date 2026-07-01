import { useEffect, useRef, useState } from 'react';
import type React from 'react';

// Echo-write guard for the cloud-sync persistence layer.
//
// `suppressSync` is a DEPTH COUNTER (not a boolean) so overlapping flows (bootstrap + screensaver-wake
// refresh + join) COMPOSE: suppression holds until the LAST outstanding load finishes, instead of one
// flow un-suppressing another mid-load (which caused echo-writes / dropped writes). Every flow does
// beginLoad() then endLoad().
//
// Release is DETERMINISTIC (not a setTimeout(0) race): endLoad() queues a decrement and bumps
// loadEpoch; the release effect (useEchoWriteRelease) runs LAST in the commit because the caller
// declares it after every usePersistedCollection() hook — React runs effects in declaration order, so
// every persist effect sees suppressSync > 0 first. The counter drains all queued decrements when
// several endLoad() calls batch into one render.
export interface EchoWriteGuard {
  suppressSync: React.MutableRefObject<number>;
  beginLoad: () => void;
  endLoad: () => void;
  loadEpoch: number;
  pendingReleases: React.MutableRefObject<number>;
}

export function useEchoWriteGuard(): EchoWriteGuard {
  const suppressSync = useRef(0);
  const pendingReleases = useRef(0);
  const [loadEpoch, setLoadEpoch] = useState(0);
  const beginLoad = () => { suppressSync.current++; };
  const endLoad = () => { pendingReleases.current++; setLoadEpoch(e => e + 1); };
  return { suppressSync, beginLoad, endLoad, loadEpoch, pendingReleases };
}

// Drains the decrements endLoad() queued, re-enabling cloud writes only once this load's persist
// effects have already run (and been suppressed). CONTRACT: call this LAST in the component — after
// every usePersistedCollection() — so it is the last effect declared in the commit.
export function useEchoWriteRelease(g: EchoWriteGuard) {
  useEffect(() => {
    if (g.pendingReleases.current > 0) {
      g.suppressSync.current = Math.max(0, g.suppressSync.current - g.pendingReleases.current);
      g.pendingReleases.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [g.loadEpoch]);
}
