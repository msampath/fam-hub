// Supabase StorageAdapter — the OPTIONAL cloud backend (cross-device sync, multi-tenant-capable). Wraps the
// existing `family_data` blob table. The client is constructed PER REQUEST from the caller's JWT by the
// endpoint layer (mirroring src/mcp/persistence.ts), so Postgres RLS scopes every row to the caller's
// household — the householdId passed in is belt-and-suspenders on top of RLS. This keeps the multi-tenant
// security model intact for anyone who runs the cloud mode.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StorageAdapter, StoredBlob, SaveResult } from './StorageAdapter';
import { familyDataRow, FAMILY_DATA_CONFLICT } from '../utils/familyData';

export class SupabaseAdapter implements StorageAdapter {
  constructor(private client: SupabaseClient) {}

  async load(householdId: string, key: string): Promise<StoredBlob> {
    const { data, error } = await this.client
      .from('family_data').select('data, updated_at')
      .eq('household_id', householdId).eq('data_key', key).maybeSingle();
    if (error) throw new Error(`read "${key}" failed: ${error.message}`);
    if (!data) return { data: [], version: null };
    return { data: Array.isArray(data.data) ? data.data : [], version: data.updated_at != null ? String(data.updated_at) : null };
  }

  async save(householdId: string, key: string, data: any[], expectedVersion?: string | null): Promise<SaveResult> {
    const row = familyDataRow(householdId, key, Array.isArray(data) ? data : []);
    // Forced/unconditional write (no CAS requested).
    if (expectedVersion === undefined) {
      const { data: rows, error } = await this.client
        .from('family_data').upsert(row, { onConflict: FAMILY_DATA_CONFLICT }).select('updated_at');
      if (error) throw new Error(`write "${key}" failed: ${error.message}`);
      return { ok: true, version: rows?.[0]?.updated_at != null ? String(rows[0].updated_at) : row.updated_at };
    }
    // CAS against a row we believed present: UPDATE only if updated_at still matches.
    if (expectedVersion !== null) {
      const { data: rows, error } = await this.client
        .from('family_data').update({ data: row.data, updated_at: row.updated_at })
        .eq('household_id', householdId).eq('data_key', key).eq('updated_at', expectedVersion)
        .select('updated_at');
      if (error) throw new Error(`write "${key}" failed: ${error.message}`);
      if (rows && rows.length) return { ok: true, version: String(rows[0].updated_at) };
      // Nothing matched our version → a concurrent write landed first; report current so the caller refreshes.
      const cur = await this.load(householdId, key);
      return { ok: false, version: cur.version, conflict: true };
    }
    // CAS against absence (expectedVersion === null): INSERT; a unique-violation means it already exists.
    const { error } = await this.client.from('family_data').insert(row);
    if (!error) return { ok: true, version: row.updated_at };
    if (error.code === '23505') { // unique_violation → row appeared concurrently
      const cur = await this.load(householdId, key);
      return { ok: false, version: cur.version, conflict: true };
    }
    throw new Error(`write "${key}" failed: ${error.message}`);
  }

  async listKeys(householdId: string): Promise<string[]> {
    const { data, error } = await this.client.from('family_data').select('data_key').eq('household_id', householdId);
    if (error) throw new Error(`listKeys failed: ${error.message}`);
    return (data || []).map(r => String(r.data_key));
  }
}
