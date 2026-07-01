// Per-turn router for the unified copilot bar: decide whether a message goes to the cloud ADK agent
// (real multi-agent tool-calling over MCP) or the local copilot harness (fast, offline-ok Q&A + staged
// suggestions). Pure + unit-tested — the misroute mitigation lives here.
//
// Policy:
//   • agent unreachable  → 'local' (resilience; the bar always works)
//   • forced (escalate)  → 'agent' (the manual override button)
//   • else heuristic: ACTION/agentic intent → 'agent'; pure Q&A/explain → 'local'.
export type Engine = 'agent' | 'local';

// The bar IS the concierge: it must never refuse a request because the local copilot can't do it. So the
// DEFAULT is the capable cloud agent (real tool-calling over MCP). The local copilot ($0, offline-ok) is kept
// ONLY as a fast path for a PURE read-only question about existing household data — "what's on my calendar",
// "are we busy in July", "what bills are due". Anything that asks the bar to DO something (act, plan, book,
// reserve, delete, sort, get me…) goes to the agent — even phrasings the old verb-list missed ("make a
// reservation", "get us a table"). Keeping these regexes (ACTION/DISCOVERY) for the read-only carve-out below
// and for the unit tests; they no longer gate the agent (the agent is the default).
const ACTION = /\b(add|create|schedule|set ?up|book|reserve|reschedule|move|cancel|delete|remove|update|change|remind|cart|buy|order|make|get|put .* on (the )?(calendar|list))\b/i;
const DISCOVERY = /\b(find|recommend|plan|sort|organi[sz]e|arrange)\b|\bwhere (can|should|to)\b/i;
// A pure read-only question: opens with an interrogative AND carries no action/discovery verb. Only these
// stay local; everything else is the agent's job.
const READONLY_Q = /^\s*(what(?:'?s)?|when(?:'?s)?|who(?:'?s)?|which|are|is|was|were|do|does|did|how|why|explain|tell me|show me|list|any\b)/i;

export function routeTurn(message: string, opts: { agentReachable: boolean; forced?: boolean }): Engine {
  if (!opts.agentReachable) return 'local'; // resilience: the bar still answers (degraded) when the agent is down
  if (opts.forced) return 'agent';
  const m = (message || '').trim();
  // Pure read-only question with no action/discovery intent → local (fast/cheap). EVERYTHING else → agent.
  if (READONLY_Q.test(m) && !ACTION.test(m) && !DISCOVERY.test(m)) return 'local';
  return 'agent';
}
