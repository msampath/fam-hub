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

// Open the Kroger OAuth popup and resolve with the refresh token once the callback page postMessages
// it back. The callback restricts its postMessage to this app's own origin; we additionally verify
// origin + the state nonce here. Rejects on user-close or timeout so the caller can surface an error.
export async function connectKroger(): Promise<void> {
  const res = await apiFetch('/api/kroger/auth-url');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.url) throw new Error(data?.error || 'Kroger connect is unavailable.');
  const expectedState: string = data.state;

  const popup = window.open(data.url, 'kroger-connect', 'width=520,height=680');
  if (!popup) throw new Error('Popup blocked — allow popups for this site and try again.');

  return new Promise<void>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; clearInterval(poll); window.removeEventListener('message', onMsg); fn(); };
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data;
      if (!d || d.source !== 'kroger-connect') return;
      if (d.state && expectedState && d.state !== expectedState) return finish(() => reject(new Error('Kroger sign-in state mismatch — try again.')));
      if (d.refreshToken) { setStoredKrogerToken(d.refreshToken); finish(resolve); }
    };
    window.addEventListener('message', onMsg);
    // If the user closes the popup without finishing, don't hang forever.
    const poll = setInterval(() => { if (popup.closed) finish(() => reject(new Error('Kroger sign-in was cancelled.'))); }, 700);
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
