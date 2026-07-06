// @vitest-environment jsdom
// Exercises the connect flow's control logic against a mocked server + popup — the piece that was
// shipped UNTESTED and broke live (postMessage/localStorage popup handoff, replaced by server poll).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// apiFetch is the single seam to the server; mock it per-test to script /auth-url + /poll responses.
const apiFetch = vi.fn();
vi.mock('../supabase', () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { connectKroger, getStoredKrogerToken, setStoredKrogerToken, isKrogerConnected } from '../utils/krogerClient';

const json = (body: any, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });

let popup: { closed: boolean };
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  apiFetch.mockReset();
  popup = { closed: false };
  vi.stubGlobal('open', vi.fn(() => popup));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// Drive the fake-timer poll loop N ticks, flushing the awaits between each.
async function tick(n: number) { for (let i = 0; i < n; i++) { await vi.advanceTimersByTimeAsync(1000); } }

describe('connectKroger', () => {
  it('resolves and stores the token once the server poll returns it (opener/postMessage never used)', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/api/kroger/auth-url') return json({ url: 'https://api.kroger.com/authorize', state: 'ST8' });
      if (url.startsWith('/api/kroger/poll')) {
        expect(url).toContain('state=ST8');                 // the poll claims by the exact nonce
        return apiFetch.mock.calls.filter(c => String(c[0]).startsWith('/api/kroger/poll')).length >= 3
          ? json({ refreshToken: 'RT-live' })               // token lands on the 3rd poll
          : json({ pending: true });
      }
      return json({}, false);
    });

    const p = connectKroger();
    await tick(3);
    await expect(p).resolves.toBeUndefined();
    expect(getStoredKrogerToken()).toBe('RT-live');
    expect(isKrogerConnected()).toBe(true);
  });

  it('rejects as cancelled when the popup closes and no token ever arrives (after the grace window)', async () => {
    apiFetch.mockImplementation((url: string) =>
      url === '/api/kroger/auth-url' ? json({ url: 'x', state: 'ST9' }) : json({ pending: true }));
    const p = connectKroger();
    const assertion = expect(p).rejects.toThrow(/cancelled/i);
    popup.closed = true;         // user closes the popup without finishing
    await tick(4);               // 3s grace + a tick
    await assertion;
    expect(isKrogerConnected()).toBe(false);
  });

  it('accepts the postMessage fast-path token when the browser DID keep the opener', async () => {
    apiFetch.mockImplementation((url: string) =>
      url === '/api/kroger/auth-url' ? json({ url: 'x', state: 'STfast' }) : json({ pending: true }));
    const p = connectKroger();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { source: 'kroger-connect', refreshToken: 'RT-fast', state: 'STfast' } }));
    await expect(p).resolves.toBeUndefined();
    expect(getStoredKrogerToken()).toBe('RT-fast');
  });

  it('ignores postMessages from a foreign origin or wrong state', async () => {
    apiFetch.mockImplementation((url: string) =>
      url === '/api/kroger/auth-url' ? json({ url: 'x', state: 'STx' }) : json({ pending: true }));
    const p = connectKroger();
    await vi.advanceTimersByTimeAsync(0);
    const assertion = expect(p).rejects.toThrow(/cancelled/i);   // attach BEFORE the reject can fire
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', data: { source: 'kroger-connect', refreshToken: 'RT-evil', state: 'STx' } }));
    window.dispatchEvent(new MessageEvent('message', { origin: window.location.origin, data: { source: 'kroger-connect', refreshToken: 'RT-wrong', state: 'NOPE' } }));
    await tick(1);
    expect(getStoredKrogerToken()).toBeNull();
    popup.closed = true; await tick(4);
    await assertion;
  });

  it('surfaces a blocked popup', async () => {
    apiFetch.mockImplementation(() => json({ url: 'x', state: 'S' }));
    vi.stubGlobal('open', vi.fn(() => null));
    await expect(connectKroger()).rejects.toThrow(/popup blocked/i);
  });
});

describe('token storage', () => {
  it('round-trips + clears', () => {
    setStoredKrogerToken('t'); expect(isKrogerConnected()).toBe(true);
    setStoredKrogerToken(null); expect(getStoredKrogerToken()).toBeNull();
  });
});
