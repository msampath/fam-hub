import { describe, it, expect, vi } from 'vitest';
import { SqliteAdapter } from '../storage/sqlite';
import { SqliteAgentJobStore, SupabaseAgentJobStore } from '../storage/agentJobs';

// Bounded-growth fix: agent_jobs rows are never listed/deleted by the routes/worker (see the SCOPE
// note in agentJobs.ts), so a fresh insert also prunes this household's own stale rows as a side effect.

describe('SqliteAdapter.pruneAgentJobs', () => {
  it('deletes only THIS household\'s rows at/after the cutoff, leaving newer/other-household rows', () => {
    const adapter = new SqliteAdapter(':memory:');
    adapter.insertAgentJob('hhA', 'job1', 'hello');
    adapter.insertAgentJob('hhB', 'job2', 'hello'); // different household — must survive regardless

    // A cutoff in the future makes the just-inserted row count as "older than" it → pruned.
    adapter.pruneAgentJobs('hhA', new Date(Date.now() + 60_000).toISOString());
    expect(adapter.getAgentJob('hhA', 'job1')).toBeNull();
    expect(adapter.getAgentJob('hhB', 'job2')).not.toBeNull();

    adapter.insertAgentJob('hhA', 'job3', 'hi again');
    // A cutoff in the past leaves the fresh row untouched.
    adapter.pruneAgentJobs('hhA', new Date(Date.now() - 60_000).toISOString());
    expect(adapter.getAgentJob('hhA', 'job3')).not.toBeNull();
  });
});

describe('SqliteAgentJobStore.insert', () => {
  it('also prunes this household\'s stale rows as a side effect', async () => {
    const adapter = { insertAgentJob: vi.fn(), pruneAgentJobs: vi.fn() } as any;
    const store = new SqliteAgentJobStore(adapter, 'hhD');
    await store.insert('job9', 'hello');
    expect(adapter.insertAgentJob).toHaveBeenCalledWith('hhD', 'job9', 'hello');
    expect(adapter.pruneAgentJobs).toHaveBeenCalledWith('hhD', expect.any(String));
  });

  it('a prune failure never breaks job creation (best-effort)', async () => {
    const adapter = { insertAgentJob: vi.fn(), pruneAgentJobs: vi.fn(() => { throw new Error('boom'); }) } as any;
    const store = new SqliteAgentJobStore(adapter, 'hhD');
    await expect(store.insert('job10', 'hello')).resolves.toBeUndefined();
  });
});

describe('SupabaseAgentJobStore.insert', () => {
  it('inserts the job then best-effort prunes this household\'s stale rows', async () => {
    const calls: { insertPayload: any; deleteEqs: [string, any][] } = { insertPayload: null, deleteEqs: [] };
    const deleteBuilder: any = {
      eq: vi.fn((col: string, val: any) => { calls.deleteEqs.push([col, val]); return deleteBuilder; }),
      lt: vi.fn((col: string, val: any) => { calls.deleteEqs.push([col, val]); return Promise.resolve({ error: null }); }),
    };
    const client: any = {
      from: vi.fn(() => ({
        insert: vi.fn((p: any) => { calls.insertPayload = p; return Promise.resolve({ error: null }); }),
        delete: vi.fn(() => deleteBuilder),
      })),
    };
    const store = new SupabaseAgentJobStore(client, 'hhF');
    await store.insert('job5', 'hi');
    expect(calls.insertPayload).toMatchObject({ id: 'job5', household_id: 'hhF', status: 'queued', message: 'hi' });
    expect(calls.deleteEqs).toContainEqual(['household_id', 'hhF']);
    expect(calls.deleteEqs.some(([col]) => col === 'created_at')).toBe(true);
  });

  it('a prune failure never breaks job creation (best-effort)', async () => {
    const deleteBuilder: any = {
      eq: vi.fn(() => deleteBuilder),
      lt: vi.fn(() => Promise.reject(new Error('boom'))),
    };
    const client: any = {
      from: vi.fn(() => ({
        insert: vi.fn(() => Promise.resolve({ error: null })),
        delete: vi.fn(() => deleteBuilder),
      })),
    };
    const store = new SupabaseAgentJobStore(client, 'hhF');
    await expect(store.insert('job6', 'hi')).resolves.toBeUndefined();
  });
});
