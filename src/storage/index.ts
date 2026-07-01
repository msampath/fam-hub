// Storage backend selection for the box. The single-click LAN appliance defaults to SQLite (zero external
// services); the optional cloud mode uses Supabase. The Supabase adapter needs a PER-REQUEST client (built
// from the caller's JWT to preserve RLS), so it's constructed at the endpoint layer — this factory owns only
// the process-wide SQLite handle + the mode decision.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteAdapter } from './sqlite';

export type { StorageAdapter, StoredBlob, SaveResult } from './StorageAdapter';
export { SqliteAdapter } from './sqlite';
export { SupabaseAdapter } from './supabase';

export type StorageMode = 'sqlite' | 'supabase';

// Which backend this box runs. An explicit STORAGE=sqlite|supabase wins; otherwise prefer Supabase when it's
// configured (preserves existing cloud deploys) and fall back to SQLite (the zero-config appliance default).
export function storageMode(env: Record<string, string | undefined> = process.env): StorageMode {
  const explicit = (env.STORAGE || '').trim().toLowerCase();
  if (explicit === 'sqlite' || explicit === 'supabase') return explicit;
  return (env.SUPABASE_URL || env.VITE_SUPABASE_URL) ? 'supabase' : 'sqlite';
}

// Lazy process-wide SQLite handle (one DB file per box). Ensures the parent dir exists so a fresh appliance
// boots without a manual mkdir.
let _sqlite: SqliteAdapter | null = null;
export function getSqliteAdapter(): SqliteAdapter {
  if (!_sqlite) {
    const p = process.env.SQLITE_PATH || './data/famhub.db';
    try { mkdirSync(dirname(p), { recursive: true }); } catch { /* exists, or a non-path target like :memory: */ }
    _sqlite = new SqliteAdapter(p);
  }
  return _sqlite;
}
