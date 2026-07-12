import React, { createContext, useContext } from 'react';
import type { ShoppingItem, PantryItem, Chore, Reward, Redemption, XpBankEntry, FamilyMember, Authored, LedgerEntry, CopilotSuggestion, DigestPrefs, Goal, MealPlan, Routine } from './types';
import type { PantryDiff } from './utils/visionPantry';
import type { RoutineCandidate } from './utils/routineMiner';
import type { GeneratedChore } from './utils/chorePlan';

// Shared state/handlers exposed to extracted feature components. Grown as more of the
// UI is pulled out of App.tsx — each field is consumed by at least one component.
export interface AppCtx {
  // Shopping
  shoppingList: ShoppingItem[];
  setShoppingList: React.Dispatch<React.SetStateAction<ShoppingItem[]>>;
  // Kroger cart: match the given item texts to products at the connected store and stage a
  // confirm-tier cart-write approval. krogerStore is set (null when not connected/configured).
  // Send ONE list's items to ITS bound Kroger store (per-list sends — the binding model).
  sendShoppingToKroger: (items: string[], locationId: string, storeName: string) => void;
  // Dish-ask auto-offer (step 5): grocery items the last recipe/meal ask added to a BOUND list,
  // offered for one-tap send-to-cart (the write itself still rides the confirm Approval).
  krogerOffer: { texts: string[]; store: string } | null;
  dismissKrogerOffer: () => void;
  krogerBusy: boolean;
  // RESOLVED list → store view (composed from the two-level model below; the send path reads this).
  storeBindings: Record<string, { locationId: string; name: string }>;
  // Two-level retailer model: the CONNECTION (Kroger, with its step-2 store location) + LIST LINKS.
  krogerConnection: { locationId: string; name: string } | null;
  setKrogerConnection: (loc: { locationId: string; name: string } | null) => void;
  setListLink: (list: string, retailer: 'kroger' | null) => void;
  // Household-defined store lists (Phase-5): sanitized, never empty (defaults to SHOP_STORES).
  storeList: string[];
  setStoreList: (stores: string[]) => void;
  // Pattern-4 routines: mined candidates (review-only) + the parent-ENABLED set (settings.routines).
  routineCandidates: RoutineCandidate[];
  routines: Routine[];
  setRoutines: (r: Routine[]) => void;
  homeLat: number | null;
  homeLng: number | null;

  // Pantry + AI shopping (recipe→list, pantry→restock)
  pantryList: PantryItem[];
  handleAddPantryItem: (text: string) => void;
  handleDeletePantryItem: (id: string) => void;
  handleParseRecipe: (text: string) => Promise<boolean>;
  isParsingRecipe: boolean;
  handleSuggestRestock: () => void;
  isSuggestingRestock: boolean;
  handlePlanMeals: () => void;
  isPlanningMeals: boolean;
  mealPlan: string[];
  // Vision intake (#2 — fridge/receipt photo → pantry)
  isScanningPantry: boolean;
  pantryScan: PantryDiff | null;
  handleScanPantryPhoto: (file: File) => Promise<void>;
  confirmPantryScan: () => void;
  dismissPantryScan: () => void;
  shoppingAiError: string | null;
  // Goals the concierge tracks (A6)
  goalsList: Goal[];
  toggleGoal: (id: string) => void;
  deleteGoal: (id: string) => void;
  toggleStep: (goalId: string, stepIndex: number) => void;
  // Weekly dinner plans (the meal planner) — newest week first; DinnersStrip reads these.
  mealPlans: MealPlan[];
  // Delete meal plans by selector (the strip's per-meal clear + the agent's delete_meal_plan).
  deleteMealPlan: (d: { meal?: 'breakfast' | 'lunch' | 'dinner'; weekStart?: string; all?: boolean }) => void;
  setShoppingAiError: React.Dispatch<React.SetStateAction<string | null>>;

  // Chores
  choresList: Chore[];
  setChoresList: React.Dispatch<React.SetStateAction<Chore[]>>;
  // Per-record authorship stamp (who/when) — spread into a record created in a component.
  authorStamp: () => Authored;
  familyMembers: FamilyMember[];
  // AI starter chore plan (docs/ai-chore-plan-generator.md): empty-state modal → per-kid ages →
  // model plan → parent-reviewed preview → bulk add (deduped). Generation errors are surfaced, never
  // a fabricated plan.
  isGeneratingChoresOpen: boolean;
  setIsGeneratingChoresOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isGeneratingChores: boolean;
  choreGenError: string | null;
  handleGenerateChores: (kids: { name: string; age: number; interests?: string; gender?: string }[]) => Promise<GeneratedChore[] | null>;
  addGeneratedChores: (payloads: GeneratedChore[]) => { added: number; duplicates: number };

  // Chore rewards (catalog + redemption ledger; balance = earned XP − redeemed)
  rewardsList: Reward[];
  redemptionsList: Redemption[];
  xpBankList: XpBankEntry[];
  handleDeleteReward: (id: string) => void;
  handleRedeemReward: (reward: Reward, memberName: string) => void;

  // Family members (add-member form state localized into Manage)
  setFamilyMembers: React.Dispatch<React.SetStateAction<FamilyMember[]>>;
  handleRenameMember: (oldName: string, rawNewName: string) => void;
  handleDeleteMember: (name: string) => void;

  // Name prompt modal
  handleSubmitName: (name: string) => void;
  handleReclaimProfile: (name: string) => void;
  // First-login onboarding (optional, skippable): after a brand-new profile is created, capture
  // the adult's dietary/interests so the copilot can personalize from day one. Set to the new
  // member's name while the prefs step is showing; null otherwise.
  onboardingName: string | null;
  handleSaveOnboardingPrefs: (prefs: { dietary: string; interests: string }) => void;
  dismissOnboarding: () => void;
  // Household join (also surfaced in the name prompt so a 2nd family member can join instead of
  // silently creating their own empty household).
  inviteCodeInput: string;
  setInviteCodeInput: React.Dispatch<React.SetStateAction<string>>;
  isJoiningHousehold: boolean;
  handleJoinHousehold: (e: React.FormEvent) => void;

  // Add-event modal (form state localized into AddEventModal; only open/day stay shared)
  selectedDayToAdd: string | null;
  setSelectedDayToAdd: React.Dispatch<React.SetStateAction<string | null>>;
  setIsAddingEvent: React.Dispatch<React.SetStateAction<boolean>>;

  // Concierge action ledger + approval handlers (foundation A2)
  actionLedger: LedgerEntry[];
  // stepUpVerified must be true to approve a 'stepup'-tier entry (enforced in the logic layer, A3).
  approveLedgerEntry: (id: string, stepUpVerified?: boolean) => void;
  rejectLedgerEntry: (id: string) => void;
  reviseLedgerEntry: (id: string, feedback: string) => Promise<{ ok: boolean; error?: string }>;
  // Stage pre-built pending entries (the morning planner's on-demand path — see BriefingCard).
  stageLedgerEntries: (entries: LedgerEntry[]) => void;

  // Step-up PIN gate for high-risk ('stepup'-tier) actions (A3)
  hasStepUpPin: boolean;
  verifyStepUpPin: (pin: string) => Promise<boolean>;
  setStepUpPin: (pin: string) => Promise<{ ok: boolean; error?: string }>;

  // Daily-briefing email prefs (W5) — single-element blob, edited in Manage, read server-side by the scheduler.
  digestPrefs: DigestPrefs[];
  setDigestPrefs: React.Dispatch<React.SetStateAction<DigestPrefs[]>>;

  // Kid mode (per-device, WS2 — see useDevicePrefs): locks this device to the kid-safe surface.
  // KAGGLE_EVAL: Security — kid mode hides Manage/Approvals/Actions/Import and chore delete/add;
  // the copilot input stays because every destructive tool is confirm-tier server-side, so the worst
  // a child's request can do is STAGE a pending approval a parent later reviews.
  kidMode: boolean;
  setKidMode: React.Dispatch<React.SetStateAction<boolean>>;

  // The family's name for the copilot (kid-pickable, synced household setting; default "Copilot").
  copilotName: string;
  setCopilotName: (name: string) => void;

  // Privacy: wipe the persisted copilot Q+A log + quick-add log (household-wide, all devices).
  clearCopilotHistory: () => void;

  // Email scans (B1 bills / B2 packages / B3 kids) + shared tap-to-add suggestion create
  scanEmailForBills: () => Promise<{ suggestions: CopilotSuggestion[]; scanned: number; error?: string }>;
  scanEmailForPackages: () => Promise<{ suggestions: CopilotSuggestion[]; scanned: number; error?: string }>;
  scanEmailForKidsActivities: () => Promise<{ suggestions: CopilotSuggestion[]; scanned: number; error?: string }>;
  handleCreateSuggestion: (s: CopilotSuggestion) => void;
  addedSuggestionKeys: Set<string>;
  // Proactive auto-scan finds (opt-in; surfaced in the copilot bar, deduped, added ones filtered at render).
  autoEmailSuggestions: CopilotSuggestion[];
  autoScanActive: boolean; // auto-scan is enabled AND signed in with Google (so it's actually running)
}

export const AppContext = createContext<AppCtx | null>(null);

export const useApp = (): AppCtx => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within an AppContext.Provider');
  return ctx;
};
