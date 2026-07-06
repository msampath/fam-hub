import { describe, it, expect, vi } from 'vitest';
import { makePersistence, persistResult, SupabasePersistence, type Persistence } from '../mcp/persistence';
import type { McpToolResult } from '../mcp/conciergeTools';

const mockPersistence = () => {
  const appended: Array<{ key: string; items: any[] }> = [];
  const replaced: Array<{ key: string; items: any[] }> = [];
  const p: Persistence = {
    loadCollection: vi.fn(async () => []),
    append: vi.fn(async (key: string, items: any[]) => { appended.push({ key, items }); return items.length; }),
    mutate: vi.fn(async () => {}),
    replace: vi.fn(async (key: string, items: any[]) => { replaced.push({ key, items }); }),
  };
  return { p, appended, replaced };
};

const res = (over: Partial<McpToolResult>): McpToolResult =>
  ({ ok: true, tool: 'create_event', tier: 'auto', status: 'validated', ...over });

describe('makePersistence', () => {
  it('returns null unless URL + key + the visitor JWT are all present', () => {
    expect(makePersistence({})).toBeNull();
    expect(makePersistence({ SUPABASE_URL: 'x', SUPABASE_ANON_KEY: 'y' })).toBeNull(); // no token
    expect(makePersistence({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'y', SUPABASE_ACCESS_TOKEN: 'jwt' })).not.toBeNull();
  });

  it('STORAGE=supabase overrides a stray SQLITE_PATH (cloud box never falls back to a local file)', () => {
    // The appliance compose sets SQLITE_PATH unconditionally; an explicit STORAGE=supabase must still take
    // the Supabase branch — so this resolves via URL+key+token, NOT to a SqlitePersistence.
    const env = { STORAGE: 'supabase', SQLITE_PATH: '/tmp/famhub.db' };
    expect(makePersistence(env)).toBeNull(); // no token → null (proves it did NOT take the sqlite branch)
    expect(makePersistence({ ...env, SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'y', SUPABASE_ACCESS_TOKEN: 'jwt' })).not.toBeNull();
  });
});

describe('persistResult', () => {
  it('appends a validated create_event to "events" and flips status to applied', async () => {
    const { p, appended } = mockPersistence();
    const out = await persistResult(res({ tool: 'create_event', artifact: { id: 'e1', title: 'Zoo' } }), p);
    expect(out.status).toBe('applied');
    expect(appended).toEqual([{ key: 'events', items: [{ id: 'e1', title: 'Zoo' }] }]);
  });

  it('appends an array artifact (add_chore) as-is to "chores"', async () => {
    const { p, appended } = mockPersistence();
    const chores = [{ id: 'c1' }, { id: 'c2' }];
    const out = await persistResult(res({ tool: 'add_chore', artifact: chores }), p);
    expect(out.status).toBe('applied');
    expect(appended).toEqual([{ key: 'chores', items: chores }]);
  });

  it('does NOT persist confirm-tier drafts (reserve / update_event stay staged)', async () => {
    const { p, appended } = mockPersistence();
    const out = await persistResult(res({ tool: 'reserve', tier: 'confirm', status: 'requires_confirmation', artifact: { link: 'x' } }), p);
    expect(out.status).toBe('requires_confirmation');
    expect(appended).toEqual([]);
    expect(p.append).not.toHaveBeenCalled();
  });

  it('does NOT persist a rejected result', async () => {
    const { p } = mockPersistence();
    const out = await persistResult(res({ ok: false, status: 'rejected' }), p);
    expect(out.status).toBe('rejected');
    expect(p.append).not.toHaveBeenCalled();
  });

  it('is a no-op (contract slice) when no persistence is configured', async () => {
    const out = await persistResult(res({ tool: 'create_event', artifact: { id: 'e1' } }), null);
    expect(out.status).toBe('validated'); // unchanged — validate-only
  });

  it('reuses a preloaded collection (passes it to append, avoiding a re-read)', async () => {
    const { p } = mockPersistence();
    await persistResult(res({ tool: 'create_event', artifact: { id: 'e1' } }), p, { events: [{ id: 'e0' }] });
    expect(p.append).toHaveBeenCalledWith('events', [{ id: 'e1' }], [{ id: 'e0' }]);
  });
});

// A parallel model turn fires MANY appends against the SAME whole-collection JSONB row (found live:
// "make paneer butter masala" → ~15 concurrent add_shopping_item calls → only 2 items survived the
// last-write-wins clobber). SupabasePersistence must serialize per data_key and merge into the FRESHEST
// blob, so every item lands. The mock client yields between read and write to force the overlap.
describe('SupabasePersistence concurrent appends', () => {
  const mockClient = () => {
    const store: Record<string, any[]> = {};
    const tick = () => new Promise(r => setTimeout(r, 1)); // force interleaving between read + write
    const from = (table: string) => {
      if (table === 'household_members') {
        return { select: () => ({ limit: async () => ({ data: [{ household_id: 'h1' }], error: null }) }) };
      }
      return {
        select: () => ({ eq: () => ({ eq: (_k: string, dataKey: string) => ({
          maybeSingle: async () => { await tick(); return { data: { data: store[dataKey] ?? [] }, error: null }; },
        }) }) }),
        upsert: async (row: { data_key: string; data: any[] }) => { await tick(); store[row.data_key] = row.data; return { error: null }; },
      };
    };
    return { client: { from } as never, store };
  };

  it('N parallel appends to one collection all land (serialized read-modify-write)', async () => {
    const { client, store } = mockClient();
    const p = new SupabasePersistence(client);
    await Promise.all(Array.from({ length: 12 }, (_, i) => p.append('shopping', [{ id: `s${i}`, text: `Item ${i}` }])));
    expect(store.shopping).toHaveLength(12);
    expect(new Set(store.shopping.map((s: any) => s.id)).size).toBe(12); // every distinct item survived
  });

  it('ignores a stale preloaded blob — merges into the freshest state under the lock', async () => {
    const { client, store } = mockClient();
    store.shopping = [{ id: 'existing' }];
    const p = new SupabasePersistence(client);
    // Both calls pass the SAME stale preloaded snapshot (what the pre-lock code trusted).
    await Promise.all([
      p.append('shopping', [{ id: 'a' }], [{ id: 'existing' }]),
      p.append('shopping', [{ id: 'b' }], [{ id: 'existing' }]),
    ]);
    expect(store.shopping.map((s: any) => s.id).sort()).toEqual(['a', 'b', 'existing']);
  });

  it('a failed write does not wedge the lock — later appends still run', async () => {
    const store: Record<string, any[]> = {};
    let failNextUpsert = true; // one-shot: the first upsert errors, everything after succeeds
    const client = {
      from: (table: string) => {
        if (table === 'household_members') {
          return { select: () => ({ limit: async () => ({ data: [{ household_id: 'h1' }], error: null }) }) };
        }
        return {
          select: () => ({ eq: () => ({ eq: (_k: string, dataKey: string) => ({
            maybeSingle: async () => ({ data: { data: store[dataKey] ?? [] }, error: null }),
          }) }) }),
          upsert: async (row: { data_key: string; data: any[] }) => {
            if (failNextUpsert) { failNextUpsert = false; return { error: { message: 'transient' } }; }
            store[row.data_key] = row.data; return { error: null };
          },
        };
      },
    } as never;
    const p = new SupabasePersistence(client);
    await expect(p.append('shopping', [{ id: 'x' }])).rejects.toThrow(/write "shopping" failed/);
    await p.append('shopping', [{ id: 'y' }]);
    expect(store.shopping.map((s: any) => s.id)).toEqual(['y']);
  });
});

describe('SupabasePersistence cross-process CAS (W8 — conditional update on updated_at)', () => {
  // Version-aware mock: rows carry {data, updated_at}; .update(...).eq(updated_at, expected) only lands
  // when the token matches (returning the row), else matches 0 rows — exactly PostgREST's behavior.
  const casMockClient = () => {
    const rows: Record<string, { data: any[]; updated_at: string }> = {};
    let stamp = 0;
    const nextStamp = () => `v${++stamp}`;
    const api = {
      rows,
      // Simulate ANOTHER writer (a device/human) landing between this process's read and write.
      externalWrite(dataKey: string, data: any[]) { rows[dataKey] = { data, updated_at: nextStamp() }; },
      client: { from: (table: string) => {
        if (table === 'household_members') {
          return { select: () => ({ limit: async () => ({ data: [{ household_id: 'h1' }], error: null }) }) };
        }
        return {
          select: () => ({ eq: () => ({ eq: (_k: string, dataKey: string) => ({
            maybeSingle: async () => ({ data: rows[dataKey] ? { data: rows[dataKey].data, updated_at: rows[dataKey].updated_at } : null, error: null }),
          }) }) }),
          upsert: async (row: { data_key: string; data: any[] }) => { rows[row.data_key] = { data: row.data, updated_at: nextStamp() }; return { error: null }; },
          update: (patch: { data: any[] }) => ({ eq: () => ({ eq: (_k: string, dataKey: string) => ({ eq: (_c: string, expected: string) => ({
            select: async () => {
              const row = rows[dataKey];
              if (!row || row.updated_at !== expected) return { data: [], error: null }; // CAS lost
              rows[dataKey] = { data: patch.data, updated_at: nextStamp() };
              return { data: [{ updated_at: rows[dataKey].updated_at }], error: null };
            },
          }) }) }) }),
        };
      } } as never,
    };
    return api;
  };

  it('first write of a collection upserts (no version token yet)', async () => {
    const m = casMockClient();
    const p = new SupabasePersistence(m.client);
    await p.append('events', [{ id: 'e1' }]);
    expect(m.rows.events.data).toEqual([{ id: 'e1' }]);
  });

  it('a concurrent HUMAN write between read and write is NOT clobbered — the agent retries onto it', async () => {
    const m = casMockClient();
    m.externalWrite('shopping', [{ id: 'human-1' }]);
    const p = new SupabasePersistence(m.client);
    // Interpose: the first build() call happens after the read; simulate the human's second write landing
    // right then, so the agent's first conditional update loses and must re-read.
    let firstBuild = true;
    await p.mutate('shopping', cur => {
      if (firstBuild) { firstBuild = false; m.externalWrite('shopping', [...cur, { id: 'human-2' }]); }
      return [...cur, { id: 'agent-1' }];
    });
    const ids = m.rows.shopping.data.map((s: any) => s.id);
    expect(ids).toContain('human-1');
    expect(ids).toContain('human-2'); // the concurrent write SURVIVED (pre-CAS it was clobbered)
    expect(ids).toContain('agent-1'); // and the agent's delta still landed
  });

  it('exhausted retries force-apply on the freshest data (the write lands, nothing lost)', async () => {
    const m = casMockClient();
    m.externalWrite('chores', [{ id: 'c0' }]);
    const p = new SupabasePersistence(m.client);
    // A pathological neighbor: EVERY build triggers yet another external write, so all 4 CAS attempts lose.
    await p.mutate('chores', cur => {
      m.externalWrite('chores', [...cur.filter((c: any) => c.id !== 'agent'), { id: `ext-${cur.length}` }]);
      return [...cur, { id: 'agent' }];
    });
    const ids = m.rows.chores.data.map((c: any) => c.id);
    expect(ids).toContain('agent'); // the forced final apply landed the agent's delta on fresh data
  });
});
