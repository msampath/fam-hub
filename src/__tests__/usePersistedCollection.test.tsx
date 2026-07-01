// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { usePersistedCollection } from '../hooks/usePersistedCollection';

const saveHouseholdData = vi.fn();
vi.mock('../supabase', () => ({ saveHouseholdData: (...a: any[]) => saveHouseholdData(...a) }));

const setup = (initial: any, householdId: string | null = 'hh1', suppressInitial = 0) => {
  const suppress = { current: suppressInitial };
  const view = renderHook(
    ({ value, hid }) => usePersistedCollection('lk', 'events', value, hid, suppress as any),
    { initialProps: { value: initial, hid: householdId } },
  );
  return { ...view, suppress };
};

describe('usePersistedCollection — debounced save (§5.3) preserving the echo-guard', () => {
  beforeEach(() => { vi.useFakeTimers(); saveHouseholdData.mockClear(); localStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes localStorage immediately on every change', () => {
    const { rerender } = setup([1]);
    expect(JSON.parse(localStorage.getItem('lk')!)).toEqual([1]);
    rerender({ value: [1, 2], hid: 'hh1' });
    expect(JSON.parse(localStorage.getItem('lk')!)).toEqual([1, 2]);
  });

  it('coalesces a burst of edits into ONE cloud save (latest value) after the quiet window', () => {
    const { rerender } = setup([1]);
    rerender({ value: [1, 2], hid: 'hh1' });
    rerender({ value: [1, 2, 3], hid: 'hh1' });
    expect(saveHouseholdData).not.toHaveBeenCalled(); // still debouncing
    vi.advanceTimersByTime(800);
    expect(saveHouseholdData).toHaveBeenCalledTimes(1);
    expect(saveHouseholdData).toHaveBeenCalledWith('hh1', 'events', [1, 2, 3]);
  });

  it('never schedules a write for a change committed while a load suppresses writes (echo-guard)', () => {
    const { rerender } = setup([1], 'hh1', 1); // suppress active from the start → no initial schedule
    rerender({ value: [1, 'pulled'], hid: 'hh1' });
    vi.advanceTimersByTime(2000);
    expect(saveHouseholdData).not.toHaveBeenCalled();
  });

  it('retries a pending local-edit save through a load, then writes the merged latest value once', () => {
    const { rerender, suppress } = setup([1]);
    rerender({ value: [1, 2], hid: 'hh1' }); // local edit → schedule
    suppress.current = 1;                      // a load begins mid-debounce
    rerender({ value: [1, 2, 'merged'], hid: 'hh1' }); // pull merges in; effect sees suppress>0, must NOT cancel
    vi.advanceTimersByTime(800);               // timer fires while suppressed → retry, do NOT write
    expect(saveHouseholdData).not.toHaveBeenCalled();
    suppress.current = 0;                      // load releases
    vi.advanceTimersByTime(800);               // retry fires → writes the latest (merged) value
    expect(saveHouseholdData).toHaveBeenCalledTimes(1);
    expect(saveHouseholdData).toHaveBeenCalledWith('hh1', 'events', [1, 2, 'merged']);
  });

  it('does not write to the cloud when signed out (no household)', () => {
    const { rerender } = setup([1], null);
    rerender({ value: [1, 2], hid: null });
    vi.advanceTimersByTime(2000);
    expect(saveHouseholdData).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('lk')!)).toEqual([1, 2]); // local cache still works
  });
});
