import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { User } from '@supabase/supabase-js';
import { familyDataRow, FAMILY_DATA_CONFLICT } from './utils/familyData';

// Runtime config (injected into index.html by the server as window.__APP_CONFIG__) wins, so one built image
// runs against any backend; fall back to the build-time VITE_* vars in dev (vite serves index.html directly,
// no injection).
const runtimeCfg = (typeof window !== 'undefined' && (window as any).__APP_CONFIG__) || {};
const supabaseUrl = (runtimeCfg.supabaseUrl || import.meta.env.VITE_SUPABASE_URL || '') as string;
const supabaseAnonKey = (runtimeCfg.supabaseAnonKey || import.meta.env.VITE_SUPABASE_ANON_KEY || '') as string;

// The browser only talks to Supabase in CLOUD mode; the local SQLite appliance routes data + auth through
// Express and never touches this client. @supabase/supabase-js now THROWS on an empty URL at construction —
// so building it unconditionally would crash the whole bundle (blank screen) on the box. Build the real client
// only when configured; otherwise a lazy stub that errors loudly IF it's ever (mis)used. Every supabase.* call
// site is mode-guarded, so the stub is never reached in local mode.
export const supabase: SupabaseClient = supabaseUrl
  ? createClient(supabaseUrl, supabaseAnonKey)
  : new Proxy({} as SupabaseClient, {
      get() { throw new Error('Supabase is unavailable in local SQLite mode — data and auth go through Express.'); },
    });

export type { User };

// ── Backend mode: cloud Supabase (default) vs the local SQLite LAN appliance ──────
// The box reports which at boot via /api/auth/status. Until known we default to 'supabase' so the existing
// cloud path is unchanged; a box running STORAGE=sqlite reports 'sqlite' and the data/auth calls below switch
// to the local Express endpoints (no Supabase). Cloud builds simply never flip the mode.
export type BackendMode = 'supabase' | 'sqlite';
let _mode: BackendMode = 'supabase';
export const getBackendMode = (): BackendMode => _mode;

const LOCAL_SESSION_KEY = 'famhub_local_session';
const getLocalToken = (): string | null => localStorage.getItem(LOCAL_SESSION_KEY);
const setLocalToken = (t: string | null): void => {
  if (t) localStorage.setItem(LOCAL_SESSION_KEY, t); else localStorage.removeItem(LOCAL_SESSION_KEY);
};
export const hasLocalSession = (): boolean => !!getLocalToken();

export interface AuthStatus { mode: BackendMode; configured: boolean }
/** Ask the box which backend it runs (+ whether local-mode first-run setup is still needed). Sets the mode. */
export const fetchAuthStatus = async (): Promise<AuthStatus> => {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json().catch(() => ({} as any));
    _mode = data?.mode === 'sqlite' ? 'sqlite' : 'supabase';
    return { mode: _mode, configured: data?.configured !== false };
  } catch {
    _mode = 'supabase';
    return { mode: 'supabase', configured: true };
  }
};

// Local-appliance auth: first-run setup / login exchange a household passphrase for a box-signed session.
export const localSetup = async (passphrase: string): Promise<{ ok: boolean; error?: string }> => {
  const res = await fetch('/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) return { ok: false, error: data?.error || 'Setup failed.' };
  setLocalToken(data.token);
  return { ok: true };
};
export const localLogin = async (passphrase: string): Promise<{ ok: boolean; error?: string }> => {
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase }) });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) return { ok: false, error: data?.error || 'Login failed.' };
  setLocalToken(data.token);
  return { ok: true };
};
// Change the household passphrase (local appliance): the server rotates the session secret (invalidating every
// outstanding token) and returns a fresh one, which we adopt so THIS device stays signed in.
export const localChangePassphrase = async (oldPassphrase: string, newPassphrase: string): Promise<{ ok: boolean; error?: string }> => {
  const token = getLocalToken();
  const res = await fetch('/api/auth/change-passphrase', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ oldPassphrase, newPassphrase }),
  });
  const data = await res.json().catch(() => ({} as any));
  if (!res.ok) return { ok: false, error: data?.error || 'Could not change the passphrase.' };
  setLocalToken(data.token); // adopt the fresh token (the old one no longer verifies)
  return { ok: true };
};

// ── Auth ────────────────────────────────────────────────────────────────────

export const signInWithGoogle = () =>
  supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      // gmail.readonly powers the concierge bill/package scan (B1/B2). It's a RESTRICTED scope — fine
      // for this personal app in Google "Testing" mode (no verification; weekly token refresh). The
      // server only ever queries Gmail with a tight bill/shipment filter and stores parsed fields, not bodies.
      scopes: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.readonly',
      // Supabase validates this against Auth → URL Configuration → Redirect URLs and
      // falls back to the Site URL (localhost) on ANY mismatch. window.location.origin
      // has NO trailing slash, so the reliable fix is to add the exact slash-less
      // origin to that list — an exact string match beats a "<origin>/**" glob, which
      // does not reliably match a path-less origin.
      redirectTo: window.location.origin,
      queryParams: { access_type: 'offline', prompt: 'consent' },
    },
  });

// Mode-guarded like getAuthToken below: on the local SQLite appliance there's no Supabase (`supabase` is a
// throwing Proxy), so touching supabase.auth would throw and strand the user mid-sign-out (the App.tsx reset
// block + idle auto-logout never run). Clearing the box token IS the local sign-out.
export const signOut = async () => { dataVersions.clear(); setLocalToken(null); if (_mode === 'sqlite') return; await supabase.auth.signOut(); };

// Supabase only returns provider_token/provider_refresh_token right after the OAuth
// redirect — they are NOT persisted across reloads. We stash the refresh token
// (per-device, per-user) so we can mint a fresh access token via the server later.
const GOOGLE_REFRESH_KEY = 'famplan_google_refresh';

/** Persist (or clear) the Google refresh token for this device. */
export const setStoredGoogleRefreshToken = (token: string | null | undefined): void => {
  if (token) localStorage.setItem(GOOGLE_REFRESH_KEY, token);
  else localStorage.removeItem(GOOGLE_REFRESH_KEY);
};

/** Returns the Supabase access token (JWT) for authenticating calls to our API. */
export const getAuthToken = async (): Promise<string | null> => {
  if (_mode === 'sqlite') return getLocalToken(); // local appliance: the box-signed household session
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? null;
};

/** fetch() wrapper that attaches the Supabase bearer token to /api requests. */
export const apiFetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
  const token = await getAuthToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
};

// ── Step-up PIN (concierge high-risk gate) ── The server hashes/verifies; the client never holds the
// raw PIN. setStepUpPin returns {hash,salt} for the caller to persist in the household settings blob.
export const setStepUpPin = async (pin: string): Promise<{ hash: string; salt: string }> => {
  const res = await apiFetch('/api/stepup/set', { method: 'POST', body: JSON.stringify({ pin }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || 'Could not set the PIN.');
  return data as { hash: string; salt: string };
};
export const verifyStepUpPin = async (pin: string, hash: string, salt: string): Promise<boolean> => {
  const res = await apiFetch('/api/stepup/verify', { method: 'POST', body: JSON.stringify({ pin, hash, salt }) });
  if (!res.ok) return false;
  const data = await res.json().catch(() => ({}));
  return !!data?.valid;
};

/**
 * Returns a usable Google OAuth access token.
 * Uses the live session token when present (right after sign-in), otherwise
 * exchanges the stored refresh token for a fresh one via our server endpoint.
 */
export const getGoogleToken = async (): Promise<string | null> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.provider_token) return session.provider_token;

  const refreshToken = localStorage.getItem(GOOGLE_REFRESH_KEY);
  if (!refreshToken) return null;
  try {
    const res = await apiFetch('/api/google-refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.accessToken ?? null;
  } catch {
    return null;
  }
};

// ── Household management ─────────────────────────────────────────────────────

/**
 * Returns the household ID the user belongs to.
 * Auto-creates a new household on first sign-in.
 */
export const getOrCreateHousehold = async (userId: string): Promise<string> => {
  // Take the OLDEST existing membership. (Was `.maybeSingle()`, which ERRORS when a user has >1
  // membership row — the caller read that error as "no household" and created a BRAND-NEW one on
  // every sign-in, so a single early duplicate snowballed into dozens of empty households. `.limit(1)`
  // never errors on multiples; ordering by joined_at keeps us on the original/data household.)
  const { data: memberships, error: readErr } = await supabase
    .from('household_members')
    .select('household_id')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true })
    .limit(1);

  if (readErr) throw new Error('Failed to read household membership: ' + readErr.message);
  if (memberships && memberships.length > 0) return memberships[0].household_id;

  const { data: household, error } = await supabase
    .from('households')
    .insert({ owner_id: userId })
    .select('id')
    .single();

  if (error || !household) throw new Error('Failed to create household: ' + error?.message);

  await supabase.from('household_members').insert({ user_id: userId, household_id: household.id });

  return household.id;
};

/**
 * Joins a household via invite code, leaving any existing household.
 * Returns true on success, false if invite code not found.
 */
export const joinHousehold = async (_userId: string, inviteCode: string): Promise<boolean> => {
  // Must go through the SECURITY DEFINER RPC: a non-member can't SELECT a household by invite code
  // (RLS hides it), so the client-side select/insert dance always failed with "code not found".
  // The function validates the code + re-points THIS user's membership server-side (scoped to
  // auth.uid()); returns the household id (uuid) on success, or null for a bad code. `_userId` is
  // kept for call-site compatibility but unused — the server derives identity from auth.uid().
  const { data, error } = await supabase.rpc('join_household_by_code', { code: inviteCode.trim() });
  if (error) {
    console.error('joinHousehold RPC error:', error.message);
    return false;
  }
  return !!data;
};

/** Returns the shareable 6-character invite code for a household. */
export const getInviteCode = async (householdId: string): Promise<string | null> => {
  const { data } = await supabase
    .from('households')
    .select('invite_code')
    .eq('id', householdId)
    .single();
  return data?.invite_code ?? null;
};

// ── Data sync ─────────────────────────────────────────────────────────────────

// ── Optimistic concurrency (§5.3) ───────────────────────────────────────────────
// `family_data.updated_at` is the per-(household, collection) version token. We cache the value seen on the
// last load/save and write with a COMPARE-AND-SET (update ... WHERE updated_at = expected). If it no longer
// matches, another device / the agent wrote since we loaded — so we REJECT our (stale) write instead of
// silently clobbering theirs, and trigger a refresh so this device converges to the latest. (Works on the
// existing column; an optional DB trigger making updated_at server-set hardens it against client clock skew.)
const dataVersions = new Map<string, string>();
const vKey = (householdId: string, key: string) => `${householdId}:${key}`;

let onStaleWrite: (() => void) | null = null;
/** App registers refreshHouseholdData here; it runs when a write is rejected as stale. */
export const setStaleWriteHandler = (fn: (() => void) | null): void => { onStaleWrite = fn; };
let staleTimer: ReturnType<typeof setTimeout> | null = null;
const fireStaleRefresh = (): void => { // debounce: a burst of stale writes → one refresh
  if (staleTimer) return;
  staleTimer = setTimeout(() => { staleTimer = null; onStaleWrite?.(); }, 300);
};

/** Loads all family data collections for a household (and caches each collection's version token). */
export const loadHouseholdData = async (householdId: string): Promise<Record<string, any[]>> => {
  if (_mode === 'sqlite') return loadHouseholdDataLocal(householdId);
  const { data, error } = await supabase
    .from('family_data')
    .select('data_key, data, updated_at')
    .eq('household_id', householdId);

  if (error) throw error;
  const out: Record<string, any[]> = {};
  for (const row of data ?? []) {
    out[row.data_key] = row.data;
    if (row.updated_at) dataVersions.set(vKey(householdId, row.data_key), row.updated_at);
  }
  return out;
};

// Local appliance: one bulk GET to the box (server derives the household from the session, so the passed
// householdId is only this device's version-cache key). Mirrors the Supabase load's version caching.
async function loadHouseholdDataLocal(householdId: string): Promise<Record<string, any[]>> {
  const res = await apiFetch('/api/data');
  if (!res.ok) throw new Error(`Local data load failed (${res.status}).`);
  const { collections, versions } = await res.json().catch(() => ({} as any));
  for (const [k, v] of Object.entries((versions || {}) as Record<string, string>)) dataVersions.set(vKey(householdId, k), v);
  return (collections || {}) as Record<string, any[]>;
}

/**
 * Persists a single data collection (e.g. 'events', 'chores') to Supabase with optimistic concurrency.
 * Fire-and-forget — errors are logged but do not interrupt the UI. A stale write is rejected (not applied)
 * and triggers a convergence refresh rather than overwriting a concurrent writer.
 */
export const saveHouseholdData = async (
  householdId: string,
  key: string,
  data: any[],
): Promise<void> => {
  if (_mode === 'sqlite') return saveHouseholdDataLocal(householdId, key, data);
  const expected = dataVersions.get(vKey(householdId, key));
  if (expected) {
    // Compare-and-set: overwrite only if our loaded version is still current.
    const { data: rows, error } = await supabase
      .from('family_data')
      .update({ data, updated_at: new Date().toISOString() })
      .eq('household_id', householdId).eq('data_key', key).eq('updated_at', expected)
      .select('updated_at');
    if (error) { console.error(`Supabase sync failed for "${key}":`, error.message); return; }
    if (rows && rows.length) { dataVersions.set(vKey(householdId, key), rows[0].updated_at); return; }
    // Nothing matched our version → a concurrent write landed first. Don't clobber it; converge instead.
    console.warn(`[sync] stale write for "${key}" — another writer was ahead; refreshing to the latest.`);
    fireStaleRefresh();
    return;
  }
  // No cached version (first write of this collection): plain upsert, then seed the version for next time.
  const { data: rows, error } = await supabase
    .from('family_data')
    .upsert(familyDataRow(householdId, key, data), { onConflict: FAMILY_DATA_CONFLICT })
    .select('updated_at');
  if (error) { console.error(`Supabase sync failed for "${key}":`, error.message); return; }
  if (rows && rows.length) dataVersions.set(vKey(householdId, key), rows[0].updated_at);
};

// Local appliance: POST the collection to the box with the same compare-and-set semantics — send our cached
// version (omit it on the first write → a forced upsert); a 409 means another writer was ahead, so converge.
async function saveHouseholdDataLocal(householdId: string, key: string, data: any[]): Promise<void> {
  const expected = dataVersions.get(vKey(householdId, key));
  const body: { data: any[]; version?: string } = { data };
  if (expected !== undefined) body.version = expected; // CAS; omitted first write = forced
  let res: Response;
  try {
    res = await apiFetch(`/api/data/${key}`, { method: 'POST', body: JSON.stringify(body) });
  } catch (e) { console.error(`Local sync failed for "${key}":`, e); return; }
  if (res.status === 409) {
    console.warn(`[sync] stale write for "${key}" — another writer was ahead; refreshing to the latest.`);
    fireStaleRefresh();
    return;
  }
  if (!res.ok) { console.error(`Local sync failed for "${key}" (${res.status}).`); return; }
  const out = await res.json().catch(() => ({} as any));
  if (out?.version) dataVersions.set(vKey(householdId, key), out.version);
}
