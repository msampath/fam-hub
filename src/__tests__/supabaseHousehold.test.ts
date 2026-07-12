// Coverage for the household-creation / invite-code RPC client functions (src/supabase.ts) added by the
// F-04 §5 hardening: createHousehold() replaces the old direct household_members INSERT (denied by the
// migration's new RLS policy) with a SECURITY DEFINER RPC; getOrCreateHousehold falls through to it on a
// user's first sign-in; regenerateInviteCode mints a fresh CSPRNG code (§5c). Mocked Supabase client — no
// real network/DB, mirrors supabaseConcurrency.test.ts's builder pattern extended with an `rpc` mock.
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rpcResult: any = { data: null, error: null };
let membershipRows: any[] = [];
const rpcCalls: { name: string; args: any }[] = [];

function makeBuilder() {
  const b: any = {
    select: vi.fn(() => b),
    order: vi.fn(() => b),
    limit: vi.fn(() => Promise.resolve({ data: membershipRows, error: null })),
    eq: vi.fn(() => b),
  };
  return b;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: vi.fn(() => makeBuilder()),
    rpc: vi.fn((name: string, args?: any) => { rpcCalls.push({ name, args }); return Promise.resolve(rpcResult); }),
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  }),
}));

import { createHousehold, getOrCreateHousehold, regenerateInviteCode } from '../supabase';

beforeEach(() => {
  rpcResult = { data: null, error: null };
  membershipRows = [];
  rpcCalls.length = 0;
});

describe('createHousehold (F-04 §5a — SECURITY DEFINER RPC replaces the direct membership insert)', () => {
  it('calls the create_household RPC and returns the new household id', async () => {
    rpcResult = { data: 'hh-new-1', error: null };
    const id = await createHousehold();
    expect(id).toBe('hh-new-1');
    expect(rpcCalls).toEqual([{ name: 'create_household', args: undefined }]);
  });

  it('throws when the RPC errors', async () => {
    rpcResult = { data: null, error: { message: 'not authenticated' } };
    await expect(createHousehold()).rejects.toThrow(/Failed to create household/);
  });

  it('throws when the RPC returns no id (e.g. unauthenticated → null)', async () => {
    rpcResult = { data: null, error: null };
    await expect(createHousehold()).rejects.toThrow(/Failed to create household/);
  });
});

describe('getOrCreateHousehold', () => {
  it('returns the existing membership without calling the RPC', async () => {
    membershipRows = [{ household_id: 'hh-existing' }];
    const id = await getOrCreateHousehold('user-1');
    expect(id).toBe('hh-existing');
    expect(rpcCalls).toEqual([]);
  });

  it('falls through to createHousehold (the RPC) when the user has no membership', async () => {
    membershipRows = [];
    rpcResult = { data: 'hh-brand-new', error: null };
    const id = await getOrCreateHousehold('user-2');
    expect(id).toBe('hh-brand-new');
    expect(rpcCalls).toEqual([{ name: 'create_household', args: undefined }]);
  });
});

describe('regenerateInviteCode (F-04 §5c — mint a fresh CSPRNG code, old one stops working)', () => {
  it('returns the fresh code from the RPC', async () => {
    rpcResult = { data: 'FEEDFACE01234567', error: null };
    expect(await regenerateInviteCode()).toBe('FEEDFACE01234567');
    expect(rpcCalls).toEqual([{ name: 'regenerate_invite_code', args: undefined }]);
  });

  it('returns null (not throw) on an RPC error — unauthenticated/no-household is not a crash', async () => {
    rpcResult = { data: null, error: { message: 'not authenticated' } };
    expect(await regenerateInviteCode()).toBeNull();
  });
});
