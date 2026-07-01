import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../storage/sqlite';
import { storageMode } from '../storage/index';

// In-memory SQLite (no file) — fast, isolated per test.
const mk = () => new SqliteAdapter(':memory:');
const HID_A = 'hh-aaaa';
const HID_B = 'hh-bbbb';

describe('SqliteAdapter', () => {
  it('load on an absent collection returns empty + null version', async () => {
    const db = mk();
    expect(await db.load(HID_A, 'events')).toEqual({ data: [], version: null });
    await db.close();
  });

  it('save (forced) then load round-trips the blob and assigns a version', async () => {
    const db = mk();
    const r = await db.save(HID_A, 'events', [{ id: '1', title: 'Zoo' }]);
    expect(r.ok).toBe(true);
    expect(typeof r.version).toBe('string');
    const got = await db.load(HID_A, 'events');
    expect(got.data).toEqual([{ id: '1', title: 'Zoo' }]);
    expect(got.version).toBe(r.version);
    await db.close();
  });

  it('compare-and-set: a matching version writes; a STALE version conflicts without clobbering', async () => {
    const db = mk();
    const v1 = (await db.save(HID_A, 'chores', [{ id: 'a' }])).version;          // forced first write
    const ok = await db.save(HID_A, 'chores', [{ id: 'a' }, { id: 'b' }], v1);    // CAS with current version
    expect(ok).toEqual({ ok: true, version: expect.any(String) });
    expect(ok.version).not.toBe(v1);                                             // version advanced
    // A second writer still holding v1 must be rejected, and the data must NOT be clobbered.
    const stale = await db.save(HID_A, 'chores', [{ id: 'WIPED' }], v1);
    expect(stale).toEqual({ ok: false, version: ok.version, conflict: true });
    expect((await db.load(HID_A, 'chores')).data).toEqual([{ id: 'a' }, { id: 'b' }]);
    await db.close();
  });

  it('CAS-against-absence (expectedVersion null) inserts once, then conflicts', async () => {
    const db = mk();
    const first = await db.save(HID_A, 'goals', [{ id: 'g' }], null);            // expected absent → insert
    expect(first.ok).toBe(true);
    const again = await db.save(HID_A, 'goals', [{ id: 'g2' }], null);           // still claims absent → conflict
    expect(again).toMatchObject({ ok: false, conflict: true });
    await db.close();
  });

  it('is HOUSEHOLD-SCOPED: one household never sees another\'s rows', async () => {
    const db = mk();
    await db.save(HID_A, 'events', [{ id: 'a-only' }]);
    expect(await db.load(HID_B, 'events')).toEqual({ data: [], version: null }); // B sees nothing of A's
    await db.save(HID_B, 'events', [{ id: 'b-only' }]);
    expect((await db.load(HID_A, 'events')).data).toEqual([{ id: 'a-only' }]);   // A unchanged by B's write
    expect(await db.listKeys(HID_A)).toEqual(['events']);
    await db.close();
  });
});

describe('storageMode', () => {
  it('honors an explicit STORAGE, else prefers Supabase when configured, else SQLite', () => {
    expect(storageMode({ STORAGE: 'sqlite', SUPABASE_URL: 'x' })).toBe('sqlite');
    expect(storageMode({ STORAGE: 'supabase' })).toBe('supabase');
    expect(storageMode({ SUPABASE_URL: 'https://x.supabase.co' })).toBe('supabase'); // existing cloud deploy
    expect(storageMode({})).toBe('sqlite');                                          // zero-config appliance
  });
});
