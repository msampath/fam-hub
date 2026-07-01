// SQLite StorageAdapter — the single-click LAN appliance's default backend (zero external services, the
// data lives in one file on the box). Uses Node's BUILT-IN `node:sqlite` (Node 22.5+/24), so there's no
// native dependency to compile — important for a one-click self-host.
//
// The schema MIRRORS the Supabase `family_data` table exactly (one row per household_id+data_key), so the
// household-scoping security model is identical across backends. SQLite has no RLS engine, so scoping is
// APP-ENFORCED: every statement filters by household_id. CAS is via the `updated_at` column, wrapped in a
// BEGIN IMMEDIATE transaction so the check-then-write is atomic even when the Express server and the agent's
// MCP child open the same file concurrently.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { StorageAdapter, StoredBlob, SaveResult } from './StorageAdapter';

export class SqliteAdapter implements StorageAdapter {
  private db: DatabaseSync;

  constructor(path = process.env.SQLITE_PATH || './data/famhub.db') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;'); // concurrent reader + writer (Express + MCP child)
    // Wait up to 5s for a contended write lock instead of throwing SQLITE_BUSY immediately (node:sqlite's
    // default busy_timeout is 0). The appliance runs the web container + the agent's MCP children (the agent
    // spawns several at once) as SEPARATE processes, each opening its own handle to this shared file; WAL
    // still allows only ONE writer at a time, so two BEGIN IMMEDIATE writes can collide. Without this, that
    // collision surfaces as a thrown error → /api/data 500 or a silent agent write failure.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS family_data (
        household_id TEXT NOT NULL,
        data_key     TEXT NOT NULL,
        data         TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        PRIMARY KEY (household_id, data_key)
      );
    `);
    // Box-level config (NOT household data): the household id, passphrase hash/salt, and session secret that
    // make this box an identity. Single key/value table; see boxConfig.ts for the typed helpers.
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);');
  }

  // ── Box config (meta) — sync; local SQLite, used at auth time only. Not part of the StorageAdapter
  // interface (which is the household-DATA contract); these are box-identity helpers on the concrete handle.
  getMeta(k: string): string | null {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v?: string } | undefined;
    return row?.v != null ? String(row.v) : null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  async load(householdId: string, key: string): Promise<StoredBlob> {
    const row = this.db
      .prepare('SELECT data, updated_at FROM family_data WHERE household_id = ? AND data_key = ?')
      .get(householdId, key) as { data?: string; updated_at?: string } | undefined;
    if (!row) return { data: [], version: null };
    let data: any[] = [];
    try { const parsed = JSON.parse(row.data ?? '[]'); data = Array.isArray(parsed) ? parsed : []; } catch { data = []; }
    return { data, version: row.updated_at != null ? String(row.updated_at) : null };
  }

  async save(householdId: string, key: string, data: any[], expectedVersion?: string | null): Promise<SaveResult> {
    // The version token must be UNIQUE per write (not just an ISO timestamp — two writes in the same
    // millisecond would collide and let a stale CAS falsely succeed), so append a random suffix. Opaque to
    // callers; compared only within this backend.
    const now = `${new Date().toISOString()}.${randomUUID().slice(0, 8)}`;
    const json = JSON.stringify(Array.isArray(data) ? data : []);
    // Atomic check-then-write: BEGIN IMMEDIATE takes the write lock up front so a concurrent writer (another
    // device, or the MCP child) can't slip a write between our version read and our upsert.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.casWrite(householdId, key, json, now, expectedVersion);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private casWrite(householdId: string, key: string, json: string, now: string, expectedVersion?: string | null): SaveResult {
    const cur = this.db
      .prepare('SELECT updated_at FROM family_data WHERE household_id = ? AND data_key = ?')
      .get(householdId, key) as { updated_at?: string } | undefined;
    const curVer = cur?.updated_at != null ? String(cur.updated_at) : null;
    // CAS requested (expectedVersion provided) and the row moved on → don't clobber; tell the caller to refresh.
    if (expectedVersion !== undefined && expectedVersion !== curVer) {
      return { ok: false, version: curVer, conflict: true };
    }
    this.db
      .prepare(
        `INSERT INTO family_data (household_id, data_key, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(household_id, data_key) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(householdId, key, json, now);
    return { ok: true, version: now };
  }

  async listKeys(householdId: string): Promise<string[]> {
    const rows = this.db
      .prepare('SELECT data_key FROM family_data WHERE household_id = ?')
      .all(householdId) as { data_key?: string }[];
    return rows.map(r => String(r.data_key));
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
