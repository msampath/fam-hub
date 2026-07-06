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
    // Async agent jobs (roadmap "Async agent jobs"): one row per queued agent turn — queued → running →
    // done|error. MIRRORS the Supabase `agent_jobs` table (supabase/migrations/2026-07-06-post-capstone.sql);
    // like family_data, scoping here is APP-ENFORCED (every statement filters by household_id). `actions` is
    // the agent's actions array as JSON text (jsonb on the Supabase side); timestamps are ISO strings.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id           TEXT PRIMARY KEY,
        household_id TEXT NOT NULL,
        status       TEXT NOT NULL,
        message      TEXT NOT NULL,
        reply        TEXT,
        actions      TEXT,
        model        TEXT,
        session_id   TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);
    // Web-page cache for the concierge's fetch_page tool (roadmap "Web cache") — mirrors the Supabase
    // `web_cache` table. url_hash = sha256 of the NORMALIZED url (src/utils/webCache.ts); `content` is the
    // packed { text, links } page. The 7-day TTL is enforced on READ by the caller; writes prune stale rows.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS web_cache (
        household_id TEXT NOT NULL,
        url_hash     TEXT NOT NULL,
        url          TEXT NOT NULL,
        content      TEXT NOT NULL,
        fetched_at   TEXT NOT NULL,
        PRIMARY KEY (household_id, url_hash)
      );
    `);
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

  // ── Agent jobs + web cache — like getMeta/setMeta these are helpers on the CONCRETE handle, not part of
  // the StorageAdapter interface (which stays the household-DATA blob contract). Sync (node:sqlite); the
  // async job/cache STORE wrappers live in src/storage/agentJobs.ts and src/mcp/persistence.ts. Every
  // statement filters by household_id — the same app-enforced scoping family_data uses.

  insertAgentJob(householdId: string, id: string, message: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO agent_jobs (id, household_id, status, message, created_at, updated_at)
                VALUES (?, ?, 'queued', ?, ?, ?)`)
      .run(id, householdId, message, now, now);
  }

  // Patch a job's status (+ any completed fields). COALESCE keeps un-patched columns — the worker calls
  // this twice: once for 'running' (status only), once for done/error (with the reply payload).
  updateAgentJob(
    householdId: string, id: string,
    patch: { status: string; reply?: string; actions?: string; model?: string; sessionId?: string },
  ): void {
    this.db
      .prepare(`UPDATE agent_jobs
                SET status = ?, reply = COALESCE(?, reply), actions = COALESCE(?, actions),
                    model = COALESCE(?, model), session_id = COALESCE(?, session_id), updated_at = ?
                WHERE household_id = ? AND id = ?`)
      .run(patch.status, patch.reply ?? null, patch.actions ?? null, patch.model ?? null,
           patch.sessionId ?? null, new Date().toISOString(), householdId, id);
  }

  getAgentJob(householdId: string, id: string): {
    id: string; household_id: string; status: string; message: string; reply: string | null;
    actions: string | null; model: string | null; session_id: string | null; created_at: string; updated_at: string;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM agent_jobs WHERE household_id = ? AND id = ?')
      .get(householdId, id) as any;
    return row ?? null;
  }

  // Raw cache row (or null). Freshness (the 7-day TTL) is the CALLER's check — one shared pure helper
  // (isCacheFresh) rather than per-backend SQL date math that could drift.
  getWebCache(householdId: string, urlHash: string): { url: string; content: string; fetched_at: string } | null {
    const row = this.db
      .prepare('SELECT url, content, fetched_at FROM web_cache WHERE household_id = ? AND url_hash = ?')
      .get(householdId, urlHash) as any;
    return row ?? null;
  }

  // Upsert a fetched page + best-effort prune: any of THIS household's rows already past the TTL are dead
  // (the read path ignores them), so clearing them on write keeps the table bounded without a cron.
  putWebCache(householdId: string, urlHash: string, url: string, content: string, nowIso: string, staleBeforeIso: string): void {
    this.db
      .prepare(`INSERT INTO web_cache (household_id, url_hash, url, content, fetched_at) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(household_id, url_hash) DO UPDATE SET url = excluded.url, content = excluded.content, fetched_at = excluded.fetched_at`)
      .run(householdId, urlHash, url, content, nowIso);
    this.db
      .prepare('DELETE FROM web_cache WHERE household_id = ? AND fetched_at < ?')
      .run(householdId, staleBeforeIso);
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
