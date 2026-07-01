// Backend-agnostic, HOUSEHOLD-SCOPED key-value store over the app's blob model (one logical row per
// (householdId, dataKey); `data` is the whole collection as a JSON array). This seam is what lets a fam-hub
// box run on SQLite (the single-click LAN appliance default) OR Supabase (optional cloud sync) without the
// client knowing which.
//
// SECURITY INVARIANT (preserved across every backend, so an open-source extender inherits it): every call
// carries the authenticated `householdId` and the adapter MUST scope to it — it never returns or writes
// another household's row. SQLite app-enforces this (no RLS engine); Supabase enforces it with DB RLS. The
// single-tenant LAN default simply has one household, but the boundary is real either way.
//
// `version` is the optimistic-concurrency token (the row's `updated_at`): pass the version you loaded back
// into `save` to compare-and-set, so two devices editing the same collection can't silently clobber.

export interface StoredBlob {
  data: any[];
  version: string | null; // CAS token (updated_at); null when the row is absent
}

export interface SaveResult {
  ok: boolean;
  version: string | null;  // the new version on success, or the CURRENT version on conflict
  conflict?: boolean;      // true when expectedVersion no longer matched (caller should refresh + retry)
}

export interface StorageAdapter {
  /** Load a household's collection blob (empty array + null version when absent). */
  load(householdId: string, key: string): Promise<StoredBlob>;

  /**
   * Write a household's collection blob.
   * - Omit `expectedVersion` for a forced/unconditional write (first write, or a deliberate overwrite).
   * - Pass the version you loaded (a string, or `null` if you believed the row absent) to COMPARE-AND-SET:
   *   if it no longer matches the current row, the write is skipped and `{ ok:false, conflict:true }` is
   *   returned with the current version, so the caller can refresh and re-apply.
   */
  save(householdId: string, key: string, data: any[], expectedVersion?: string | null): Promise<SaveResult>;

  /** The collection keys present for a household (for export / debugging). */
  listKeys(householdId: string): Promise<string[]>;

  /** Release resources (close the DB handle). Optional — Supabase has nothing to close. */
  close?(): Promise<void>;
}
