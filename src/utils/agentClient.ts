// Client for the Concierge ADK agent service (the capstone demo's agent backend).
//
// The browser calls a SAME-ORIGIN Express route (/api/agent/chat), NOT the Python agent directly. Why:
// the production CSP (`connect-src 'self'`) BLOCKS a direct cross-origin fetch to the agent's own
// host/IP; same-origin also avoids CORS and baking the agent URL into the client bundle. server.ts
// forwards /api/agent/chat to the ADK service (its AGENT_BASE_URL), passing the visitor's Supabase JWT so
// the agent's MCP writes are RLS-isolated to that visitor (the per-visitor isolation invariant).
//
// VITE_AGENT_BASE_URL is now just an ON/OFF FLAG that reveals the agent panel (any truthy value enables
// it) — its value is no longer used as a URL by the client; the server decides the real agent address.

// Same-origin path — proxied to the agent by server.ts (so the prod CSP `connect-src 'self'` allows it).
const AGENT_CHAT_PATH = '/api/agent/chat';

/** Whether the in-app agent panel is enabled — gates the agent UI so the app is unchanged without it. */
export function isAgentConfigured(): boolean {
  return !!(import.meta.env.VITE_AGENT_BASE_URL as string | undefined);
}

// A mutating tool result the agent took, surfaced to the bar so it renders the same confirmations / Approve
// queue the local copilot does. `status` mirrors the MCP layer: 'applied' (auto-tier, already persisted
// server-side), 'requires_confirmation' / 'requires_stepup' (staged for approval), or 'rejected'.
export interface AgentAction {
  tool: string;
  status: string;
  tier?: string;
  artifact?: unknown;
  message?: string;
}

export interface AgentReply {
  reply: string;
  sessionId: string;
  actions: AgentAction[];
  model?: string; // the Gemini model that actually answered (primary or the fallback it walked to)
}

// Extra context handed to the agent so it can hear the user's framing instead of starting cold: the recent
// local-copilot conversation + the family roster (names + ages, so it stops guessing ages).
export interface AgentTurnContext {
  history?: { role: string; text: string }[];
  family?: string;
  // The family's CURRENT tracked goals, sent every turn so the agent can reference the right id to update a
  // goal/step and honestly "recheck" (it has no get_goals tool and can't see goals from a prior session).
  goals?: { id: string; text: string; status: string; nextAction?: string; steps: { title: string; status: string }[] }[];
  // The family's name for the copilot (household setting) — the agent answers to it.
  copilotName?: string;
  // Household-defined store lists (Phase-5) — so the shopping specialist routes to THEIR lists.
  stores?: string[];
  // The CURRENT week's meal plans, meal-labeled — an adjustment turn re-issues that meal's full week.
  mealplan?: { date: string; dish: string; meal?: string; note?: string }[];
}

// Coerce a raw JSON action element into the AgentAction shape. Defense-in-depth at the wire boundary (the
// server is authoritative for tiering, and the ledger re-derives risk from `status` + drops unknown tools) —
// but normalizing here keeps a malformed element from carrying an unexpected-typed tool/status downstream.
function normAgentAction(a: any): AgentAction | null {
  if (!a || typeof a.tool !== 'string') return null;
  return { tool: a.tool, status: String(a.status ?? ''), tier: a.tier, artifact: a.artifact, message: a.message };
}

// One turn's request body — shared by the sync POST and the async (queued) POST so the two paths carry
// the IDENTICAL context contract (the server forwards this body to the agent verbatim in both cases).
function buildTurnBody(sessionId: string, message: string, ctx?: AgentTurnContext): Record<string, unknown> {
  return {
    message,
    ...(sessionId ? { sessionId } : {}),
    ...(ctx?.history?.length ? { history: ctx.history } : {}),
    ...(ctx?.family ? { family: ctx.family } : {}),
    ...(ctx?.goals?.length ? { goals: ctx.goals } : {}),
    ...(ctx?.copilotName && ctx.copilotName !== 'Copilot' ? { copilotName: ctx.copilotName } : {}),
    ...(ctx?.stores?.length ? { stores: ctx.stores } : {}),
    ...(ctx?.mealplan?.length ? { mealplan: ctx.mealplan } : {}),
  };
}

// Normalize a raw wire reply (the sync response body, or a done job row) into the AgentReply shape.
function normAgentReply(data: any, fallbackSessionId: string): AgentReply {
  return {
    reply: String(data?.reply ?? ''),
    sessionId: String(data?.sessionId ?? fallbackSessionId ?? ''),
    actions: (Array.isArray(data?.actions) ? data.actions : []).map(normAgentAction).filter((a: AgentAction | null): a is AgentAction => a !== null),
    ...(data?.model ? { model: String(data.model) } : {}),
  };
}

/**
 * Ask the concierge agent. `jwt` is the visitor's Supabase access token (from getAuthToken()); pass the
 * `sessionId` returned by the previous reply to continue the conversation, or '' to start a new one. `ctx`
 * carries the prior conversation + family roster so an escalated turn has the same context the copilot had.
 * Throws on a non-2xx / network error so the caller can surface a clear message.
 */
export async function askConciergeAgent(jwt: string | null, sessionId: string, message: string, ctx?: AgentTurnContext): Promise<AgentReply> {
  if (!isAgentConfigured()) throw new Error('The concierge agent is not configured (VITE_AGENT_BASE_URL).');
  const res = await fetch(AGENT_CHAT_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(buildTurnBody(sessionId, message, ctx)),
  });
  if (!res.ok) throw new Error(`The agent is unavailable right now (${res.status}). Try again in a moment.`);
  const data = await res.json().catch(() => ({} as any));
  return normAgentReply(data, sessionId);
}

// ── Async variant (roadmap "Async agent jobs") — queue-and-poll instead of one held-open request ──
// POST /api/agent/chat-async returns { jobId } immediately; the server's in-process worker runs the turn
// and lands the row done/error; we poll GET /api/agent/job/:id until then. Same parameters and resolved
// shape as askConciergeAgent, so the eventual UI swap is a drop-in (deliberately NOT wired into the panel
// yet — that's a later owner-visible change; this ships tested and dark).
const AGENT_CHAT_ASYNC_PATH = '/api/agent/chat-async';
const AGENT_JOB_PATH = '/api/agent/job';
export const AGENT_JOB_POLL_MS = 2000;
// 90 polls × 2s ≈ 3 minutes, then give up honestly. Poll COUNT (not wall-clock) so the deadline is
// deterministic under fake timers and can't mis-fire if the tab sleeps mid-poll.
export const AGENT_JOB_MAX_POLLS = 90;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function askConciergeAgentAsync(jwt: string | null, sessionId: string, message: string, ctx?: AgentTurnContext): Promise<AgentReply> {
  if (!isAgentConfigured()) throw new Error('The concierge agent is not configured (VITE_AGENT_BASE_URL).');
  const headers = { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}) };
  const res = await fetch(AGENT_CHAT_ASYNC_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(buildTurnBody(sessionId, message, ctx)),
  });
  if (!res.ok) throw new Error(`The agent is unavailable right now (${res.status}). Try again in a moment.`);
  const accepted = await res.json().catch(() => ({} as any));
  const jobId = typeof accepted?.jobId === 'string' ? accepted.jobId : '';
  if (!jobId) throw new Error('The agent did not accept the request. Try again in a moment.');
  for (let poll = 0; poll < AGENT_JOB_MAX_POLLS; poll++) {
    await sleep(AGENT_JOB_POLL_MS);
    const r = await fetch(`${AGENT_JOB_PATH}/${jobId}`, { headers });
    // A failed poll is terminal (401 session expired / 404 job gone / 5xx) — surface it rather than spin.
    if (!r.ok) throw new Error(`The agent job could not be checked (${r.status}). Try again in a moment.`);
    const job: any = await r.json().catch(() => ({} as any));
    if (job?.status === 'done') return normAgentReply(job, sessionId);
    // The worker stores the honest failure text in `reply` when status='error' (see server.ts).
    if (job?.status === 'error') throw new Error(String(job?.reply || 'The agent could not answer that. Try again in a moment.'));
    // queued / running → keep polling.
  }
  throw new Error('The agent is still working after 3 minutes. It may finish in the background — try asking again in a bit.');
}
