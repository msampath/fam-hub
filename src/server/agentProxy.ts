import { Router } from 'express';
import type { Request } from 'express';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { aiErrorResponse } from './gemini';
import { requireAuth, aiRateLimit } from './middleware';
import { LOCAL_MODE } from './config';
import { storageMode, getSqliteAdapter } from '../storage';
import { SqliteAgentJobStore, SupabaseAgentJobStore, lookupHouseholdId, type AgentJobStore } from '../storage/agentJobs';

const AGENT_BASE_URL = (process.env.AGENT_BASE_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');

async function forwardAgentChat(authHeader: string, body: unknown): Promise<{ status: number; text: string }> {
  const upstream = await fetch(`${AGENT_BASE_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: upstream.status, text: await upstream.text() };
}

async function agentJobStoreFor(req: Request): Promise<AgentJobStore | null> {
  if (LOCAL_MODE) return new SqliteAgentJobStore(getSqliteAdapter(), req.householdId!);
  const token = String(req.headers.authorization || '').slice(7);
  const client = createClient(
    process.env.VITE_SUPABASE_URL || '',
    process.env.VITE_SUPABASE_ANON_KEY || '',
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } },
  );
  const hid = await lookupHouseholdId(client);
  return hid ? new SupabaseAgentJobStore(client, hid) : null;
}

export const agentProxyRouter = Router();

agentProxyRouter.post('/chat', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const upstream = await forwardAgentChat(req.headers.authorization as string, req.body);
    res.status(upstream.status).type('application/json').send(upstream.text);
  } catch (err) {
    return aiErrorResponse(res, err, 'The concierge agent is unavailable right now.');
  }
});

agentProxyRouter.post('/chat-async', requireAuth, aiRateLimit, async (req, res) => {
  try {
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) return res.status(400).json({ error: 'A message is required.' });
    const store = await agentJobStoreFor(req);
    if (!store) return res.status(403).json({ error: 'No household found for this account.' });
    const jobId = randomUUID();
    await store.insert(jobId, message);
    const authHeader = req.headers.authorization as string;
    const body = req.body;
    void (async () => {
      try {
        await store.update(jobId, { status: 'running' });
        const upstream = await forwardAgentChat(authHeader, body);
        if (upstream.status >= 200 && upstream.status < 300) {
          let data: any = {};
          try { data = JSON.parse(upstream.text); } catch { /* non-JSON 2xx — treat fields as absent */ }
          await store.update(jobId, {
            status: 'done',
            reply: String(data?.reply ?? ''),
            actions: Array.isArray(data?.actions) ? data.actions : [],
            ...(data?.model ? { model: String(data.model) } : {}),
            ...(data?.sessionId ? { sessionId: String(data.sessionId) } : {}),
          });
        } else {
          let msg = `The agent returned HTTP ${upstream.status}.`;
          try { const e = JSON.parse(upstream.text); if (e?.error) msg = String(e.error); } catch { /* keep the status line */ }
          await store.update(jobId, { status: 'error', reply: msg });
        }
      } catch (err: any) {
        console.error('agent job worker error:', err?.message || err);
        try { await store.update(jobId, { status: 'error', reply: 'The concierge agent is unavailable right now.' }); }
        catch (e2: any) { console.error('agent job error-write failed (job stays running):', e2?.message || e2); }
      }
    })();
    return res.json({ jobId });
  } catch (err: any) {
    console.error('agent chat-async error:', err?.message || err);
    return res.status(500).json({ error: 'Could not queue the agent request.' });
  }
});

agentProxyRouter.get('/job/:id', requireAuth, async (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return res.status(400).json({ error: 'Invalid job id.' });
    const store = await agentJobStoreFor(req);
    if (!store) return res.status(403).json({ error: 'No household found for this account.' });
    const job = await store.get(id);
    if (!job) return res.status(404).json({ error: 'No such job.' });
    return res.json(job);
  } catch (err: any) {
    console.error('agent job read error:', err?.message || err);
    return res.status(500).json({ error: 'Could not read the job.' });
  }
});
