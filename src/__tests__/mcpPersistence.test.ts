import { describe, it, expect, vi } from 'vitest';
import { makePersistence, persistResult, type Persistence } from '../mcp/persistence';
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
