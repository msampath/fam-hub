// KAGGLE_EVAL: MCP Server — the concierge agent's primary toolbelt.
//
// Pure tool DEFINITIONS + handlers that wrap the WORKING Tool Registry (src/utils/toolRegistry.ts),
// which itself delegates validation to the aiActions.ts trust boundary. Security is
// SERVER-AUTHORITATIVE in this layer, not trusted to the model:
//   • the NO-PAYMENT INVARIANT — the agent can never complete a purchase or transfer; `reserve` and
//     `add_to_cart` are DRAFT links only (the parent checks out themselves), and there is NO tool that
//     moves money;
//   • the RISK TIERS — auto (reversible internal write) / confirm (staged for human approval) / stepup
//     (physical world → confirm + PIN) — decide a validated payload's status here.
//
// This slice VALIDATES + tier-gates and returns the clamped artifact (what WOULD be written/staged);
// Supabase persistence under the visitor's JWT lands in the next slice. The MCP transport
// (src/mcp/server.ts) is a thin stdio adapter over these PURE handlers, so they're unit-tested directly.
import { TOOL_REGISTRY, type ToolValidateCtx } from '../utils/toolRegistry';
import { buildSuggestionFromPayload } from '../utils/aiActions';
import { SHOP_STORES } from '../constants';
import type { RiskTier, ShoppingItem } from '../types';

export type McpStatus =
  | 'validated'              // auto tier — passed validation; would be applied (no persistence configured)
  | 'applied'               // auto tier — validated AND persisted to Supabase under the visitor's JWT
  | 'requires_confirmation' // confirm tier — staged for human approval (incl. no-payment drafts)
  | 'requires_stepup'       // stepup tier — physical world; needs confirm + PIN
  | 'unavailable'           // capability has no executor wired (honest stub, e.g. IoT)
  | 'rejected';             // failed validation / unknown tool

export interface McpToolResult {
  ok: boolean;
  tool: string;
  tier: RiskTier;
  status: McpStatus;
  artifact?: unknown;       // the validated, clamped payload (event/chores/items/draft)
  message?: string;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  // Optional: prepare_handoff is advertised here (ListTools) but EXECUTED by the server's provenance-gated
  // handler (src/mcp/server.ts), not via this run — so it carries no run. Every other tool has one.
  run?: (args: any, ctx: ToolValidateCtx) => McpToolResult;
}

// A validated payload's status follows its risk tier: auto applies; confirm/stepup wait for a human.
function statusForTier(tier: RiskTier): McpStatus {
  return tier === 'auto' ? 'validated' : tier === 'confirm' ? 'requires_confirmation' : 'requires_stepup';
}

// Run a registry-backed tool: validate via the shared aiActions trust boundary, then tier-gate. The
// validator clamps/normalizes (or returns null) — the MCP layer never re-implements validation.
function runRegistryTool(name: string, args: any, ctx: ToolValidateCtx): McpToolResult {
  const tool = TOOL_REGISTRY[name];
  if (!tool) return { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `Unknown tool: ${name}` };
  const artifact = tool.validate(args ?? {}, ctx);
  if (artifact == null) {
    return { ok: false, tool: name, tier: tool.riskTier, status: 'rejected', message: 'Payload failed validation.' };
  }
  return { ok: true, tool: name, tier: tool.riskTier, status: statusForTier(tool.riskTier), artifact };
}

// Build the validation context (shared by the stdio entry + tests). In this persistence-free slice the
// roster/events default empty (the entry loads them from Supabase once persistence is wired); `today`
// is supplied by the caller (the entry uses the server's local date).
export function buildToolCtx(today: string, over?: Partial<ToolValidateCtx>): ToolValidateCtx {
  return {
    familyMembers: over?.familyMembers ?? [],
    events: over?.events ?? [],
    today,
    validStores: over?.validStores ?? (SHOP_STORES as readonly ShoppingItem['store'][]),
  };
}

const memberArray = { type: 'array', items: { type: 'string' }, description: 'Family member names, or ["Everyone"].' };

// The six state-mutating tools that wrap TOOL_REGISTRY — shape/description only; their `run` is
// synthesized once below from the name (so the tool name isn't repeated as a string literal, which
// risked a copy-paste mismatch routing to the wrong validator).
const REGISTRY_TOOL_DEFS: Omit<McpToolDef, 'run'>[] = [
  {
    name: 'create_event',
    description: 'Create a household calendar event (auto-applied, reversible).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short event title.' },
        description: { type: 'string' },
        start: { type: 'string', description: 'YYYY-MM-DD (today or later).' },
        end: { type: 'string', description: 'YYYY-MM-DD (optional).' },
        startTime: { type: 'string', description: "24h 'HH:MM' (optional)." },
        endTime: { type: 'string', description: "24h 'HH:MM' (optional)." },
        category: { type: 'string', description: 'School|Camp|Sports|Arts|Holiday|Other' },
        members: memberArray,
      },
      required: ['title', 'start'],
    },
  },
  {
    name: 'add_chore',
    description: 'Add a chore for a kid (auto-applied). Multi-kid phrases ("both kids") expand to one per kid.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        assignedTo: { type: 'string', description: 'A family member name, or "both kids"/"all kids"/"everyone".' },
        points: { type: 'number' },
        timesPerDay: { type: 'number' },
        repeatType: { type: 'string', description: 'daily|weekly' },
        scheduleTimeOfDay: { type: 'string', description: 'Morning|Afternoon|Evening|Anytime' },
      },
      required: ['title', 'assignedTo'],
    },
  },
  {
    name: 'delete_chore',
    description: 'Delete ONE chore (destructive — STAGED for the parent to confirm in Approvals). Identify it by its exact "title" (or "id"). Use only when the parent explicitly asks to delete/remove a chore.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: "The chore's title to delete." },
        id: { type: 'string', description: 'The chore id (if known).' },
      },
    },
  },
  {
    name: 'clear_chores',
    description: 'Delete ALL chores (destructive — STAGED as a single approval the parent confirms). Use when the parent asks to clear/delete all chores or wipe the chore list.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_chore',
    description: 'Edit an EXISTING chore (confirm tier — staged for approval). Identify the target by "matchTitle" (its current exact title) or "id"; supply only the fields to change: title (rename), points, timesPerDay, repeatType (daily|weekly), scheduleTimeOfDay, assignedTo.',
    inputSchema: {
      type: 'object',
      properties: {
        matchTitle: { type: 'string', description: 'EXACT current title of the chore to change.' },
        id: { type: 'string', description: 'The chore id (alternative to matchTitle).' },
        title: { type: 'string', description: 'New title (rename).' },
        points: { type: 'number' },
        timesPerDay: { type: 'number' },
        repeatType: { type: 'string', description: 'daily|weekly' },
        scheduleTimeOfDay: { type: 'string', description: 'Morning|Afternoon|Evening|Anytime' },
        assignedTo: { type: 'string', description: 'Reassign to a family member name.' },
      },
      required: ['matchTitle'],
    },
  },
  {
    name: 'add_shopping_item',
    description: 'Add a shopping-list item to a store (auto-applied).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The item.' },
        store: { type: 'string', description: "One of the household's store lists (defaults: Costco|Indian Store|Grocery Store|Other); unknown stores are re-routed to their general list." },
      },
      required: ['text'],
    },
  },
  {
    name: 'delete_shopping_item',
    description: 'Delete ONE shopping-list item (destructive — STAGED for the parent to confirm). Identify it by its exact "text" (or "id"). Use only when the parent explicitly asks to delete/remove an item.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The item text to delete.' },
        id: { type: 'string', description: 'The item id (if known).' },
      },
    },
  },
  {
    name: 'update_event',
    description: 'Move/reschedule/change an EXISTING event, OR mark it free/busy — WITHOUT deleting it (confirm '
      + 'tier — staged for approval). Set `freeBusy:"free"` to make an event stop blocking the day (e.g. a '
      + 'holiday the family wants ignored as a conflict) or `"busy"` to mark it occupying; the event stays on '
      + 'the calendar. Prefer this over delete_event when the parent wants to KEEP an event but not have it block.',
    inputSchema: {
      type: 'object',
      properties: {
        matchTitle: { type: 'string', description: 'EXACT current title of the event to change.' },
        matchStart: { type: 'string', description: 'Its current start date YYYY-MM-DD (disambiguates).' },
        start: { type: 'string' }, end: { type: 'string' },
        startTime: { type: 'string' }, endTime: { type: 'string' },
        title: { type: 'string' }, category: { type: 'string' }, members: memberArray,
        description: { type: 'string' },
        freeBusy: { type: 'string', description: "'free' or 'busy' — set the event's availability WITHOUT deleting it (e.g. mark a holiday 'free')." },
      },
      required: ['matchTitle'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete ONE existing event (destructive — STAGED for the parent to confirm in Approvals). '
      + 'Identify it by its exact "title" (and "start" date YYYY-MM-DD to disambiguate). Use when the parent '
      + 'agrees to clear/replace an event (e.g. a conflicting plan a trip would override) — never delete without an explicit yes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'EXACT title of the event to delete.' },
        start: { type: 'string', description: 'Its start date YYYY-MM-DD (disambiguates same-named events).' },
        id: { type: 'string', description: 'The event id (if known).' },
      },
      required: ['title'],
    },
  },
  {
    name: 'set_goal',
    description: 'Record (or update) a multi-step GOAL the family is tracking — e.g. "Plan a Mount Rainier '
      + 'day trip". Auto-applied. Pass the goal `text` and a `steps` plan (each {title}); set `id` to UPDATE '
      + 'an existing goal. Use this FIRST when the user gives you a multi-step task, so the goal + its plan '
      + 'become visible and the family can follow it through; then do the reversible steps and stage the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The goal, e.g. "Plan a Mount Rainier day trip for July 11".' },
        id: { type: 'string', description: 'Existing goal id to update (omit to create a new goal).' },
        status: { type: 'string', description: 'active|waiting|done|abandoned (defaults to active).' },
        nextAction: { type: 'string', description: 'The next concrete step for the family.' },
        category: { type: 'string', description: 'e.g. outing|birthday|camps (optional).' },
        context: { type: 'string', description: 'The FACTS you have gathered for this goal so far — the chosen date, the itinerary/picks, party size, decisions made. Carry it forward on every update so you (or a future turn) can resume WITHOUT re-asking. Keep it brief.' },
        steps: {
          type: 'array',
          description: 'The plan — ordered steps.',
          items: { type: 'object', properties: { title: { type: 'string' }, status: { type: 'string', description: 'pending|active|done|blocked' } } },
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'reserve',
    description: 'Stage a reservation DRAFT — a booking deep-link the parent opens to book themselves. NEVER books or pays (no-payment invariant). Confirm tier.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The venue name (a REAL place).' },
        start: { type: 'string', description: 'YYYY-MM-DD (optional).' },
        startTime: { type: 'string', description: "24h 'HH:MM' (optional)." },
      },
      required: ['title'],
    },
  },
  {
    name: 'add_to_cart',
    description: 'Stage an Amazon cart DRAFT — a prefilled link the parent checks out themselves in the Amazon app. NEVER purchases or pays (no-payment invariant). Confirm tier.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The item to add.' },
        quantity: { type: 'number', description: 'Optional quantity.' },
      },
      required: ['text'],
    },
  },
];

// The toolbelt. The six registry tools share one `run` (validate via TOOL_REGISTRY by name);
// `home_control` is an HONEST stub (no executor → "unavailable", not a fabricated success). No
// purchase/checkout/pay tool exists — the no-payment invariant, by design.
export const MCP_TOOLS: McpToolDef[] = [
  ...REGISTRY_TOOL_DEFS.map((d): McpToolDef => ({ ...d, run: (a, ctx) => runRegistryTool(d.name, a, ctx) })),
  {
    // prepare_handoff (A3) — the loop-closer. Confirm-tier DRAFT: a REAL booking/permit/registration URL
    // (found via web_search/fetch_page) plus the details the agent GATHERED for the parent to enter —
    // a plain link cannot fill the venue's form, and the agent never fills, submits, or pays (no-payment
    // invariant). ADVERTISED here (ListTools) but EXECUTED by the server's PROVENANCE-GATED handler
    // (src/mcp/server.ts) — which additionally rejects a link the agent didn't actually see published this
    // run. It therefore carries NO `run`: a run here would be a strictly-weaker copy that bypasses that gate.
    name: 'prepare_handoff',
    description: 'Stage a HANDOFF draft to finish a task the parent must complete themselves — a REAL '
      + 'official URL (booking/permit/registration/ticket page, found via web_search/fetch_page) with the '
      + 'details the parent will need to enter on that page. You do NOT fill the form, and you NEVER '
      + 'submit or pay; the parent opens the link, types the details, and submits. Use this (not reserve) '
      + 'once you have the real form URL — e.g. a recreation.gov timed-entry pass.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What this completes, e.g. "Mount Rainier timed-entry pass".' },
        url: { type: 'string', description: 'The REAL http(s) form/booking URL to open.' },
        fields: {
          type: 'array',
          description: 'Details the parent will need to enter on the page (label + value pairs you gathered).',
          items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } },
        },
      },
      required: ['title', 'url'],
    },
  },
  {
    // HONEST IoT stub — registered so the toolbelt is complete and the agent learns the capability
    // exists, but with no Home Assistant executor wired it returns "unavailable" rather than a
    // fabricated success (the project's anti-pattern rule). Wiring the executor flips this to a real
    // stepup (confirm + PIN) action.
    name: 'home_control',
    description: 'Control home devices (arm/disarm, lock/unlock, thermostat) — stepup tier. Currently UNAVAILABLE (no Home Assistant configured); performs no action.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'arm|disarm|lock|unlock|thermostat' },
        entity: { type: 'string', description: 'Target device/entity (optional).' },
        value: { type: 'string', description: 'e.g. thermostat setpoint (optional).' },
      },
      required: ['action'],
    },
    run: (_a, _ctx): McpToolResult => ({
      ok: false,
      tool: 'home_control',
      tier: 'stepup',
      status: 'unavailable',
      message: 'Home Assistant is not configured (no executor wired). This tool intentionally performs no action.',
    }),
  },
  {
    // suggest_event — a TAP-TO-ADD chip in chat (auto tier, reversible). It writes NOTHING: it hands the bar a
    // suggestion the parent adds with one tap (the local copilot returns these as `suggestions`; this is the
    // agent-path equivalent). Client-owned (like set_goal) — NOT in TOOL_COLLECTION, so persistResult leaves it
    // 'validated' and the client renders it as a chip. Its own run (not a registry/allowlist action).
    name: 'suggest_event',
    description: 'Offer the family a TAP-TO-ADD chip for a specific day (an outing pick). Auto-tier, reversible: '
      + 'it does NOT add anything — it renders a "+ Add" chip in chat the parent taps to put the event on the '
      + 'calendar. Call it for each day-pick you recommend (title + the day\'s YYYY-MM-DD + the venue link), so '
      + 'the family can add it in one tap — alongside naming the place with its link in your reply.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The place/activity name, e.g. "Woodland Park Zoo".' },
        start: { type: 'string', description: "The day YYYY-MM-DD for the outing." },
        category: { type: 'string', description: 'School|Camp|Sports|Arts|Holiday|Other (optional).' },
        note: { type: 'string', description: 'A short why / what-to-bring note (optional).' },
        url: { type: 'string', description: "The venue's REAL http(s) link (optional)." },
        members: memberArray,
      },
      required: ['title', 'start'],
    },
    run: (a, ctx): McpToolResult => {
      const artifact = buildSuggestionFromPayload(a, ctx.today);
      return artifact
        ? { ok: true, tool: 'suggest_event', tier: 'auto', status: 'validated', artifact }
        : { ok: false, tool: 'suggest_event', tier: 'auto', status: 'rejected', message: 'A suggestion needs a title.' };
    },
  },
];

export function getTool(name: string): McpToolDef | undefined {
  return MCP_TOOLS.find(t => t.name === name);
}
