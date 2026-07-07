// Concierge Tool Registry (foundation A1) — the single declarative table of actions the concierge
// can take. Each tool declares its risk tier (how it must be gated) and an `applyMode` (auto-apply
// vs. stage-for-confirm), and a pure `validate` that DELEGATES to the existing aiActions.ts trust
// boundary — it never reimplements validation. This generalizes the previously hard-coded action
// switch (App.tsx applyCopilotActions + server.ts sanitizeCopilotActions) into one source of truth,
// so a future capability is "register a tool," mirroring the COLLECTIONS registry philosophy.
//
// A1 keeps behavior identical: the 4 existing copilot actions register here; the App handler still
// applies auto actions exactly as before and now also records them in the Action Ledger. The new
// tiers ('confirm'/'stepup') and the Inbox/PIN that act on them arrive in A2/A3.
import type { CalendarEvent, FamilyMember, ShoppingItem, RiskTier } from '../types';
import { ACTION_CONTRACT, COPILOT_ACTIONS, type ActionType } from '../mcp/actionContract';
import {
  buildEventFromPayload,
  buildEventUpdateFromPayload,
  buildChoresFromPayload,
  buildChoreRef,
  buildEventRef,
  buildShoppingItemRef,
  buildChoreUpdate,
  buildGoalFromPayload,
  buildGoalDelete,
  buildMealPlanFromPayload,
  buildMealPlanDelete,
  buildPantryItemFromPayload,
  buildPantryItemRef,
  normalizeShoppingItems,
  buildReservationDraft,
  buildCartDraft,
} from './aiActions';

// How an action is applied once it passes validation.
//   'auto'    → apply immediately (reversible internal creates — today's behavior)
//   'confirm' → stage for human approval in the Concierge Inbox (A2)
export type ApplyMode = 'auto' | 'confirm';

// Context a tool needs to validate a payload — the same inputs the App handler already has.
export interface ToolValidateCtx {
  familyMembers: FamilyMember[];
  events: CalendarEvent[];
  today: string;                                   // YYYY-MM-DD
  validStores: readonly ShoppingItem['store'][];
}

export interface ConciergeTool {
  name: string;          // == the copilot action `type`
  riskTier: RiskTier;
  applyMode: ApplyMode;
  // Returns the validated artifact (clamped via aiActions builders) or null if it can't be applied.
  validate: (payload: any, ctx: ToolValidateCtx) => unknown | null;
}

// Build a registry entry, sourcing its risk tier + apply mode from the shared ACTION_CONTRACT (single
// source of truth) so a tool's gating can't drift from the contract the Express sanitizer + Python agent
// also read. applyMode follows the tier: auto tier auto-applies; confirm/stepup stage for approval. The
// per-tool `validate` still DELEGATES to the aiActions.ts trust boundary — the registry never reimplements it.
type ToolValidate = (payload: any, ctx: ToolValidateCtx) => unknown | null;
function tool(name: ActionType, validate: ToolValidate): ConciergeTool {
  const tier = ACTION_CONTRACT[name].tier;
  return { name, riskTier: tier, applyMode: tier === 'auto' ? 'auto' : 'confirm', validate };
}

export const TOOL_REGISTRY: Record<string, ConciergeTool> = {
  create_event: tool('create_event', (p, ctx) => buildEventFromPayload(p, 'cop', ctx.familyMembers, ctx.today)),
  add_chore: tool('add_chore', (p, ctx) => {
    const chores = buildChoresFromPayload(p, ctx.familyMembers);
    return chores.length ? chores : null;
  }),
  // Chore delete/edit (confirm tier — destructive/mutating): same pattern as delete_document. The
  // validator only shape-checks the reference; the client resolves it against the live chores list and
  // applies on approval (the chores collection is client-owned + RLS-synced).
  delete_chore: tool('delete_chore', (p) => buildChoreRef(p)),
  // Bulk clear — no payload needed (the client stages every current chore id for one approval).
  clear_chores: tool('clear_chores', () => ({ all: true })),
  update_chore: tool('update_chore', (p, ctx) => buildChoreUpdate(p, ctx.familyMembers)),
  // Goals as tracked objects (A6) — auto tier (reversible, internal): the agent records/updates a goal
  // and its plan (steps[]). Client-owned (not in TOOL_COLLECTION); the client upserts it into the goals
  // collection on ingest, which RLS-syncs so the scheduler can later read + nudge it.
  set_goal: tool('set_goal', (p) => buildGoalFromPayload(p)),
  // Delete a goal (completes CRUD) — auto tier, client-owned like set_goal. Client removes the match.
  delete_goal: tool('delete_goal', (p) => buildGoalDelete(p)),
  // The weekly dinner plan — auto tier (reversible, internal), client-owned like set_goal (NOT in
  // TOOL_COLLECTION): the client upserts it by weekStart into the mealplan collection on ingest.
  set_meal_plan: tool('set_meal_plan', (p, ctx) => buildMealPlanFromPayload(p, ctx.today)),
  // Delete a meal plan (completes CRUD) — auto tier, client-owned like set_meal_plan; consistent with
  // set_meal_plan's replace-a-week (also auto, also destroys prior state). Client removes the match.
  delete_meal_plan: tool('delete_meal_plan', (p) => buildMealPlanDelete(p)),
  add_shopping_item: tool('add_shopping_item', (p, ctx) => {
    // Accept either a single {text,store} or a {items:[...]} payload (mirrors applyCopilotActions).
    const raw = Array.isArray(p?.items) ? p.items : [{ text: p?.text, store: p?.store }];
    const items = normalizeShoppingItems(raw, ctx.validStores);
    return items.length ? items : null;
  }),
  update_event: tool('update_event', (p, ctx) => buildEventUpdateFromPayload(p, ctx.events, ctx.familyMembers)),
  // Event delete (confirm tier — destructive): shape-check-then-client-resolve, like delete_chore. The
  // client resolves the reference against the live events on approval and removes the match.
  delete_event: tool('delete_event', (p) => buildEventRef(p)),
  // Shopping-item delete (confirm tier) — same shape-check-then-client-resolve pattern as delete_chore.
  delete_shopping_item: tool('delete_shopping_item', (p) => buildShoppingItemRef(p)),
  // Pantry inventory (what's on hand at home) — auto tier, client-owned like set_goal: the client applies
  // the artifact to the pantry collection. add_pantry_item mints a PantryItem; delete_pantry_item is a ref
  // (id/text) the client resolves against the live pantry. Distinct from the shopping list (buy vs. have).
  add_pantry_item: tool('add_pantry_item', (p) => buildPantryItemFromPayload(p)),
  delete_pantry_item: tool('delete_pantry_item', (p) => buildPantryItemRef(p)),
  // Reservation DRAFT (B3) — confirm tier, NO money moves (no-payment invariant): stages a booking
  // deep-link the parent opens to book themselves. Amazon add-to-cart (B4) registers the same way.
  reserve: tool('reserve', (p) => buildReservationDraft(p)),
  // Amazon add-to-cart DRAFT (B4) — confirm tier, no checkout (no-payment invariant); same draft
  // mechanism as reserve (a cart/search link the parent completes in the Amazon app).
  add_to_cart: tool('add_to_cart', (p) => buildCartDraft(p)),
  // Library doc management via chat. move_document just recategorizes (reversible) → auto; delete_document
  // is destructive → confirm (staged in Approvals). Both resolve the target doc by id OR name at apply time
  // (App handler / MCP handler); the validators here only shape-check the reference.
  move_document: tool('move_document', (p) => (p?.id || p?.name ? { id: p?.id, name: p?.name, folder: p?.folder } : null)),
  delete_document: tool('delete_document', (p) => (p?.id || p?.name ? { id: p?.id, name: p?.name } : null)),
  // NOTE (B5 Home Assistant control) is intentionally NOT registered yet: it's a 'stepup' physical
  // action with no executor until C2 wires HA, and shipping a PIN-ceremony that silently no-ops is a
  // fabricated-success anti-pattern. The validator `buildHaActionDraft` (aiActions.ts) is the scaffold;
  // register `home_control` here + in the server allowlist + the harness prompt together with the C2 executor.
};

// The allowlist of action types the concierge accepts — the client-applied actions in the shared
// ACTION_CONTRACT (client:true). server.ts derives its OWN allowlist from the SAME contract; a parity
// test (toolRegistry.test.ts) asserts the two match AND that TOOL_REGISTRY registers exactly these, so
// the three declarations can't silently drift.
export const ALLOWED_COPILOT_ACTIONS = COPILOT_ACTIONS;
