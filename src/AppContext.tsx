import React, { createContext, useContext } from 'react';
import type { ShoppingItem, PantryItem, Chore, Reward, Redemption, XpBankEntry, FamilyMember, Category, Authored, LedgerEntry, CopilotSuggestion, DigestPrefs, Goal } from './types';
import type { PantryDiff } from './utils/visionPantry';

export type ShopStore = 'Costco' | 'Indian Store' | 'Grocery Store' | 'Other';

// Shared state/handlers exposed to extracted feature components. Grown as more of the
// UI is pulled out of App.tsx — each field is consumed by at least one component.
export interface AppCtx {
  // Shopping
  shoppingList: ShoppingItem[];
  setShoppingList: React.Dispatch<React.SetStateAction<ShoppingItem[]>>;
  newShopText: string;
  setNewShopText: React.Dispatch<React.SetStateAction<string>>;
  newShopStore: ShopStore;
  setNewShopStore: React.Dispatch<React.SetStateAction<ShopStore>>;
  newShopQty: string;
  setNewShopQty: React.Dispatch<React.SetStateAction<string>>;
  newShopNotes: string;
  setNewShopNotes: React.Dispatch<React.SetStateAction<string>>;

  // Pantry + AI shopping (recipe→list, pantry→restock)
  pantryList: PantryItem[];
  newPantryText: string;
  setNewPantryText: React.Dispatch<React.SetStateAction<string>>;
  handleAddPantryItem: () => void;
  handleDeletePantryItem: (id: string) => void;
  recipeInput: string;
  setRecipeInput: React.Dispatch<React.SetStateAction<string>>;
  handleParseRecipe: () => void;
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
  setShoppingAiError: React.Dispatch<React.SetStateAction<string | null>>;

  // Chores
  choresList: Chore[];
  setChoresList: React.Dispatch<React.SetStateAction<Chore[]>>;
  // Per-record authorship stamp (who/when) — spread into a record created in a component.
  authorStamp: () => Authored;
  familyMembers: FamilyMember[];
  choreTimeFilter: string;
  setChoreTimeFilter: React.Dispatch<React.SetStateAction<string>>;
  newChoreTitle: string;
  setNewChoreTitle: React.Dispatch<React.SetStateAction<string>>;
  newChoreAssigned: string;
  setNewChoreAssigned: React.Dispatch<React.SetStateAction<string>>;
  newChorePoints: number;
  setNewChorePoints: React.Dispatch<React.SetStateAction<number>>;
  newChoreTimesPerDay: number;
  setNewChoreTimesPerDay: React.Dispatch<React.SetStateAction<number>>;
  newChoreRepeatType: 'daily' | 'weekly';
  setNewChoreRepeatType: React.Dispatch<React.SetStateAction<'daily' | 'weekly'>>;
  newChoreScheduleTime: string;
  setNewChoreScheduleTime: React.Dispatch<React.SetStateAction<string>>;
  newChoreNotes: string;
  setNewChoreNotes: React.Dispatch<React.SetStateAction<string>>;

  // Chore rewards (catalog + redemption ledger; balance = earned XP − redeemed)
  rewardsList: Reward[];
  redemptionsList: Redemption[];
  xpBankList: XpBankEntry[];
  newRewardTitle: string;
  setNewRewardTitle: React.Dispatch<React.SetStateAction<string>>;
  newRewardCost: number;
  setNewRewardCost: React.Dispatch<React.SetStateAction<number>>;
  handleAddReward: (e: React.FormEvent) => void;
  handleDeleteReward: (id: string) => void;
  handleRedeemReward: (reward: Reward, memberName: string) => void;

  // Family members bar
  setFamilyMembers: React.Dispatch<React.SetStateAction<FamilyMember[]>>;
  editingMember: string | null;
  setEditingMember: React.Dispatch<React.SetStateAction<string | null>>;
  editNameInput: string;
  setEditNameInput: React.Dispatch<React.SetStateAction<string>>;
  handleRenameMember: (oldName: string, rawNewName: string) => void;
  handleDeleteMember: (name: string) => void;
  showAddMember: boolean;
  setShowAddMember: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddMember: (e: React.FormEvent) => void;
  newMemberName: string;
  setNewMemberName: React.Dispatch<React.SetStateAction<string>>;
  newMemberRole: 'Parent' | 'Kid';
  setNewMemberRole: React.Dispatch<React.SetStateAction<'Parent' | 'Kid'>>;
  newMemberColor: string;
  setNewMemberColor: React.Dispatch<React.SetStateAction<string>>;
  newMemberDietary: string;
  setNewMemberDietary: React.Dispatch<React.SetStateAction<string>>;
  newMemberInterests: string;
  setNewMemberInterests: React.Dispatch<React.SetStateAction<string>>;
  newMemberAge: string;
  setNewMemberAge: React.Dispatch<React.SetStateAction<string>>;

  // Name prompt modal
  handleSubmitName: (e: React.FormEvent) => void;
  handleReclaimProfile: (name: string) => void;
  nameInput: string;
  setNameInput: React.Dispatch<React.SetStateAction<string>>;
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

  // Add-event modal
  selectedDayToAdd: string | null;
  setSelectedDayToAdd: React.Dispatch<React.SetStateAction<string | null>>;
  setIsAddingEvent: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddCustomEvent: (e: React.FormEvent) => void;
  customEventTitle: string;
  setCustomEventTitle: React.Dispatch<React.SetStateAction<string>>;
  customEventCategory: Category;
  setCustomEventCategory: React.Dispatch<React.SetStateAction<Category>>;
  customEventLocation: string;
  setCustomEventLocation: React.Dispatch<React.SetStateAction<string>>;
  customEventEnd: string;
  setCustomEventEnd: React.Dispatch<React.SetStateAction<string>>;
  customEventStartTime: string;
  setCustomEventStartTime: React.Dispatch<React.SetStateAction<string>>;
  customEventEndTime: string;
  setCustomEventEndTime: React.Dispatch<React.SetStateAction<string>>;
  customEventFreeBusy: '' | 'busy' | 'free';
  setCustomEventFreeBusy: React.Dispatch<React.SetStateAction<'' | 'busy' | 'free'>>;
  customEventDescription: string;
  setCustomEventDescription: React.Dispatch<React.SetStateAction<string>>;
  customEventMembers: string[];
  toggleEventMember: (m: string) => void;

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
