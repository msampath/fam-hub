// Client-side Kroger helpers: per-device refresh-token storage + the connect popup + the API calls
// the Manage panel and Shopping cart flow use. Mirrors the Google-refresh-token precedent in
// supabase.ts — the OAuth refresh token is a per-DEVICE secret in localStorage, never in the shared
// household settings blob. All network calls go through apiFetch (attaches the app session JWT).
import { apiFetch } from '../supabase';
import type { KrogerStore, MatchResult } from './krogerApi';

const KROGER_REFRESH_KEY = 'famplan_kroger_refresh';

export const getStoredKrogerToken = (): string | null => localStorage.getItem(KROGER_REFRESH_KEY);
export const setStoredKrogerToken = (token: string | null | undefined): void => {
  if (token) localStorage.setItem(KROGER_REFRESH_KEY, token);
  else localStorage.removeItem(KROGER_REFRESH_KEY);
};
export const isKrogerConnected = (): boolean => !!getStoredKrogerToken();

// Open the Kroger OAuth popup, then claim the refresh token from the SERVER (the callback stashed it
// keyed by the state nonce) via /api/kroger/poll. This is browser-proof — no reliance on window.opener,
// postMessage, shared localStorage, or window.close, all of which COOP / privacy extensions / cross-
// origin popups can break. postMessage is kept only as an optional fast path. Rejects on cancel/timeout.
export async function connectKroger(): Promise<void> {
  const res = await apiFetch('/api/kroger/auth-url');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) throw new Error(data?.error || 'Kroger connect is unavailable.');
  const expectedState: string = data.state;

  const popup = window.open(data.url, 'kroger-connect', 'width=520,height=680');
  if (!popup) throw new Error('Popup blocked — allow popups for this site and try again.');

  return new Promise<void>((resolve, reject) => {
    let done = false;
    let ticking = false;      // re-entrancy guard for the async poll
    let closedFor = 0;        // ms the popup has been closed without the token landing yet
    const started = Date.now();
    const finish = (fn: () => void) => { if (done) return; done = true; clearInterval(timer); window.removeEventListener('message', onMsg); fn(); };
    const accept = (token: string) => { setStoredKrogerToken(token); finish(resolve); };

    // Optional fast path (works when the browser DIDN'T sever the opener).
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (d?.source === 'kroger-connect' && d.refreshToken && (!d.state || !expectedState || d.state === expectedState)) accept(d.refreshToken);
    };
    window.addEventListener('message', onMsg);

    // Primary path: poll the server for the token the callback stashed under this state.
    const timer = setInterval(async () => {
      if (ticking || done) return;
      ticking = true;
      try {
        const r = await apiFetch(`/api/kroger/poll?state=${encodeURIComponent(expectedState)}`);
        if (r.ok) { const d = await r.json().catch(() => ({})); if (d?.refreshToken) return accept(d.refreshToken); }
      } catch { /* transient — keep polling */ }
      finally { ticking = false; }
      // The callback fires just as the popup closes; give the token a 3s grace window to arrive before
      // calling it a cancel. And cap the whole flow at 3 minutes.
      if (popup.closed) { closedFor += 1000; if (closedFor >= 3000) finish(() => reject(new Error('Kroger sign-in was cancelled.'))); }
      if (Date.now() - started > 180000) finish(() => reject(new Error('Kroger sign-in timed out — try again.')));
    }, 1000);
  });
}

export function disconnectKroger(): void { setStoredKrogerToken(null); }

export async function fetchKrogerStores(lat: number, lng: number): Promise<KrogerStore[]> {
  const res = await apiFetch(`/api/kroger/locations?lat=${lat}&lng=${lng}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Could not look up stores.');
  return (data.stores || []) as KrogerStore[];
}

export async function matchKrogerItems(items: string[], locationId: string): Promise<MatchResult> {
  const res = await apiFetch('/api/kroger/match', { method: 'POST', body: JSON.stringify({ items, locationId }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Product matching failed.');
  return data as MatchResult;
}

// Approve-time cart write. Returns the count added; rotates the stored refresh token if Kroger issues
// a new one. Throws with a user-facing message on failure so the ledger entry can stay pending.
export async function krogerCartAdd(items: { upc: string; quantity?: number }[]): Promise<number> {
  const refreshToken = getStoredKrogerToken();
  if (!refreshToken) throw new Error('Kroger is not connected on this device.');
  const res = await apiFetch('/api/kroger/cart-add', { method: 'POST', body: JSON.stringify({ items, refreshToken }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 400) setStoredKrogerToken(null); // expired/invalid — force a reconnect
    throw new Error(data?.error || 'Cart update failed.');
  }
  if (data.refreshToken) setStoredKrogerToken(data.refreshToken);
  return Number(data.added || 0);
}
