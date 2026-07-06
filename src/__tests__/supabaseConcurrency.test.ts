import { describe, it, expect, vi, beforeEach } from 'vitest';

// The query builder resolves to whatever `result` is at await time; `calls` records what was sent.
let result: any = { data: [], error: null };
const calls: { update: any; upsert: any; eqs: [string, any][] } = { update: null, upsert: null, eqs: [] };

function makeBuilder() {
  const b: any = {
    select: vi.fn(() => b),
    update: vi.fn((p: any) => { calls.update = p; return b; }),
    upsert: vi.fn((p: any) => { calls.upsert = p; return b; }),
    eq: vi.fn((col: string, val: any) => { calls.eqs.push([col, val]); return b; }),
    then: (resolve: any) => resolve(result), // thenable → await resolves to `result`
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: vi.fn(() => makeBuilder()),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  }),
}));

import { loadHouseholdData, saveHouseholdData, setStaleWriteHandler } from '../supabase';

beforeEach(() => { result = { data: [], error: null }; calls.update = null; calls.upsert = null; calls.eqs = []; });

describe('optimistic concurrency (§5.3)', () => {
  it('caches each collection version on load, then a save compare-and-sets on that version', async () => {
    result = { data: [{ data_key: 'events', data: [1], updated_at: 'v1' }], error: null };
    await loadHouseholdData('hhA');
    result = { data: [{ updated_at: 'v2' }], error: null };
    await saveHouseholdData('hhA', 'events', [1, 2]);
    expect(calls.update).toMatchObject({ data: [1, 2] });           // it UPDATEd (not upsert)
    expect(calls.upsert).toBeNull();
    expect(calls.eqs).toContainEqual(['updated_at', 'v1']);          // gated on the loaded version
  });

  it('rejects + fires the stale handler when no row matches the expected version', async () => {
    result = { data: [{ data_key: 'events', data: [1], updated_at: 'v1' }], error: null };
    await loadHouseholdData('hhB');
    const onStale = vi.fn();
    setStaleWriteHandler(onStale);
    vi.useFakeTimers();
    result = { data: [], error: null }; // 0 rows updated → a concurrent write won
    await saveHouseholdData('hhB', 'events', [9]);
    vi.advanceTimersByTime(300);
    expect(onStale).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    setStaleWriteHandler(null);
  });

  it('debounces a BURST of stale rejects into ONE handler call (the toast/refresh contract)', async () => {
    result = { data: [{ data_key: 'events', data: [1], updated_at: 'v1' }], error: null };
    await loadHouseholdData('hhD');
    const onStale = vi.fn();
    setStaleWriteHandler(onStale);
    vi.useFakeTimers();
    result = { data: [], error: null }; // every write loses the CAS
    await saveHouseholdData('hhD', 'events', [2]);
    await saveHouseholdData('hhD', 'events', [3]);
    await saveHouseholdData('hhD', 'events', [4]);
    vi.advanceTimersByTime(300);
    expect(onStale).toHaveBeenCalledTimes(1); // one refresh + one toast for the burst, not three
    vi.useRealTimers();
    setStaleWriteHandler(null);
  });

  it('upserts (not compare-and-set) the first write of a never-loaded collection', async () => {
    result = { data: [{ updated_at: 'v1' }], error: null };
    await saveHouseholdData('hhC', 'newcol', [1]);
    expect(calls.upsert).toBeTruthy();
    expect(calls.update).toBeNull();
  });
});
