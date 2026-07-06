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

  // The server-side half of the presence-model contract: an AGENT's shopping append merges against
  // the freshest list — base-item dedupe (garlic ≡ Garlic (1 bulb)) + checked-off re-activation —
  // so the meal-planner's consolidated week can never duplicate the family's list.
  it('shopping appends MERGE: agent "garlic" neither duplicates "Garlic (1 bulb)" nor stays checked-off', async () => {
    const p = mk();
    await p.append('shopping', [{ id: 's1', text: 'Garlic (1 bulb)', store: 'Grocery Store', completed: false }]);
    // Active dup → no second row.
    await p.append('shopping', [{ id: 's2', text: 'garlic', store: 'Grocery Store', completed: false }]);
    let list = await p.loadCollection('shopping');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('s1');
    // Checked-off dup → re-activated in place, still one row.
    await p.replace('shopping', [{ id: 's1', text: 'Garlic (1 bulb)', store: 'Grocery Store', completed: true }]);
    await p.append('shopping', [{ id: 's3', text: 'Garlic (1 head)', store: 'Grocery Store', completed: false }]);
    list = await p.loadCollection('shopping');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 's1', completed: false });
    // Non-shopping collections still append raw (no merge semantics).
    await p.append('events', [{ id: 'e1' }]);
    await p.append('events', [{ id: 'e1' }]);
    expect(await p.loadCollection('events')).toHaveLength(2);
  });
});
