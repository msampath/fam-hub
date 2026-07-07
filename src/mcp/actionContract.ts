// The ACTION CONTRACT — ONE declarative table describing every copilot action / MCP tool, so the four
// things that used to be hand-maintained in parallel are now declared ONCE and can't drift:
//   1. the allowlist of client-applied copilot actions (was: server.ts literal Set + toolRegistry keys),
//   2. each action's risk TIER (was: inline in every TOOL_REGISTRY entry),
//   3. the MUTATING set that becomes bar actions (was: server-side + a hand-kept Python literal in bridge.py),
//   4. the required-SELECTOR shape gate the Express sanitizer enforces (was: a per-type if-ladder that
//      only covered SOME actions, so the "second writer" was an incomplete, separately-maintained copy).
//
// This is the review-accepted "shared action-schema contract" (2026-07-06 super-review): the trust
// boundary gets a real contract without a Zod layer on one writer or a BFF hop. The three TS writers
// (client Tool Registry, Express sanitizer, MCP toolbelt) all derive from THIS; the Python agent consumes
// the generated `agent/concierge/action_contract.json` mirror (the agent runtime image ships `agent/`
// but NOT `src/`, so Python can't read this file directly — the JSON is its committed derivation, kept
// in lockstep by scripts/genActionContract.ts + a freshness test). The authoritative field-level clamping
// still lives in the aiActions.ts builders; this contract governs the ALLOWLIST/TIER/MUTATING/SELECTOR
// facts every boundary must agree on.
import type { RiskTier } from '../types';

// Which payload shape a targeted/destructive action must carry so a malformed "do everything" can't slip
// past the Express allowlist. 'none' = no reference required (creates + the explicit bulk verb clear_chores).
// Each rule is enforced by selectorSatisfied() below and mirrors the matching aiActions builder's null-check.
export type Selector =
  | 'none'
  | 'idOrTitle'        // delete_chore, delete_event  — id OR a title
  | 'idOrMatchTitle'   // update_event, update_chore  — id OR a matchTitle
  | 'idOrText'         // delete_shopping_item        — id OR item text
  | 'idOrName'         // move_document, delete_document — id OR doc name
  | 'idOrAll'          // delete_goal                 — a goal id OR all:true
  | 'goalText'         // set_goal                    — the goal text
  | 'days'             // set_meal_plan               — a non-empty days[]
  | 'mealSelector'     // delete_meal_plan            — meal OR weekStart OR all:true
  | 'title'            // reserve                     — a venue title
  | 'textOrTitle'      // add_to_cart                 — item text OR title
  | 'titleUrl'         // prepare_handoff (MCP-only)  — title + a real url
  | 'titleStart';      // suggest_event (MCP-only)    — title + a date

export interface ActionSpec {
  tier: RiskTier;       // auto (reversible internal) | confirm (staged) | stepup (physical + PIN)
  mutating: boolean;    // produces a bar action → belongs in the Python bridge's MUTATING_TOOLS
  client: boolean;      // a client-applied copilot action → in ALLOWED_COPILOT_ACTIONS (false = MCP-only)
  selector: Selector;   // the Express sanitizer's required-reference gate
  unavailable?: boolean; // honest stub with no executor wired (home_control) — returns 'unavailable'
}

// The table. Order is the canonical order of the generated JSON mirror (keep it stable — the freshness
// test compares the serialized output byte-for-byte). Client-applied actions first, then the MCP-only tools.
export const ACTION_CONTRACT = {
  // ── Client-applied copilot actions (the ALLOWED_COPILOT_ACTIONS set) ──────────────────────────────
  create_event:         { tier: 'auto',    mutating: true, client: true,  selector: 'none' },
  update_event:         { tier: 'confirm', mutating: true, client: true,  selector: 'idOrMatchTitle' },
  delete_event:         { tier: 'confirm', mutating: true, client: true,  selector: 'idOrTitle' },
  add_chore:            { tier: 'auto',    mutating: true, client: true,  selector: 'none' },
  delete_chore:         { tier: 'confirm', mutating: true, client: true,  selector: 'idOrTitle' },
  clear_chores:         { tier: 'confirm', mutating: true, client: true,  selector: 'none' },
  update_chore:         { tier: 'confirm', mutating: true, client: true,  selector: 'idOrMatchTitle' },
  add_shopping_item:    { tier: 'auto',    mutating: true, client: true,  selector: 'none' },
  delete_shopping_item: { tier: 'confirm', mutating: true, client: true,  selector: 'idOrText' },
  set_goal:             { tier: 'auto',    mutating: true, client: true,  selector: 'goalText' },
  delete_goal:          { tier: 'auto',    mutating: true, client: true,  selector: 'idOrAll' },
  set_meal_plan:        { tier: 'auto',    mutating: true, client: true,  selector: 'days' },
  delete_meal_plan:     { tier: 'auto',    mutating: true, client: true,  selector: 'mealSelector' },
  move_document:        { tier: 'auto',    mutating: true, client: true,  selector: 'idOrName' },
  delete_document:      { tier: 'confirm', mutating: true, client: true,  selector: 'idOrName' },
  reserve:              { tier: 'confirm', mutating: true, client: true,  selector: 'title' },
  add_to_cart:          { tier: 'confirm', mutating: true, client: true,  selector: 'textOrTitle' },
  // ── MCP-only tools (agent-side; not client-applied copilot actions) ───────────────────────────────
  // prepare_handoff + suggest_event still surface as bar actions (mutating), but the client never receives
  // them as a `type` in the copilot-action allowlist — the bridge maps their MCP results to the bar.
  prepare_handoff:      { tier: 'confirm', mutating: true, client: false, selector: 'titleUrl' },
  suggest_event:        { tier: 'auto',    mutating: true, client: false, selector: 'titleStart' },
  // Honest IoT stub — registered so the agent learns the capability exists, but no executor is wired.
  home_control:         { tier: 'stepup',  mutating: false, client: false, selector: 'none', unavailable: true },
} as const satisfies Record<string, ActionSpec>;

export type ActionType = keyof typeof ACTION_CONTRACT;

const ENTRIES = Object.entries(ACTION_CONTRACT) as [ActionType, ActionSpec][];

// The client-applied copilot actions — server.ts's ALLOWED_COPILOT_ACTIONS and toolRegistry's derive from this.
export const COPILOT_ACTIONS: string[] = ENTRIES.filter(([, s]) => s.client).map(([n]) => n);

// Tools whose results become bar actions — the Python bridge's MUTATING_TOOLS is the JSON-mirror of this.
export const MUTATING_TOOLS: string[] = ENTRIES.filter(([, s]) => s.mutating).map(([n]) => n);

// The Express sanitizer's required-reference gate: does this action carry a selector so it can't mean
// "do everything"? Mirrors each aiActions builder's null-check. Unknown types fail closed.
export function selectorSatisfied(type: string, payload: any): boolean {
  const spec = (ACTION_CONTRACT as Record<string, ActionSpec>)[type];
  if (!spec) return false;
  const p = payload ?? {};
  const has = (k: string) => typeof p[k] === 'string' && p[k].trim().length > 0;
  switch (spec.selector) {
    case 'none':           return true;
    case 'idOrTitle':      return !!(p.id || has('title'));
    case 'idOrMatchTitle': return !!(p.id || has('matchTitle'));
    case 'idOrText':       return !!(p.id || has('text'));
    case 'idOrName':       return !!(p.id || has('name'));
    case 'idOrAll':        return !!(p.id || p.all === true);
    case 'goalText':       return has('text');
    case 'days':           return Array.isArray(p.days) && p.days.length > 0;
    case 'mealSelector':   return !!(has('meal') || has('weekStart') || p.all === true);
    case 'title':          return has('title');
    case 'textOrTitle':    return has('text') || has('title');
    case 'titleUrl':       return has('title') && has('url');
    case 'titleStart':     return has('title') && has('start');
    default:               return true;
  }
}

// The exact JSON string written to agent/concierge/action_contract.json (the Python mirror). Deterministic
// key order (contract order) + 2-space indent + trailing newline, so the freshness test is a byte compare
// and the committed file has no spurious diffs. `unavailable` is emitted only when true.
export const CONTRACT_JSON: string =
  JSON.stringify(
    Object.fromEntries(ENTRIES.map(([name, s]) => [
      name,
      { tier: s.tier, mutating: s.mutating, client: s.client, selector: s.selector,
        ...(s.unavailable ? { unavailable: true } : {}) },
    ])),
    null,
    2,
  ) + '\n';
