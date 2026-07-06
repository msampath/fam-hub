// @vitest-environment jsdom
// Multi-tab chore-reset guard (W8): localStorage read-then-stamp as a same-browser compare-and-set —
// exactly one "tab" (caller) may persist a given rollover; a new day/week marker re-opens the lock.
import { describe, it, expect, beforeEach } from 'vitest';
import { acquireResetLock } from '../utils/chores';

const KEY = 'famplan_choreResetDone';

describe('acquireResetLock', () => {
  beforeEach(() => localStorage.clear());

  it('first claim wins; a repeat claim for the SAME rollover marker is refused', () => {
    expect(acquireResetLock(KEY, '2026-W28:2026-07-06')).toBe(true);
    expect(acquireResetLock(KEY, '2026-W28:2026-07-06')).toBe(false); // the sibling tab
    expect(localStorage.getItem(KEY)).toBe('2026-W28:2026-07-06');
  });

  it('a NEW rollover marker (next day / next week) re-opens the lock', () => {
    expect(acquireResetLock(KEY, '2026-W28:2026-07-06')).toBe(true);
    expect(acquireResetLock(KEY, '2026-W28:2026-07-07')).toBe(true);  // day rolled
    expect(acquireResetLock(KEY, '2026-W29:2026-07-13')).toBe(true);  // week rolled
    expect(acquireResetLock(KEY, '2026-W29:2026-07-13')).toBe(false); // same-marker repeat still refused
  });

  it('claims the lock when storage is unavailable (cloud CAS remains the next wall)', () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error('quota'); };
    try {
      expect(acquireResetLock(KEY, 'x')).toBe(true);
    } finally {
      Storage.prototype.getItem = orig;
    }
  });
});
