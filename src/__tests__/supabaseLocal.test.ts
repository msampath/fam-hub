// @vitest-environment jsdom
// Coverage for the LAN-appliance browser auth client (src/supabase.ts local-mode functions, ~41%). These are
// the client half of the box's auth: resolve the backend mode at boot, exchange a passphrase for a box-signed
// session, store/return it, and sign out without touching the (absent) Supabase client. Mocked fetch +
// jsdom localStorage — no real network/DB. The complementary server half is covered in serverAuth.test.ts.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fetchAuthStatus, getBackendMode, localSetup, localLogin, hasLocalSession, getAuthToken, signOut } from '../supabase';

const mockFetchOnce = (body: any, ok = true) => {
  (globalThis as any).fetch = vi.fn(async () => ({ ok, json: async () => body }));
};

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('supabase.ts — LAN appliance client (sqlite mode)', () => {
  it('fetchAuthStatus sets mode=sqlite and returns the box configured flag', async () => {
    mockFetchOnce({ mode: 'sqlite', configured: false });
    const status = await fetchAuthStatus();
    expect(status).toEqual({ mode: 'sqlite', configured: false });
    expect(getBackendMode()).toBe('sqlite');
  });

  it('fetchAuthStatus falls back to supabase mode if /api/auth/status throws (boot must not hard-fail)', async () => {
    (globalThis as any).fetch = vi.fn(async () => { throw new Error('network down'); });
    const status = await fetchAuthStatus();
    expect(status).toEqual({ mode: 'supabase', configured: true });
    expect(getBackendMode()).toBe('supabase');
  });

  it('localSetup stores the returned token; getAuthToken returns it in sqlite mode', async () => {
    mockFetchOnce({ mode: 'sqlite', configured: false });
    await fetchAuthStatus(); // → sqlite mode so getAuthToken takes the local branch

    mockFetchOnce({ token: 'box.session.jwt' });
    const res = await localSetup('family-secret');
    expect(res).toEqual({ ok: true });
    expect(hasLocalSession()).toBe(true);
    expect(await getAuthToken()).toBe('box.session.jwt');
  });

  it('localSetup surfaces a server error and stores no token', async () => {
    mockFetchOnce({ error: 'Passphrase must be 6–128 characters.' }, false);
    const res = await localSetup('short');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Passphrase/);
    expect(hasLocalSession()).toBe(false);
  });

  it('localLogin stores the token on success and clears it on signOut (sqlite mode, no Supabase touched)', async () => {
    mockFetchOnce({ mode: 'sqlite', configured: true });
    await fetchAuthStatus();

    mockFetchOnce({ token: 'login.jwt' });
    expect(await localLogin('family-secret')).toEqual({ ok: true });
    expect(hasLocalSession()).toBe(true);

    await signOut(); // sqlite branch returns before supabase.auth.signOut()
    expect(hasLocalSession()).toBe(false);
  });
});

describe('invite-code join gate (F-04 — format-validate before the RPC)', () => {
  it('isValidInviteCode accepts exactly the live 6-hex shape (case/space tolerant)', async () => {
    const { isValidInviteCode } = await import('../supabase');
    expect(isValidInviteCode('a1b2c3')).toBe(true);
    expect(isValidInviteCode('A1B2C3')).toBe(true);
    expect(isValidInviteCode('  a1b2c3  ')).toBe(true); // the RPC upper/trims too
    expect(isValidInviteCode('a1b2c')).toBe(false);     // too short
    expect(isValidInviteCode('a1b2c3d')).toBe(false);   // too long
    expect(isValidInviteCode('g1b2c3')).toBe(false);    // non-hex letter
    expect(isValidInviteCode("a1' or")).toBe(false);    // junk/probe
    expect(isValidInviteCode('')).toBe(false);
  });

  it('joinHousehold short-circuits a malformed code to false WITHOUT touching the Supabase client', async () => {
    // In this test env the module's `supabase` export is the throwing local-mode Proxy — so merely
    // reaching supabase.rpc would throw. Returning false proves the gate fired first.
    const { joinHousehold } = await import('../supabase');
    expect(await joinHousehold('user-1', 'not-a-code!')).toBe(false);
    expect(await joinHousehold('user-1', '')).toBe(false);
  });
});
