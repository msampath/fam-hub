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
}

// Coerce a raw JSON action element into the AgentAction shape. Defense-in-depth at the wire boundary (the
// server is authoritative for tiering, and the ledger re-derives risk from `status` + drops unknown tools) —
// but normalizing here keeps a malformed element from carrying an unexpected-typed tool/status downstream.
function normAgentAction(a: any): AgentAction | null {
  if (!a || typeof a.tool !== 'string') return null;
  return { tool: a.tool, status: String(a.status ?? ''), tier: a.tier, artifact: a.artifact, message: a.message };
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
    body: JSON.stringify({
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(ctx?.history?.length ? { history: ctx.history } : {}),
      ...(ctx?.family ? { family: ctx.family } : {}),
      ...(ctx?.goals?.length ? { goals: ctx.goals } : {}),
      ...(ctx?.copilotName && ctx.copilotName !== 'Copilot' ? { copilotName: ctx.copilotName } : {}),
    }),
  });
  if (!res.ok) throw new Error(`The agent is unavailable right now (${res.status}). Try again in a moment.`);
  const data = await res.json().catch(() => ({} as any));
  return {
    reply: String(data?.reply ?? ''),
    sessionId: String(data?.sessionId ?? sessionId ?? ''),
    actions: (Array.isArray(data?.actions) ? data.actions : []).map(normAgentAction).filter((a: AgentAction | null): a is AgentAction => a !== null),
    ...(data?.model ? { model: String(data.model) } : {}),
  };
}
