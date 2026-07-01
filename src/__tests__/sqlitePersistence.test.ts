import { describe, it, expect } from 'vitest';
import { SqlitePersistence, persistResult } from '../mcp/persistence';
import { SqliteAdapter } from '../storage/sqlite';
import type { McpToolResult } from '../mcp/conciergeTools';

const mk = () => new SqlitePersistence(new SqliteAdapter(':memory:'));

describe('SqlitePersistence (agent writes → local SQLite box)', () => {
  it('append read-modify-writes a collection and returns the new length', async () => {
    const p = mk();
    expect(await p.append('events', [{ id: 'a' }])).toBe(1);
    expect(await p.append('events', [{ id: 'b' }])).toBe(2);
    expect(await p.loadCollection('events')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('replace overwrites wholesale', async () => {
    const p = mk();
    await p.append('chores', [{ id: 'x' }]);
    await p.replace('chores', [{ id: 'y' }]);
    expect(await p.loadCollection('chores')).toEqual([{ id: 'y' }]);
  });

  it('persistResult applies an auto-tier create_event to the SQLite box', async () => {
    const p = mk();
    const result: McpToolResult = { ok: true, tool: 'create_event', tier: 'auto', status: 'validated', artifact: { id: 'e1', title: 'Zoo' } };
    const out = await persistResult(result, p);
    expect(out.status).toBe('applied');
    expect(await p.loadCollection('events')).toEqual([{ id: 'e1', title: 'Zoo' }]);
  });

  it('persistResult does NOT persist a confirm-tier draft', async () => {
    const p = mk();
    const result: McpToolResult = { ok: true, tool: 'reserve', tier: 'confirm', status: 'requires_confirmation', artifact: { summary: 'x' } };
    const out = await persistResult(result, p);
    expect(out.status).toBe('requires_confirmation');
  });
});
