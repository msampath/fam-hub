// KAGGLE_EVAL: MCP persistence — the agent's tool calls actually mutate the visitor's household.
//
// The Node MCP server writes to Supabase UNDER THE VISITOR'S JWT, so RLS scopes every write to that
// visitor's own household (per-visitor isolation in the no-login demo). In the demo architecture the
// Python ADK service spawns this MCP server as a stdio child with SUPABASE_ACCESS_TOKEN = the visitor's
// anonymous JWT; the server creates an authed Supabase client from it. With no token configured,
// makePersistence() returns null and the MCP server stays the validate-only contract slice.
//
// Data model = the app's: one `family_data` row per (household_id, data_key), `data` is the whole
// collection as a JSONB array. So a create is a read-modify-write append (matches the client's
// saveHouseholdData). Auto-tier writes only — confirm/stepup results stay staged for human approval.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { McpToolResult } from './conciergeTools';
import { familyDataRow, FAMILY_DATA_CONFLICT } from '../utils/familyData';
import { getSqliteAdapter, type SqliteAdapter } from '../storage';
import { getOrCreateHouseholdId } from '../storage/boxConfig';
import {
  normalizeWebUrl, webUrlHash, isCacheFresh, packCachedPage, unpackCachedPage,
  WEB_CACHE_TTL_MS, type CachedPage,
} from '../utils/webCache';

// Which family_data collection each auto-tier tool's artifact appends to.
const TOOL_COLLECTION: Record<string, string> = {
  create_event: 'events',
  add_chore: 'chores',
  add_shopping_item: 'shopping',
};

export interface Persistence {
  loadCollection(dataKey: string): Promise<any[]>;       // current blob (for ctx + read-modify-write)
  // Append items; returns the new length. CAS-guarded on the active SQLite appliance path (see SqlitePersistence).
  append(dataKey: string, items: any[], current?: any[]): Promise<number>;
  // Compare-and-set read-modify-write: load, apply `transform`, save — retrying on a concurrent write so a
  // move/edit can't clobber another writer's change (the CAS-safe replacement for load-then-replace).
  mutate(dataKey: string, transform: (cur: any[]) => any[]): Promise<void>;
  // Overwrite a collection wholesale (forced; kept for the rare wholesale-replace + tests).
  replace(dataKey: string, items: any[]): Promise<void>;
  // Household-scoped web-page cache (roadmap "Web cache") for the fetch_page tool — the `web_cache` table
  // on both backends. OPTIONAL so contract-slice mocks/tests stay valid, and FAIL-SOFT by contract: any
  // error (table not migrated yet, RLS hiccup, network) is a cache MISS / silent no-op — the cache must
  // never break a live fetch. get() returns FRESH rows only (the 7-day TTL is enforced on read).
  webCacheGet?(url: string): Promise<{ page: CachedPage; fetchedAt: string } | null>;
  webCachePut?(url: string, page: CachedPage): Promise<void>;
}

// Build a Supabase-backed persistence from env (the visitor's JWT). null when not configured → the MCP
// server runs validate-only. `env` is injectable for tests.
export function makePersistence(env: Record<string, string | undefined> = process.env): Persistence | null {
  // Local appliance (SQLite): the agent's auto-tier writes land in the box's SQLite file, under the box's
  // single household — no Supabase token needed. Same handle the Express server uses (WAL → concurrent).
  // Gated on an EXPLICIT signal (STORAGE=sqlite or SQLITE_PATH) so a bare/unconfigured env stays validate-only
  // (the contract slice), rather than silently writing a stray DB file.
  // An explicit STORAGE wins: STORAGE=supabase must NOT be overridden by a stray SQLITE_PATH (which the
  // appliance compose sets unconditionally) — otherwise a cloud box would silently write to a local file.
  const storage = (env.STORAGE || '').trim().toLowerCase();
  const explicitSqlite = storage === 'sqlite' || (storage !== 'supabase' && !!env.SQLITE_PATH);
  if (explicitSqlite) {
    return new SqlitePersistence(getSqliteAdapter());
  }
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
  const key = env.SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY;
  const token = env.SUPABASE_ACCESS_TOKEN; // the visitor's (anonymous) Supabase JWT
  if (!url || !key || !token) return null;
  const client = createClient(url, key, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return new SupabasePersistence(client);
}

export class SupabasePersistence implements Persistence {
  private hid: string | null = null;
  // One promise-chain lock per data_key: a model turn can fire MANY tool calls in parallel (found live —
  // "make paneer butter masala" → ~15 concurrent add_shopping_item calls), and each write here is a
  // read-modify-write of the SAME whole-collection JSONB row. Unserialized, they all read the same stale
  // blob and last-write-wins (16 adds → 2 persisted). All of one specialist's calls flow through this one
  // MCP child process, so an in-process queue fully serializes them; cross-process CAS (a Postgres
  // conditional update) stays the tracked follow-up for concurrent HUMAN+agent writes.
  private locks = new Map<string, Promise<unknown>>();
  constructor(private client: SupabaseClient) {}

  private locked<T>(dataKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(dataKey) ?? Promise.resolve();
    const run = prev.then(fn, fn); // run regardless of the predecessor's outcome
    this.locks.set(dataKey, run.catch(() => {})); // keep the chain alive past a failed write
    return run;
  }

  // The visitor's household (RLS returns only their own membership). Cached for the process lifetime.
  private async householdId(): Promise<string> {
    if (this.hid) return this.hid;
    const { data, error } = await this.client.from('household_members').select('household_id').limit(1);
    if (error) throw new Error('household lookup failed: ' + error.message);
    const hid = data?.[0]?.household_id;
    if (!hid) throw new Error('no household for this visitor (did the demo seed run?)');
    this.hid = hid;
    return hid;
  }

  async loadCollection(dataKey: string): Promise<any[]> {
    return (await this.loadWithVersion(dataKey)).data;
  }

  // Versioned read for the CAS write path: the row's updated_at is the compare token (same contract as
  // the browser's saveHouseholdData and the box's /api/data). null version = the row doesn't exist yet.
  private async loadWithVersion(dataKey: string): Promise<{ data: any[]; version: string | null }> {
    const hid = await this.householdId();
    const { data, error } = await this.client
      .from('family_data').select('data, updated_at').eq('household_id', hid).eq('data_key', dataKey).maybeSingle();
    if (error) throw new Error(`read "${dataKey}" failed: ` + error.message);
    return { data: Array.isArray(data?.data) ? data!.data : [], version: (data as any)?.updated_at ?? null };
  }

  // Cross-process CAS (W8 — the formerly "tracked follow-up", now landed): a conditional UPDATE gated on
  // the updated_at token we loaded, mirroring SqlitePersistence.casWrite and the browser's CAS. The
  // in-process lock still serializes THIS child's parallel tool calls; the CAS arbitrates against the
  // OTHER writers (a human edit / another device) landing between our read and write — on a conflict
  // (0 rows matched) reload + rebuild + retry, so the agent's DELTA re-applies to the freshest blob
  // instead of clobbering or being dropped. After 4 lost races (vanishingly rare at household write
  // volume), force-apply on fresh data so the write LANDS. updated_at stays client-set today — it is an
  // equality token, not a clock; the server-set trigger upgrade is staged in the post-capstone migration.
  private async casWrite(dataKey: string, build: (cur: any[]) => any[]): Promise<any[]> {
    const hid = await this.householdId();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data: cur, version } = await this.loadWithVersion(dataKey);
      const next = build(cur);
      if (version == null) {
        // First write of this collection: nothing to compare against → plain upsert (browser parity).
        const { error } = await this.client.from('family_data').upsert(
          familyDataRow(hid, dataKey, next), { onConflict: FAMILY_DATA_CONFLICT },
        );
        if (error) throw new Error(`write "${dataKey}" failed: ` + error.message);
        return next;
      }
      const { data: rows, error } = await this.client.from('family_data')
        .update({ data: next, updated_at: new Date().toISOString() })
        .eq('household_id', hid).eq('data_key', dataKey).eq('updated_at', version)
        .select('updated_at');
      if (error) throw new Error(`write "${dataKey}" failed: ` + error.message);
      if (rows && rows.length) return next; // CAS landed
      // 0 rows matched → a concurrent writer was ahead; loop re-reads and re-applies.
    }
    const { data: cur } = await this.loadWithVersion(dataKey);
    const next = build(cur);
    const { error } = await this.client.from('family_data').upsert(
      familyDataRow(hid, dataKey, next), { onConflict: FAMILY_DATA_CONFLICT },
    );
    if (error) throw new Error(`write "${dataKey}" failed: ` + error.message);
    return next;
  }

  // `current` (the caller's preloaded blob) is intentionally IGNORED — same reasoning as SqlitePersistence:
  // under the lock every append must merge into the FRESHEST blob, and a preloaded snapshot is stale by
  // definition for every call after the first in a parallel burst.
  async append(dataKey: string, items: any[], _current?: any[]): Promise<number> {
    return this.locked(dataKey, async () => (await this.casWrite(dataKey, cur => [...cur, ...items])).length);
  }

  async replace(dataKey: string, items: any[]): Promise<void> {
    return this.locked(dataKey, async () => {
      const hid = await this.householdId();
      const { error } = await this.client.from('family_data').upsert(
        familyDataRow(hid, dataKey, items), { onConflict: FAMILY_DATA_CONFLICT },
      );
      if (error) throw new Error(`replace "${dataKey}" failed: ` + error.message);
    });
  }

  // Cloud read-modify-write: serialized per collection by the in-process lock (parallel tool calls can't
  // clobber each other) AND CAS-gated against cross-process writers (casWrite above).
  async mutate(dataKey: string, transform: (cur: any[]) => any[]): Promise<void> {
    await this.locked(dataKey, () => this.casWrite(dataKey, transform));
  }

  // Web cache read — FRESH hits only; every failure mode is a miss (fail-soft: until the morning
  // migration lands the `web_cache` table doesn't exist in the shared demo project, and a cache outage
  // must degrade to a live fetch, never to a broken tool).
  async webCacheGet(url: string): Promise<{ page: CachedPage; fetchedAt: string } | null> {
    try {
      const norm = normalizeWebUrl(url);
      if (!norm) return null;
      const hid = await this.householdId();
      const { data, error } = await this.client.from('web_cache').select('content, fetched_at')
        .eq('household_id', hid).eq('url_hash', webUrlHash(norm)).maybeSingle();
      if (error || !data) return null;
      const fetchedAt = String(data.fetched_at ?? '');
      if (!isCacheFresh(fetchedAt, Date.now())) return null; // TTL enforced on READ — stale rows are ignored
      const page = unpackCachedPage(String(data.content ?? ''));
      return page ? { page, fetchedAt } : null;
    } catch { return null; }
  }

  // Web cache write — best-effort upsert + prune of this household's stale rows (no cron; the read path
  // already ignores expired rows, this just keeps the table bounded). Never throws.
  async webCachePut(url: string, page: CachedPage): Promise<void> {
    try {
      const norm = normalizeWebUrl(url);
      if (!norm) return;
      const hid = await this.householdId();
      await this.client.from('web_cache').upsert(
        { household_id: hid, url_hash: webUrlHash(norm), url: norm, content: packCachedPage(page), fetched_at: new Date().toISOString() },
        { onConflict: 'household_id,url_hash' },
      );
      await this.client.from('web_cache').delete()
        .eq('household_id', hid).lt('fetched_at', new Date(Date.now() - WEB_CACHE_TTL_MS).toISOString());
    } catch { /* best-effort — a failed cache write costs nothing but the next fetch */ }
  }
}

// Local appliance backend: CAS read-modify-write the box's SQLite file under its single household. The
// SqliteAdapter's save() takes an expectedVersion (updated_at token), so append/mutate load-then-save under
// CAS and retry on a concurrent write — a human edit (or another agent turn) landing mid-write is no longer
// clobbered. This is the fix for the former "agent writes are last-write-wins" gap on the active box path.
export class SqlitePersistence implements Persistence {
  private hid: string | null = null;
  constructor(private adapter: SqliteAdapter) {}

  private householdId(): string {
    if (!this.hid) this.hid = getOrCreateHouseholdId(this.adapter);
    return this.hid;
  }

  async loadCollection(dataKey: string): Promise<any[]> {
    return (await this.adapter.load(this.householdId(), dataKey)).data;
  }

  // Load {data, version} → build the next collection → save under CAS; on a version conflict (a concurrent
  // writer landed), reload + rebuild + retry. `build` re-runs on the FRESHEST data each attempt, so an append
  // re-appends and a move re-applies to the current set — no lost update. Returns the collection that landed.
  private async casWrite(dataKey: string, build: (cur: any[]) => any[]): Promise<any[]> {
    const hid = this.householdId();
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, version } = await this.adapter.load(hid, dataKey);
      const next = build(data);
      const res = await this.adapter.save(hid, dataKey, next, version);
      if (res.ok) return next;
    }
    // Exhausted CAS retries (4 concurrent writers — vanishingly rare on a single-tenant box): re-apply to the
    // latest and force, so the write LANDS rather than dropping (build() ran on fresh data, so no lost update).
    const { data } = await this.adapter.load(hid, dataKey);
    const next = build(data);
    await this.adapter.save(hid, dataKey, next);
    return next;
  }

  // `current` (the preloaded blob) is intentionally ignored — CAS needs a fresh versioned load each attempt.
  async append(dataKey: string, items: any[], _current?: any[]): Promise<number> {
    return (await this.casWrite(dataKey, cur => [...cur, ...items])).length;
  }

  // CAS read-modify-write (move_document / folder-clear): reads the current collection, applies `transform`,
  // and saves under CAS — a concurrent edit between load and save is retried, not clobbered.
  async mutate(dataKey: string, transform: (cur: any[]) => any[]): Promise<void> {
    await this.casWrite(dataKey, transform);
  }

  // Forced wholesale overwrite (kept for compatibility + tests; prod read-modify-writes go through mutate()).
  async replace(dataKey: string, items: any[]): Promise<void> {
    await this.adapter.save(this.householdId(), dataKey, items);
  }

  // Web cache read — same fail-soft contract as the Supabase impl: fresh hits only, every error is a miss.
  async webCacheGet(url: string): Promise<{ page: CachedPage; fetchedAt: string } | null> {
    try {
      const norm = normalizeWebUrl(url);
      if (!norm) return null;
      const row = this.adapter.getWebCache(this.householdId(), webUrlHash(norm));
      if (!row || !isCacheFresh(row.fetched_at, Date.now())) return null; // TTL enforced on READ
      const page = unpackCachedPage(row.content);
      return page ? { page, fetchedAt: row.fetched_at } : null;
    } catch { return null; }
  }

  // Web cache write — best-effort upsert; the adapter also prunes this household's stale rows. Never throws.
  async webCachePut(url: string, page: CachedPage): Promise<void> {
    try {
      const norm = normalizeWebUrl(url);
      if (!norm) return;
      const now = Date.now();
      this.adapter.putWebCache(
        this.householdId(), webUrlHash(norm), norm, packCachedPage(page),
        new Date(now).toISOString(), new Date(now - WEB_CACHE_TTL_MS).toISOString(),
      );
    } catch { /* best-effort — a failed cache write costs nothing but the next fetch */ }
  }
}

// Persist a validated, AUTO-tier tool result (create_event / add_chore / add_shopping_item) and flip its
// status to 'applied'. confirm/stepup results (drafts, update_event) are NOT auto-persisted — they stay
// staged for human approval. No persistence → returns the result unchanged (contract slice). The I/O is
// injected (Persistence), so the orchestration is unit-testable with a mock.
// `preloaded` (dataKey → already-loaded blob, from the server's ctx build) lets append skip a redundant
// read when the target collection was already fetched for validation.
export async function persistResult(
  result: McpToolResult,
  persistence: Persistence | null,
  preloaded?: Record<string, any[]>,
): Promise<McpToolResult> {
  if (!persistence || !result.ok || result.status !== 'validated') return result;
  const key = TOOL_COLLECTION[result.tool];
  if (!key) return result;
  const items = Array.isArray(result.artifact) ? result.artifact : [result.artifact];
  await persistence.append(key, items, preloaded?.[key]);
  return { ...result, status: 'applied' };
}
