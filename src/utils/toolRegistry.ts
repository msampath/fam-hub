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

export const TOOL_REGISTRY: Record<string, ConciergeTool> = {
  create_event: {
    name: 'create_event',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p, ctx) => buildEventFromPayload(p, 'cop', ctx.familyMembers, ctx.today),
  },
  add_chore: {
    name: 'add_chore',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p, ctx) => {
      const chores = buildChoresFromPayload(p, ctx.familyMembers);
      return chores.length ? chores : null;
    },
  },
  // Chore delete/edit (confirm tier — destructive/mutating): same pattern as delete_document. The
  // validator only shape-checks the reference; the client resolves it against the live chores list and
  // applies on approval (the chores collection is client-owned + RLS-synced).
  delete_chore: {
    name: 'delete_chore',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => buildChoreRef(p),
  },
  // Bulk clear — no payload needed (the client stages every current chore id for one approval).
  clear_chores: {
    name: 'clear_chores',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: () => ({ all: true }),
  },
  update_chore: {
    name: 'update_chore',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p, ctx) => buildChoreUpdate(p, ctx.familyMembers),
  },
  // Goals as tracked objects (A6) — auto tier (reversible, internal): the agent records/updates a goal
  // and its plan (steps[]). Client-owned (not in TOOL_COLLECTION); the client upserts it into the goals
  // collection on ingest, which RLS-syncs so the scheduler can later read + nudge it.
  set_goal: {
    name: 'set_goal',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p) => buildGoalFromPayload(p),
  },
  // Delete a goal (completes CRUD) — auto tier, client-owned like set_goal. Client removes the match.
  delete_goal: {
    name: 'delete_goal',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p) => buildGoalDelete(p),
  },
  // The weekly dinner plan — auto tier (reversible, internal), client-owned like set_goal (NOT in
  // TOOL_COLLECTION): the client upserts it by weekStart into the mealplan collection on ingest.
  set_meal_plan: {
    name: 'set_meal_plan',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p, ctx) => buildMealPlanFromPayload(p, ctx.today),
  },
  // Delete a meal plan (completes CRUD) — auto tier, client-owned like set_meal_plan; consistent with
  // set_meal_plan's replace-a-week (also auto, also destroys prior state). Client removes the match.
  delete_meal_plan: {
    name: 'delete_meal_plan',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p) => buildMealPlanDelete(p),
  },
  add_shopping_item: {
    name: 'add_shopping_item',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p, ctx) => {
      // Accept either a single {text,store} or a {items:[...]} payload (mirrors applyCopilotActions).
      const raw = Array.isArray(p?.items) ? p.items : [{ text: p?.text, store: p?.store }];
      const items = normalizeShoppingItems(raw, ctx.validStores);
      return items.length ? items : null;
    },
  },
  update_event: {
    name: 'update_event',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p, ctx) => buildEventUpdateFromPayload(p, ctx.events, ctx.familyMembers),
  },
  // Event delete (confirm tier — destructive): shape-check-then-client-resolve, like delete_chore. The
  // client resolves the reference against the live events on approval and removes the match.
  delete_event: {
    name: 'delete_event',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => buildEventRef(p),
  },
  // Shopping-item delete (confirm tier) — same shape-check-then-client-resolve pattern as delete_chore.
  delete_shopping_item: {
    name: 'delete_shopping_item',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => buildShoppingItemRef(p),
  },
  // Reservation DRAFT (B3) — confirm tier, NO money moves (no-payment invariant): stages a booking
  // deep-link the parent opens to book themselves. Amazon add-to-cart (B4) registers the same way.
  reserve: {
    name: 'reserve',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => buildReservationDraft(p),
  },
  // Amazon add-to-cart DRAFT (B4) — confirm tier, no checkout (no-payment invariant); same draft
  // mechanism as reserve (a cart/search link the parent completes in the Amazon app).
  add_to_cart: {
    name: 'add_to_cart',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => buildCartDraft(p),
  },
  // Library doc management via chat. move_document just recategorizes (reversible) → auto; delete_document
  // is destructive → confirm (staged in Approvals). Both resolve the target doc by id OR name at apply time
  // (App handler / MCP handler); the validators here only shape-check the reference.
  move_document: {
    name: 'move_document',
    riskTier: 'auto',
    applyMode: 'auto',
    validate: (p) => (p?.id || p?.name ? { id: p?.id, name: p?.name, folder: p?.folder } : null),
  },
  delete_document: {
    name: 'delete_document',
    riskTier: 'confirm',
    applyMode: 'confirm',
    validate: (p) => (p?.id || p?.name ? { id: p?.id, name: p?.name } : null),
  },
  // NOTE (B5 Home Assistant control) is intentionally NOT registered yet: it's a 'stepup' physical
  // action with no executor until C2 wires HA, and shipping a PIN-ceremony that silently no-ops is a
  // fabricated-success anti-pattern. The validator `buildHaActionDraft` (aiActions.ts) is the scaffold;
  // register `home_control` here + in the server allowlist + the harness prompt together with the C2 executor.
};

// The allowlist of action types the concierge accepts, derived from the registry. server.ts keeps its
// OWN literal `ALLOWED_COPILOT_ACTIONS`; a parity test (toolRegistry.test.ts) asserts the two match so
// they can't silently drift.
export const ALLOWED_COPILOT_ACTIONS = Object.keys(TOOL_REGISTRY);
