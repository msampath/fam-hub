// Async agent jobs (roadmap "Backlog High — Async agent jobs") — the storage behind
// POST /api/agent/chat-async + GET /api/agent/job/:id. One row per agent turn, walked
// queued → running → done|error by an IN-PROCESS worker in server.ts.
//
// SCOPE (deliberate, per the roadmap): the worker runs immediately, inside the caller's JWT lifetime —
// no durable queue, no webhooks, no FastAPI BackgroundTasks. If the server process dies mid-turn the row
// stays 'running' forever; the client poller (agentClient.askConciergeAgentAsync) gives up honestly after
// ~3 minutes instead of pretending. That trade kills the agent-turn spinner without inventing infra.
//
// SECURITY INVARIANT (same as StorageAdapter): every operation is household-scoped. SQLite app-enforces
// the filter (no RLS engine); Supabase enforces it with DB RLS via the caller's JWT-scoped client — the
// explicit householdId there is belt-and-suspenders on top of RLS, mirroring SupabaseAdapter.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SqliteAdapter } from './sqlite';

// Bounded growth: rows are never listed/deleted by the routes/worker (see the SCOPE note above), so a
// fresh insert also prunes THIS household's own rows older than this — otherwise the table grows
// unboundedly over the life of a deployment. Mirrors src/mcp/persistence.ts's webCachePut prune-on-write.
const AGENT_JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type AgentJobStatus = 'queued' | 'running' | 'done' | 'error';

export interface AgentJob {
  id: string;
  status: AgentJobStatus;
  message: string;               // the user's ask (as queued)
  reply: string | null;          // the agent's answer — or, when status='error', the honest failure text
  actions: unknown[] | null;     // the agent's actions array (jsonb in Supabase, JSON text in SQLite)
  model: string | null;          // which model actually answered (primary or the fallback it walked to)
  sessionId: string | null;      // the agent session — round-tripped so a follow-up turn can continue it
  createdAt: string;
  updatedAt: string;
}

export interface AgentJobPatch {
  status: AgentJobStatus;
  reply?: string;
  actions?: unknown[];
  model?: string;
  sessionId?: string;
}

// The three operations the routes/worker need — nothing speculative (no list, no delete; a stuck-'running'
// row is inert and invisible unless polled by id).
export interface AgentJobStore {
  insert(id: string, message: string): Promise<void>;
  update(id: string, patch: AgentJobPatch): Promise<void>;
  get(id: string): Promise<AgentJob | null>;
}

// Coerce an unknown status string into the enum (a hand-edited row shouldn't crash the poller).
function normStatus(s: unknown): AgentJobStatus {
  return s === 'queued' || s === 'running' || s === 'done' || s === 'error' ? s : 'error';
}

// ── SQLite (the LAN appliance) — wraps the adapter's sync helpers; app-enforced household scoping. ──
export class SqliteAgentJobStore implements AgentJobStore {
  constructor(private adapter: SqliteAdapter, private householdId: string) {}

  async insert(id: string, message: string): Promise<void> {
    this.adapter.insertAgentJob(this.householdId, id, message);
    // Best-effort prune (see AGENT_JOB_MAX_AGE_MS above) — never blocks/breaks job creation.
    try { this.adapter.pruneAgentJobs(this.householdId, new Date(Date.now() - AGENT_JOB_MAX_AGE_MS).toISOString()); } catch { /* best-effort */ }
  }

  async update(id: string, patch: AgentJobPatch): Promise<void> {
    this.adapter.updateAgentJob(this.householdId, id, {
      status: patch.status,
      reply: patch.reply,
      actions: patch.actions !== undefined ? JSON.stringify(patch.actions) : undefined,
      model: patch.model,
      sessionId: patch.sessionId,
    });
  }

  async get(id: string): Promise<AgentJob | null> {
    const row = this.adapter.getAgentJob(this.householdId, id);
    if (!row) return null;
    let actions: unknown[] | null = null;
    try { const p = row.actions != null ? JSON.parse(row.actions) : null; actions = Array.isArray(p) ? p : null; } catch { actions = null; }
    return {
      id: row.id, status: normStatus(row.status), message: row.message,
      reply: row.reply ?? null, actions, model: row.model ?? null, sessionId: row.session_id ?? null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }
}

// ── Supabase (cloud) — a PER-REQUEST client built from the caller's JWT (see agentJobStoreFor in
// server.ts), so Postgres RLS scopes every row to that caller's household. ──
export class SupabaseAgentJobStore implements AgentJobStore {
  constructor(private client: SupabaseClient, private householdId: string) {}

  async insert(id: string, message: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.client.from('agent_jobs').insert({
      id, household_id: this.householdId, status: 'queued', message, created_at: now, updated_at: now,
    });
    // Surfaces "relation agent_jobs does not exist" until the morning migration is pasted — the route
    // turns that into a clean 500, and nothing calls chat-async before the UI wiring lands.
    if (error) throw new Error(`agent_jobs insert failed: ${error.message}`);
    // Best-effort prune (see AGENT_JOB_MAX_AGE_MS above) — a failure here costs nothing but slightly
    // slower cleanup, never the job just queued.
    try {
      await this.client.from('agent_jobs').delete()
        .eq('household_id', this.householdId).lt('created_at', new Date(Date.now() - AGENT_JOB_MAX_AGE_MS).toISOString());
    } catch { /* best-effort */ }
  }

  async update(id: string, patch: AgentJobPatch): Promise<void> {
    const { error } = await this.client.from('agent_jobs')
      .update({
        status: patch.status,
        ...(patch.reply !== undefined ? { reply: patch.reply } : {}),
        ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.sessionId !== undefined ? { session_id: patch.sessionId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('household_id', this.householdId).eq('id', id);
    if (error) throw new Error(`agent_jobs update failed: ${error.message}`);
  }

  async get(id: string): Promise<AgentJob | null> {
    const { data, error } = await this.client.from('agent_jobs').select('*')
      .eq('household_id', this.householdId).eq('id', id).maybeSingle();
    if (error) throw new Error(`agent_jobs read failed: ${error.message}`);
    if (!data) return null;
    return {
      id: String(data.id), status: normStatus(data.status), message: String(data.message ?? ''),
      reply: data.reply != null ? String(data.reply) : null,
      actions: Array.isArray(data.actions) ? data.actions : null,
      model: data.model != null ? String(data.model) : null,
      sessionId: data.session_id != null ? String(data.session_id) : null,
      createdAt: String(data.created_at ?? ''), updatedAt: String(data.updated_at ?? ''),
    };
  }
}

// The caller's household under their own JWT — RLS on household_members returns only their membership
// (the same lookup src/mcp/persistence.ts SupabasePersistence.householdId uses). null → no household yet.
export async function lookupHouseholdId(client: SupabaseClient): Promise<string | null> {
  const { data, error } = await client.from('household_members').select('household_id').limit(1);
  if (error) throw new Error(`household lookup failed: ${error.message}`);
  const hid = data?.[0]?.household_id;
  return hid ? String(hid) : null;
}
