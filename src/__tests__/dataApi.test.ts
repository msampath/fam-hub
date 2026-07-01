import { describe, it, expect } from 'vitest';
import { SqliteAdapter } from '../storage/sqlite';
import { handleDataGet, handleDataSave, handleDataList, handleDataLoadAll } from '../storage/dataApi';

const HID = 'hh-1';
const mk = () => new SqliteAdapter(':memory:');

describe('data API handlers', () => {
  it('GET an absent collection → 200 with empty data + null version', async () => {
    const r = await handleDataGet(mk(), HID, 'events');
    expect(r).toEqual({ status: 200, body: { data: [], version: null } });
  });

  it('SAVE then GET round-trips, and the version advances', async () => {
    const db = mk();
    const saved = await handleDataSave(db, HID, 'events', { data: [{ id: '1' }] });
    expect(saved.status).toBe(200);
    const got = await handleDataGet(db, HID, 'events');
    expect((got.body as any).data).toEqual([{ id: '1' }]);
    expect((got.body as any).version).toBe((saved.body as any).version);
  });

  it('a stale CAS save → 409 with the current version, no clobber', async () => {
    const db = mk();
    const v1 = (await handleDataSave(db, HID, 'chores', { data: [{ id: 'a' }] }) as any).body.version;
    await handleDataSave(db, HID, 'chores', { data: [{ id: 'a' }, { id: 'b' }], version: v1 }); // advances
    const stale = await handleDataSave(db, HID, 'chores', { data: [{ id: 'WIPED' }], version: v1 });
    expect(stale.status).toBe(409);
    expect((stale.body as any).error).toBe('stale');
    expect((await handleDataGet(db, HID, 'chores') as any).body.data).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('rejects a bad collection key and a non-array body', async () => {
    const db = mk();
    expect((await handleDataGet(db, HID, '../etc')).status).toBe(400);
    expect((await handleDataSave(db, HID, 'Events', { data: [] })).status).toBe(400); // uppercase not allowed
    expect((await handleDataSave(db, HID, 'events', { data: 'nope' })).status).toBe(400);
  });

  it('LIST returns the household keys', async () => {
    const db = mk();
    await handleDataSave(db, HID, 'events', { data: [] });
    await handleDataSave(db, HID, 'chores', { data: [] });
    expect((await handleDataList(db, HID) as any).body.keys.sort()).toEqual(['chores', 'events']);
  });

  it('LOAD-ALL bulk-hydrates every collection + its version', async () => {
    const db = mk();
    const ev = await handleDataSave(db, HID, 'events', { data: [{ id: 'e' }] }) as any;
    await handleDataSave(db, HID, 'chores', { data: [{ id: 'c' }] });
    const all = (await handleDataLoadAll(db, HID)).body as any;
    expect(all.collections).toEqual({ events: [{ id: 'e' }], chores: [{ id: 'c' }] });
    expect(all.versions.events).toBe(ev.body.version);
    // another household sees nothing
    expect((await handleDataLoadAll(db, 'hh-other')).body).toEqual({ collections: {}, versions: {} });
  });
});
