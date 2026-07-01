// Pure request/response logic for the `/api/data/:key` endpoints, over a StorageAdapter. Kept pure (adapter +
// plain args in, `{status, body}` out) so it's unit-tested without spinning up Express or auth. The thin
// Express routes in server.ts resolve the authenticated householdId, pick the adapter (SQLite or a per-request
// Supabase client), and delegate here.
import type { StorageAdapter } from './StorageAdapter';

// Collection keys are the app's data_keys — lowercase identifiers (events, chores, actionledger, …). Validate
// so a key can't carry path/SQL oddities and so a typo'd key is a clean 400, not a silently-empty collection.
const KEY_RE = /^[a-z][a-z0-9_]{0,40}$/;

export interface ApiResult { status: number; body: unknown }

export async function handleDataGet(adapter: StorageAdapter, householdId: string, key: string): Promise<ApiResult> {
  if (!KEY_RE.test(key)) return { status: 400, body: { error: 'Invalid collection key.' } };
  const blob = await adapter.load(householdId, key); // { data, version } — already household-scoped
  return { status: 200, body: blob };
}

export async function handleDataSave(adapter: StorageAdapter, householdId: string, key: string, body: any): Promise<ApiResult> {
  if (!KEY_RE.test(key)) return { status: 400, body: { error: 'Invalid collection key.' } };
  if (!body || !Array.isArray(body.data)) {
    return { status: 400, body: { error: 'Body must be { data: array, version?: string|null }.' } };
  }
  // version semantics mirror the adapter's CAS: omitted → forced write; null → expect-absent; string → compare.
  const expected: string | null | undefined = 'version' in body ? body.version : undefined;
  const res = await adapter.save(householdId, key, body.data, expected);
  if (!res.ok && res.conflict) {
    // Another writer was ahead — hand back the current version so the client refreshes + re-applies.
    return { status: 409, body: { error: 'stale', version: res.version } };
  }
  return { status: 200, body: { ok: true, version: res.version } };
}

export async function handleDataList(adapter: StorageAdapter, householdId: string): Promise<ApiResult> {
  return { status: 200, body: { keys: await adapter.listKeys(householdId) } };
}

// Bulk load EVERY collection for a household in one round-trip — the client's loadHouseholdData equivalent
// (it hydrates all collections + their CAS versions at boot). Local/SQLite only, so the N small reads are
// cheap (one household, ~20 collections).
export async function handleDataLoadAll(adapter: StorageAdapter, householdId: string): Promise<ApiResult> {
  const keys = await adapter.listKeys(householdId);
  const collections: Record<string, any[]> = {};
  const versions: Record<string, string> = {};
  for (const k of keys) {
    const blob = await adapter.load(householdId, k);
    collections[k] = blob.data;
    if (blob.version) versions[k] = blob.version;
  }
  return { status: 200, body: { collections, versions } };
}
