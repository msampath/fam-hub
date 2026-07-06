// Test helpers: full mock context values + render-with-provider wrappers.
// useApp()/useCalendar() throw without a provider and their interfaces are large,
// so these factories build a complete value with vi.fn() handlers + sane defaults,
// and accept per-test overrides.
import React from 'react';
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { AppContext, type AppCtx } from '../../AppContext';
import { CalendarContext, type CalendarCtx } from '../../CalendarContext';

const noop = () => {};

export function makeAppCtx(overrides: Partial<AppCtx> = {}): AppCtx {
  const base: AppCtx = {
    // Shopping
    shoppingList: [],
    setShoppingList: vi.fn(),
    sendShoppingToKroger: vi.fn(),
    krogerOffer: null,
    dismissKrogerOffer: vi.fn(),
    storeList: ['Costco', 'Indian Store', 'Grocery Store', 'Other'],
    setStoreList: vi.fn(),
    routineCandidates: [],
    routines: [],
    setRoutines: vi.fn(),
    krogerBusy: false,
    storeBindings: {},
    krogerConnection: null,
    setKrogerConnection: vi.fn(),
    setListLink: vi.fn(),
    homeLat: null,
    homeLng: null,
    newShopText: '',
    setNewShopText: vi.fn(),
    newShopStore: 'Grocery Store',
    setNewShopStore: vi.fn(),
    newShopQty: '',
    setNewShopQty: vi.fn(),
    newShopNotes: '',
    setNewShopNotes: vi.fn(),

    // Pantry + AI shopping
    pantryList: [],
    newPantryText: '',
    setNewPantryText: vi.fn(),
    handleAddPantryItem: vi.fn(),
    handleDeletePantryItem: vi.fn(),
    recipeInput: '',
    setRecipeInput: vi.fn(),
    handleParseRecipe: vi.fn(),
    isParsingRecipe: false,
    handleSuggestRestock: vi.fn(),
    isSuggestingRestock: false,
    handlePlanMeals: vi.fn(),
    isPlanningMeals: false,
    mealPlan: [],
    isScanningPantry: false,
    pantryScan: null,
    handleScanPantryPhoto: vi.fn(async () => {}),
    confirmPantryScan: vi.fn(),
    dismissPantryScan: vi.fn(),
    goalsList: [],
    toggleGoal: vi.fn(),
    deleteGoal: vi.fn(),
    toggleStep: vi.fn(),
    mealPlans: [],
    shoppingAiError: null,
    setShoppingAiError: vi.fn(),

    // Chores
    choresList: [],
    setChoresList: vi.fn(),
    authorStamp: () => ({}),
    familyMembers: [],
    choreTimeFilter: 'All',
    setChoreTimeFilter: vi.fn(),
    newChoreTitle: '',
    setNewChoreTitle: vi.fn(),
    newChoreAssigned: '',
    setNewChoreAssigned: vi.fn(),
    newChorePoints: 10,
    setNewChorePoints: vi.fn(),
    newChoreTimesPerDay: 1,
    setNewChoreTimesPerDay: vi.fn(),
    newChoreRepeatType: 'daily',
    setNewChoreRepeatType: vi.fn(),
    newChoreScheduleTime: '',
    setNewChoreScheduleTime: vi.fn(),
    newChoreNotes: '',
    setNewChoreNotes: vi.fn(),

    // Chore rewards
    rewardsList: [],
    redemptionsList: [],
    xpBankList: [],
    newRewardTitle: '',
    setNewRewardTitle: vi.fn(),
    newRewardCost: 50,
    setNewRewardCost: vi.fn(),
    handleAddReward: vi.fn(),
    handleDeleteReward: vi.fn(),
    handleRedeemReward: vi.fn(),

    // Family members bar
    setFamilyMembers: vi.fn(),
    editingMember: null,
    setEditingMember: vi.fn(),
    editNameInput: '',
    setEditNameInput: vi.fn(),
    handleRenameMember: vi.fn(),
    handleDeleteMember: vi.fn(),
    showAddMember: false,
    setShowAddMember: vi.fn(),
    handleAddMember: vi.fn(),
    newMemberName: '',
    setNewMemberName: vi.fn(),
    newMemberRole: 'Kid',
    setNewMemberRole: vi.fn(),
    newMemberColor: '',
    setNewMemberColor: vi.fn(),
    newMemberDietary: '',
    setNewMemberDietary: vi.fn(),
    newMemberInterests: '',
    setNewMemberInterests: vi.fn(),
    newMemberAge: '',
    setNewMemberAge: vi.fn(),

    // Name prompt modal
    handleSubmitName: vi.fn(),
    handleReclaimProfile: vi.fn(),
    nameInput: '',
    setNameInput: vi.fn(),
    onboardingName: null,
    handleSaveOnboardingPrefs: vi.fn(),
    dismissOnboarding: vi.fn(),
    inviteCodeInput: '',
    setInviteCodeInput: vi.fn(),
    isJoiningHousehold: false,
    handleJoinHousehold: vi.fn(),

    // Add-event modal
    selectedDayToAdd: null,
    setSelectedDayToAdd: vi.fn(),
    setIsAddingEvent: vi.fn(),
    handleAddCustomEvent: vi.fn(),
    customEventTitle: '',
    setCustomEventTitle: vi.fn(),
    customEventCategory: 'Other',
    setCustomEventCategory: vi.fn(),
    customEventLocation: '',
    setCustomEventLocation: vi.fn(),
    customEventEnd: '',
    setCustomEventEnd: vi.fn(),
    customEventStartTime: '',
    setCustomEventStartTime: vi.fn(),
    customEventEndTime: '',
    setCustomEventEndTime: vi.fn(),
    customEventFreeBusy: '',
    setCustomEventFreeBusy: vi.fn(),
    customEventRepeat: '',
    setCustomEventRepeat: vi.fn(),
    customEventDescription: '',
    setCustomEventDescription: vi.fn(),
    customEventMembers: [],
    toggleEventMember: vi.fn(),

    // Concierge action ledger + approval handlers
    actionLedger: [],
    approveLedgerEntry: vi.fn(),
    rejectLedgerEntry: vi.fn(),
    reviseLedgerEntry: vi.fn(async () => ({ ok: true })),
    stageLedgerEntries: vi.fn(),

    // Step-up PIN gate
    hasStepUpPin: false,
    verifyStepUpPin: vi.fn(async () => true),
    setStepUpPin: vi.fn(async () => ({ ok: true })),
    digestPrefs: [],
    setDigestPrefs: vi.fn(),

    // Kid mode (per-device)
    kidMode: false,
    setKidMode: vi.fn(),

    // Copilot name (household setting)
    copilotName: 'Copilot',
    setCopilotName: vi.fn(),

    // History-log privacy wipe (Manage → Account)
    clearCopilotHistory: vi.fn(),

    // AI starter chore plan (GenerateChoresModal / ChoresPage empty state)
    isGeneratingChoresOpen: false,
    setIsGeneratingChoresOpen: vi.fn(),
    isGeneratingChores: false,
    choreGenError: null,
    handleGenerateChores: vi.fn(async () => []),
    addGeneratedChores: vi.fn(() => ({ added: 0, duplicates: 0 })),

    // Email scans (bills/packages/kids) + suggestion create
    scanEmailForBills: vi.fn(async () => ({ suggestions: [], scanned: 0 })),
    scanEmailForPackages: vi.fn(async () => ({ suggestions: [], scanned: 0 })),
    scanEmailForKidsActivities: vi.fn(async () => ({ suggestions: [], scanned: 0 })),
    handleCreateSuggestion: vi.fn(),
    addedSuggestionKeys: new Set<string>(),
    autoEmailSuggestions: [],
    autoScanActive: false,
  };
  return { ...base, ...overrides };
}

export function makeCalendarCtx(overrides: Partial<CalendarCtx> = {}): CalendarCtx {
  const base: CalendarCtx = {
    // Shared data
    events: [],
    sources: [],
    familyMembers: [],
    googleUser: null,

    // Filters / search
    activeCategoryFilter: 'All',
    setActiveCategoryFilter: vi.fn(),
    activeMemberFilter: 'All',
    setActiveMemberFilter: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),

    // Import
    syncMode: 'url',
    setSyncMode: vi.fn(),
    errorStatus: null,
    setErrorStatus: vi.fn(),
    newUrl: '',
    setNewUrl: vi.fn(),
    newSourceName: '',
    setNewSourceName: vi.fn(),
    newUrlCategory: 'Other',
    setNewUrlCategory: vi.fn(),
    syncAssignee: 'Family',
    setSyncAssignee: vi.fn(),
    isParsing: false,
    parserStep: '',
    pastedText: '',
    setPastedText: vi.fn(),
    textSourceName: '',
    setTextSourceName: vi.fn(),
    textCategory: 'Other',
    setTextCategory: vi.fn(),
    pdfCategory: 'Other',
    setPdfCategory: vi.fn(),
    dragActive: false,
    setDragActive: vi.fn(),
    handleAddSource: vi.fn(),
    handleTextSubmit: vi.fn(),
    handlePdfUpload: vi.fn(),
    handleDeleteSource: vi.fn(),
    handleSyncSources: vi.fn(),
    isSyncingSources: false,

    // Google Calendar sync
    cloudInviteCode: null,
    inviteCodeInput: '',
    setInviteCodeInput: vi.fn(),
    isJoiningHousehold: false,
    handleJoinHousehold: vi.fn(),
    isFetchingCalendars: false,
    connectedCalendars: [],
    googleCalendarsList: [],
    calendarSyncLogs: [],
    setCalendarSyncLogs: vi.fn(),
    syncGoogleCalendars: vi.fn(),
    hasOwnCalendarConnection: false,
    connectOwnCalendar: vi.fn(),
    toggleGoogleCalendarActive: vi.fn(),
    removeGoogleCalendarConnection: vi.fn(),
    addGoogleCalendarConnection: vi.fn(),
    handleGoogleLogoutClick: vi.fn(),
    googlePushEvent: null,
    openGooglePush: vi.fn(),
    closeGooglePush: vi.fn(),
    isPushingEvent: false,
    pushEventToGoogleCalendars: vi.fn(async () => ''),

    // Board + metrics + conflicts + recurring
    currentMonthInfo: { name: 'June', index: 5, year: 2026 },
    monthsData: [{ name: 'June', index: 5, year: 2026 }],
    currentMonthStep: 0,
    setCurrentMonthStep: vi.fn(),
    calendarCells: [],
    DAYS_OF_WEEK: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    conflicts: [],
    recurringGroups: [],
    openWeekendsLeft: 0,
    getEventsForDate: () => [],
    filterEvent: () => true,
    getEventColor: () => 'bg-slate-100',
    selectedEventDetail: null,
    setSelectedEventDetail: vi.fn(),
    setSelectedDayToAdd: vi.fn(),
    setIsAddingEvent: vi.fn(),
    handleDeleteEvent: vi.fn(),
    handleDeleteRecurringGroup: vi.fn(),
    hiddenEvents: [],
    restoreHiddenEvent: vi.fn(),
    restoreAllHiddenEvents: vi.fn(),

    // Copilot
    copilotMessages: [],
    isCopilotThinking: false,
    handleSendCopilotMessage: vi.fn(),
    visitLog: [],
    handleMarkVisited: vi.fn(),
    handleSetEventFreeBusy: vi.fn(),
    libraryDocs: [],
    setLibraryDocs: vi.fn(),
    addedSuggestionKeys: new Set<string>(),
    handleCreateSuggestion: vi.fn(),
    hasHomeLocation: true, // default: home set, so the copilot location gate stays out of the way
    saveHomeLocation: vi.fn(async () => ({ ok: true, label: 'Test City' })),
  };
  return { ...base, ...overrides };
}

void noop;

/** Render a component that consumes useApp(). Returns the ctx used (for assertions). */
export function renderWithApp(ui: React.ReactElement, overrides: Partial<AppCtx> = {}) {
  const ctx = makeAppCtx(overrides);
  const utils = render(<AppContext.Provider value={ctx}>{ui}</AppContext.Provider>);
  return { ...utils, ctx };
}

/** Render a component that consumes useCalendar(). */
export function renderWithCalendar(ui: React.ReactElement, overrides: Partial<CalendarCtx> = {}) {
  const ctx = makeCalendarCtx(overrides);
  const utils = render(<CalendarContext.Provider value={ctx}>{ui}</CalendarContext.Provider>);
  return { ...utils, ctx };
}

/** Render a component that consumes BOTH contexts (e.g. TodayDigest). */
export function renderWithBoth(
  ui: React.ReactElement,
  appOverrides: Partial<AppCtx> = {},
  calOverrides: Partial<CalendarCtx> = {},
) {
  const appCtx = makeAppCtx(appOverrides);
  const calCtx = makeCalendarCtx(calOverrides);
  const utils = render(
    <AppContext.Provider value={appCtx}>
      <CalendarContext.Provider value={calCtx}>{ui}</CalendarContext.Provider>
    </AppContext.Provider>,
  );
  return { ...utils, appCtx, calCtx };
}
