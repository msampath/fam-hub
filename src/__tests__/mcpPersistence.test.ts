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
