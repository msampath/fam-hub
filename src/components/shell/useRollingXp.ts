import { useEffect, useRef, useState } from 'react';

// Animated XP counters (spec §8). Given a map of {name → target XP}, returns a map of currently-
// displayed values that roll toward their targets with an ease-out cubic over `durationMs`. Re-runs
// only when a target value actually changes (compared by serialized values), so switching the
// visible kid doesn't re-trigger a roll — the settled value just shows. Cancels RAF on unmount.
export function useRollingXp(targets: Record<string, number>, durationMs = 550): Record<string, number> {
  const [display, setDisplay] = useState<Record<string, number>>(targets);
  const displayRef = useRef<Record<string, number>>(targets);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const rafRef = useRef<number | null>(null);
  const key = JSON.stringify(targets);

  useEffect(() => {
    const from = { ...displayRef.current };
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      const next: Record<string, number> = {};
      for (const k of Object.keys(targetsRef.current)) {
        const f = from[k] ?? 0;
        next[k] = Math.round(f + ((targetsRef.current[k] ?? 0) - f) * eased);
      }
      displayRef.current = next;
      setDisplay(next);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [key, durationMs]);

  return display;
}
