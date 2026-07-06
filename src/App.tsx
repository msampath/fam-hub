import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import {
  supabase,
  signInWithGoogle,
  signOut as supabaseSignOut,
  getGoogleToken,
  getOrCreateHousehold,
  joinHousehold,
  getInviteCode,
  loadHouseholdData,
  saveHouseholdData,
  setStaleWriteHandler,
  apiFetch,
  getAuthToken,
  setStoredGoogleRefreshToken,
  setStepUpPin as apiSetStepUpPin,
  verifyStepUpPin as apiVerifyStepUpPin,
  fetchAuthStatus,
  hasLocalSession,
  getBackendMode,
} from './supabase';
import type { User } from '@supabase/supabase-js';
import { usePersistedCollection, safeParseArray } from './hooks/usePersistedCollection';
import { useEchoWriteGuard, useEchoWriteRelease } from './hooks/useEchoWriteGuard';
import { useDevicePrefs } from './hooks/useDevicePrefs';
import { useAddEventForm } from './hooks/useAddEventForm';
import { useShopping } from './hooks/useShopping';
import { useChores } from './hooks/useChores';

import type {
  Category,
  CalendarEvent,
  WebSource,
  ShoppingItem,
  Chore,
  XpBankEntry,
  ConnectedCalendar,
  FamilyMember,
  LibraryDoc,
  Bill,
  Goal,
  DigestPrefs,
  HiddenEvent,
  HouseholdSettings,
  VisitLogEntry,
  CopilotMessage,
  CopilotSuggestion,
  CopilotLogEntry,
  QuickAddLogEntry,
  Authored,
  GoogleCalendarListEntry,
  LedgerEntry,
  Routine,
} from './types';
import { APP_NAME, MEMBER_COLORS_LIST, MEMBER_COLORS_MAP, FAMILY_COLOR_THEME, sanitizeStoreList } from './constants';
import {
  buildMonthWindow,
  buildRollingWindow,
  monthWindowRange,
  parseLocalDate,
  generateCalendarCells,
  toLocalDateStr,
  parseHmToMinutes,
  shiftDateStr,
} from './utils/dates';
import { isoWeekKey, applyWeeklyReset, applyDailyReset, acquireResetLock } from './utils/chores';
import { mergeDeduplicateEvents, detectRecurringGroups, filterHiddenEvents, applySyncedPull } from './utils/events';
import { buildDailyReminder, shouldFireDailyReminder, dueEventReminders, type ReminderContent } from './utils/reminders';
import { filterConflictWindow, detectConflicts } from './utils/conflicts';
import type { RecurringGroup } from './utils/events';
import { buildEventFromPayload, buildEventUpdateFromPayload, buildChoresFromPayload, choreDedupeKey, suggestionKey, buildReservationDraft, buildCartDraft, resolveEventDeletion } from './utils/aiActions';
import { aiErrorMessage } from './utils/aiErrors';
import { mergeBills, type ParsedBillLike } from './utils/billsStore';
import { mergeNewsletterDocs } from './utils/newsletters';
import type { NormalizedMessage } from './utils/email';
import { matchOwnProfileIndex, healMemberLink } from './utils/identity';
import { buildDemoSeed } from './utils/demoSeed';
import { krogerCartAdd } from './utils/krogerClient';
import { LEDGER_APPLIERS } from './utils/ledgerAppliers';
import { mineShoppingRoutines } from './utils/routineMiner';
import { isAgentConfigured, askConciergeAgent, type AgentAction } from './utils/agentClient';
import { routeTurn } from './utils/copilotRouter';
import { buildAgentActionResult, detectUnbackedClaims } from './utils/agentActions';
import { filterUnrequestedHolidayDeletes } from './utils/holidayGuard';
import { resolveDoc, normalizeFolder } from './utils/docActions';
import { upsertVisit } from './utils/historyFacts';
import { buildGoogleEventBody, googleEventMarker, findGoogleEventByMarker, summarizePushResult, selectPushTargets, pushableLocalEvents, isFamilyHubMarked, selectAutoPushEvents, shouldAutoPull } from './utils/googleEvent';
import { LOG_CAP, LEDGER_CAP, appendCapped, buildCopilotLogEntry, buildQuickAddLogEntry, buildLedgerEntry } from './utils/historyLog';
import { TOOL_REGISTRY } from './utils/toolRegistry';
import { resolveLedgerEntry } from './utils/ledger';
import { mergeGoalSteps, blockNextGoalStep, advanceGoalStep } from './utils/goals';

// The confirm-tier tools that are a goal's external "steps" (booking/reschedule drafts the parent submits).
// These are exactly the entries that fall through to the resume hook in resolveLedgerUpdate, so ONLY these
// may be tied to a goal — a destructive chore/shopping edit handles its own early-return branch and would
// never advance the goal (it'd wedge it in 'waiting').
const GOAL_STEP_TOOLS = new Set(['update_event', 'reserve', 'add_to_cart', 'prepare_handoff']);
import { shapeRevisedDraft } from './utils/reviseDraft';
import { uuid } from './utils/uuid';
import { AppContext, type AppCtx } from './AppContext';
import SignInGate from './components/SignInGate';
import LocalAuthGate from './components/LocalAuthGate';
import NamePromptModal from './components/NamePromptModal';
// Code-split the add-event modal: it isn't shown on the landing view, so it loads on demand instead
// of bloating the initial bundle. SignInGate + NamePromptModal stay eager (critical sign-in paths).
const AddEventModal = lazy(() => import('./components/AddEventModal'));
import DarkShell from './components/shell/DarkShell';
import { useIdleTimeout } from './useIdleTimeout';
import { CalendarContext, type CalendarCtx } from './CalendarContext';

// Grace period before the auth watchdog gives up waiting on the (timeout-less) Supabase session +
// household fetch and falls back to the sign-in screen. Generous: a healthy bootstrap is a few
// sequential Supabase round-trips (~1–2s); this only trips when the network is truly stalled.
// DEV gets a much longer grace period: Vite's cold-start serves the (large, eagerly-imported) app on
// demand and the first load can take 30s+, which would otherwise false-trip this "couldn't reach the
// server" error even though Supabase is fine. PROD (prebuilt bundle) keeps the tight 15s for genuine
// offline detection. (For fast testing, prefer the prod serve: `npm run build && npm start`.)
const AUTH_RESOLVE_TIMEOUT_MS = import.meta.env.DEV ? 40000 : 15000;

// Per-step ceiling for the post-sign-in household load. The Supabase query builder has NO request
// timeout, so a stalled connection would hang the bootstrap forever (eternal "Loading…"). Bounding
// each round-trip turns a genuine stall into a clear, retryable error on the sign-in gate instead.
const BOOTSTRAP_STEP_TIMEOUT_MS = import.meta.env.DEV ? 35000 : 15000;

// The single user-facing message for "we couldn't load your household data" — whether the session
// never resolved (watchdog) or a bootstrap round-trip stalled. Same copy so the two paths are
// indistinguishable to the user; both land on the gate where "Sign in" remounts and retries.
const SERVER_UNREACHABLE_MSG =
  "Couldn't reach the server to load your data. Check this device's internet connection, then refresh or tap Sign in to retry.";

// Reject if `p` doesn't settle within `ms`. Promise.race can't cancel the underlying fetch, but it
// lets the bootstrap's catch run and surface a real error rather than awaiting a never-settling promise.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

// localStorage key recording which household this device's cached collections belong to. On sign-in
// to a DIFFERENT household we replace the cache wholesale (no stale bleed); see bootstrapSignedInUser.
const HOUSEHOLD_ID_KEY = 'famplan_household_id';

// Calendar display window: months before/after the current month the user can navigate to.
const MONTH_WINDOW_BACK = 12;

export default function App() {
  // Local states with LocalStorage persistence
  const [events, setEvents] = useState<CalendarEvent[]>(() => {
    const saved = localStorage.getItem('famplan_events');
    return safeParseArray(saved);
  });

  const [sources, setSources] = useState<WebSource[]>(() => {
    const saved = localStorage.getItem('famplan_sources');
    return safeParseArray(saved);
  });

  // Chores domain (board + add-chore form + XP ledgers + reward handlers) → useChores. The weekly
  // RESET stays in App as a coordinator (cloud save) and uses these setters.
  const chores = useChores();
  const {
    choresList, setChoresList, rewardsList, setRewardsList, redemptionsList, setRedemptionsList,
    xpBankList, setXpBankList, choreWeekList, setChoreWeekList,
    newChoreTitle, setNewChoreTitle, newChoreAssigned, setNewChoreAssigned,
    newChorePoints, setNewChorePoints, newChoreTimesPerDay, setNewChoreTimesPerDay,
    newChoreRepeatType, setNewChoreRepeatType, newChoreScheduleTime, setNewChoreScheduleTime,
    newChoreNotes, setNewChoreNotes, choreTimeFilter, setChoreTimeFilter,
    newRewardTitle, setNewRewardTitle, newRewardCost, setNewRewardCost,
    handleAddReward, handleDeleteReward, handleRedeemReward,
  } = chores;

  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>(() => {
    const saved = localStorage.getItem('famplan_members');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          if (parsed.length > 0 && typeof parsed[0] === 'string') {
            return (parsed as string[]).map((name, i) => {
              const role = (name === 'Dad' || name === 'Mom' || name.toLowerCase().includes('parent')) ? 'Parent' : 'Kid';
              return {
                name,
                role,
                color: MEMBER_COLORS_LIST[i % MEMBER_COLORS_LIST.length].id
              };
            });
          }
          return parsed;
        }
      } catch (e) {
        console.error('Failed to parse members from localStorage', e);
      }
    }
    return [];
  });

  const [newMemberRole, setNewMemberRole] = useState<'Parent' | 'Kid'>('Kid');
  const [newMemberColor, setNewMemberColor] = useState('indigo');
  // Optional preferences captured at add-time so chore/activity suggestions are tailored from the start.
  const [newMemberDietary, setNewMemberDietary] = useState('');
  const [newMemberInterests, setNewMemberInterests] = useState('');
  const [newMemberAge, setNewMemberAge] = useState('');
  const [syncAssignee, setSyncAssignee] = useState<string>('Family');

  // Current View Calendar Settings
  // Rolling window spanning 12 months back .. 12 months forward (no hardcoded year). The current
  // month sits at index MONTH_WINDOW_BACK, so navigation has a full year of headroom either side.
  const monthsData = useMemo(() => buildRollingWindow(MONTH_WINDOW_BACK, MONTH_WINDOW_BACK), []);
  const [currentMonthStep, setCurrentMonthStep] = useState(MONTH_WINDOW_BACK); // index in monthsData (default = current month)
  const currentMonthInfo = monthsData[currentMonthStep];

  // Forms / Interactivity State
  const [newUrl, setNewUrl] = useState('');
  const [newUrlCategory, setNewUrlCategory] = useState<Category>('School');
  const [newSourceName, setNewSourceName] = useState('');
  const [isParsing, setIsParsing] = useState(false);
  const [parserStep, setParserStep] = useState('');
  const [errorStatus, setErrorStatus] = useState<string | null>(null);

  // PDF Calendar Upload states
  const [syncMode, setSyncMode] = useState<'url' | 'text' | 'pdf' | 'google'>('url');
  
  // Google Calendar integration states
  const [googleUser, setGoogleUser] = useState<User | null>(null);
  const [googleToken, setGoogleToken] = useState<string | null>(null);
  // Per-record authorship stamp (best-effort) for the audit trail + RL dataset — spread into a new
  // event/chore/shopping item / log entry at its create site. Exposed via AppContext for components.
  const authorStamp = (): Authored => ({
    createdAt: new Date().toISOString(),
    createdByUserId: googleUser?.id,
    createdByEmail: googleUser?.email ?? undefined,
  });
  const [householdId, setHouseholdId] = useState<string | null>(null);
  const [cloudInviteCode, setCloudInviteCode] = useState<string | null>(null);
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [isJoiningHousehold, setIsJoiningHousehold] = useState(false);
  // Backend mode (cloud Supabase vs the local SQLite appliance), resolved at boot via /api/auth/status.
  // 'unknown' until resolved → show the splash; 'sqlite' → the LocalAuthGate path; 'supabase' → the existing flow.
  const [appMode, setAppMode] = useState<'unknown' | 'supabase' | 'sqlite'>('unknown');
  const [localConfigured, setLocalConfigured] = useState(true); // does the box have a household passphrase set?
  // Onboarding: gate the app behind sign-in, then prompt new users to pick a name
  const [authChecked, setAuthChecked] = useState(false);
  // True while a signed-in user's household load is in flight. The session resolves the instant the
  // auth event arrives (we know WHO the user is); their DATA loading is a separate phase. Gating the
  // splash on this — not on the auth watchdog — is what stops a slow-but-successful load from painting
  // the false "couldn't reach server" error (the load was fine, just slower than the watchdog).
  const [bootstrapping, setBootstrapping] = useState(false);
  const [needsNamePrompt, setNeedsNamePrompt] = useState(false);
  // True only when the name prompt is opened ON DEMAND (account menu "link my profile"), so it can be
  // dismissed. The first-run/bootstrap/join gate leaves this false — that prompt must be resolved.
  const [namePromptDismissable, setNamePromptDismissable] = useState(false);
  const [nameInput, setNameInput] = useState('');
  // Name of a just-created profile awaiting the optional onboarding-prefs step (null = not onboarding).
  const [onboardingName, setOnboardingName] = useState<string | null>(null);
  // Open the name/claim prompt on demand so a signed-in user with no linked profile can create or
  // reconnect theirs (e.g. they only ever added kids, or their auth id drifted). Dismissable.
  const openNamePrompt = () => { setNameInput(''); setNamePromptDismissable(true); setNeedsNamePrompt(true); };

  // Per-device prefs (idle screensaver, auto-sign-out, local daily reminder) extracted to
  // useDevicePrefs (localStorage-only persistence + the user-initiated reminder toggle). The reminder
  // SCHEDULER effect (reads events/chores) stays below in App.
  const devicePrefs = useDevicePrefs();
  const {
    idleTimeoutMs, setIdleTimeoutMs, signOutMs, setSignOutMs,
    remindersEnabled, setRemindersEnabled, reminderTime, setReminderTime,
    reminderLeadMinutes, setReminderLeadMinutes, handleToggleReminders,
    autoScanEnabled, setAutoScanEnabled,
    kidMode, setKidMode,
    photosScreensaver, setPhotosScreensaver,
  } = devicePrefs;
  // Date string of the last day the digest fired (so it fires once/day). Ref + localStorage
  // so it survives reloads without re-creating the scheduler effect.
  const reminderFiredDateRef = useRef<string | null>(localStorage.getItem('famplan_reminder_lastfired'));
  // Per-event reminders already fired today (keys `date|eventId`), reset on day change.
  const eventRemindersFiredRef = useRef<{ date: string; ids: Set<string> }>((() => {
    try {
      const raw = localStorage.getItem('famplan_event_reminders_fired');
      if (raw) { const p = JSON.parse(raw); return { date: p.date || '', ids: new Set<string>(p.ids || []) }; }
    } catch { /* ignore */ }
    return { date: '', ids: new Set<string>() };
  })());
  const [screensaverOn, setScreensaverOn] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Suppresses Supabase echo-writes during cloud loads — a composing depth counter. Engine extracted
  // to useEchoWriteGuard; the release effect (useEchoWriteRelease) is declared LAST below, after every
  // usePersistedCollection(), so it runs last in the commit. beginLoad()/endLoad()/suppressSync keep
  // their names here (destructured) so the rest of App is unchanged.
  const echoGuard = useEchoWriteGuard();
  const { suppressSync, beginLoad, endLoad } = echoGuard;
  // Generation token: a fired watchdog / a new sign-in / sign-out bumps this so a stale in-flight
  // bootstrap can't commit its results into a reset or superseded UI.
  const bootstrapGenRef = useRef(0);
  // Which user we've already bootstrapped. Supabase fires onAuthStateChange repeatedly for the SAME
  // user (TOKEN_REFRESHED ~hourly + on tab focus, USER_UPDATED, INITIAL_SESSION). Re-running the
  // household load + name-prompt check on each of those raced and spuriously re-showed the
  // "What should we call you?" gate for an existing signed-in user (🐞 #6 — it locked them out).
  // Bootstrap ONLY when the signed-in user actually changes.
  const bootstrappedUserIdRef = useRef<string | null>(null);
  // Set by "Try the demo" so bootstrap seeds the sample household even if `user.is_anonymous` isn't
  // populated (SDK/version-dependent) — a no-login judge must never dead-end on the name prompt.
  const demoSeedPendingRef = useRef(false);
  // True once the auth listener has resolved (session checked, bootstrap done or skipped). The
  // Supabase calls in the bootstrap have NO request timeout, so a device that can't reach
  // supabase.co would hang the loading splash forever; a mount-time watchdog uses this ref to fall
  // back to the sign-in screen instead of an infinite spinner.
  const authResolvedRef = useRef(false);
  const [connectedCalendars, setConnectedCalendars] = useState<ConnectedCalendar[]>(() => {
    const saved = localStorage.getItem('famplan_google_calendars');
    return safeParseArray(saved);
  });
  const [googleCalendarsList, setGoogleCalendarsList] = useState<GoogleCalendarListEntry[]>([]);
  // Synced (gcal-) events the user deleted; blocklisted so the next pull doesn't re-import them.
  const [hiddenEvents, setHiddenEvents] = useState<HiddenEvent[]>(() => {
    const saved = localStorage.getItem('famplan_hidden_events');
    return safeParseArray(saved);
  });
  // Household settings (home location for copilot weather grounding). Stored as a single-element
  // array so it rides the existing array-based COLLECTIONS / usePersistedCollection plumbing.
  const [settings, setSettings] = useState<HouseholdSettings[]>(() => {
    const saved = localStorage.getItem('famplan_settings');
    return safeParseArray(saved);
  });
  // Per-place "last visited" tracker (HISTORY FACTS grounding). Captured via "We went" on past events.
  const [visitLog, setVisitLog] = useState<VisitLogEntry[]>(() => {
    const saved = localStorage.getItem('famplan_visitlog');
    return safeParseArray(saved);
  });
  // Docs Library — the copilot's readable memory (extracted text + folder/name). Rides the COLLECTIONS plumbing.
  const [libraryDocs, setLibraryDocs] = useState<LibraryDoc[]>(() => {
    const saved = localStorage.getItem('famplan_documents');
    return safeParseArray(saved);
  });
  // Goals the concierge is tracking (agentic A6) — multi-step tasks the copilot records so they follow
  // through and stay visible. Household-scoped, persisted; the copilot adds them via the set_goal action.
  const [goalsList, setGoalsList] = useState<Goal[]>(() => {
    const saved = localStorage.getItem('famplan_goals');
    return safeParseArray(saved);
  });
  // Bills parsed from email by the autonomous auto-scan and PERSISTED so the agent's get_bills can read them.
  const [billsList, setBillsList] = useState<Bill[]>(() => {
    const saved = localStorage.getItem('famplan_bills');
    return safeParseArray(saved);
  });
  // Daily-briefing email prefs (single-element blob): { enabled, email, sendHour }. Read server-side by the
  // digest scheduler (closed-app autonomy). Opt-in via Manage.
  const [digestPrefs, setDigestPrefs] = useState<DigestPrefs[]>(() => {
    const saved = localStorage.getItem('famplan_digestprefs');
    return safeParseArray(saved);
  });
  // Append-only audit/RL logs (persisted via the COLLECTIONS plumbing): every copilot Q+A turn and
  // every quick-add prompt, each stamped with its author (userId+email) + timestamp. Capped on append.
  const [copilotLog, setCopilotLog] = useState<CopilotLogEntry[]>(() => {
    const saved = localStorage.getItem('famplan_copilotlog');
    return safeParseArray(saved);
  });
  const [quickAddLog, setQuickAddLog] = useState<QuickAddLogEntry[]>(() => {
    const saved = localStorage.getItem('famplan_quickaddlog');
    return safeParseArray(saved);
  });
  // Privacy control (Manage → Account): wipe both audit/RL logs for the whole household. The emptied
  // arrays ride the normal COLLECTIONS persistence (localStorage now, cloud write ~800ms later), so the
  // clear propagates to every device — it is a real deletion of the stored window, not a view reset.
  const clearCopilotHistory = () => { setCopilotLog([]); setQuickAddLog([]); };
  // Concierge action ledger (foundation A1): append-only audit trail of every concierge action —
  // 'applied' for auto creates, 'pending' for actions awaiting approval. Rides the COLLECTIONS
  // plumbing (household-scoped, RLS, cross-device), capped on append like the other logs.
  const [actionLedger, setActionLedger] = useState<LedgerEntry[]>(() => {
    const saved = localStorage.getItem('famplan_actionledger');
    return safeParseArray(saved);
  });
  const [isFetchingCalendars, setIsFetchingCalendars] = useState(false);
  const [calendarSyncLogs, setCalendarSyncLogs] = useState<string[]>([]);
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [pdfCategory, setPdfCategory] = useState<Category>('School');
  const [dragActive, setDragActive] = useState(false);

  // Directly pasted Raw Text states
  const [pastedText, setPastedText] = useState('');
  const [textCategory, setTextCategory] = useState<Category>('School');
  const [textSourceName, setTextSourceName] = useState('');

  // Main navigation tabs state
  const [activeMainTab, setActiveMainTab] = useState<'calendar' | 'shopping' | 'chores' | 'inbox'>('calendar');

  // Household-defined store lists (Phase-5): sanitized once here, threaded everywhere (hook, context,
  // AI prompt bodies, the copilot apply path). Never empty — defaults to SHOP_STORES.
  const storeList = useMemo(() => sanitizeStoreList(settings[0]?.storeList), [settings]);
  // Shopping + pantry domain (state + recipe/restock AI + shared appendShoppingItems) → useShopping.
  const shopping = useShopping({ authorStamp, storeList, krogerListStore: settings[0]?.krogerListStore });
  const {
    shoppingList, setShoppingList, newShopText, setNewShopText, newShopStore, setNewShopStore,
    newShopQty, setNewShopQty, newShopNotes, setNewShopNotes,
    pantryList, setPantryList, newPantryText, setNewPantryText,
    recipeInput, setRecipeInput, isParsingRecipe, setIsParsingRecipe,
    isSuggestingRestock, setIsSuggestingRestock, shoppingAiError, setShoppingAiError,
    isPlanningMeals, mealPlan, handlePlanMeals,
    isScanningPantry, pantryScan, handleScanPantryPhoto, confirmPantryScan, dismissPantryScan,
    appendShoppingItems, handleAddPantryItem, handleDeletePantryItem, handleParseRecipe, handleSuggestRestock,
    krogerOffer, dismissKrogerOffer,
  } = shopping;

  // Natural-language quick-add (global bar) — classifies one note into event/shopping/chore.
  const [quickAddText, setQuickAddText] = useState('');
  const [isQuickAdding, setIsQuickAdding] = useState(false);
  const [quickAddMsg, setQuickAddMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // (Chores board + add-chore form + choreTimeFilter now live in useChores, destructured above.)

  // Helper to color-code calendar events based on individual family member or "Family" (Green)
  const getEventColor = (evt: CalendarEvent): string => {
    const assigned = evt.members || [];
    if (assigned.length === 1) {
      const assignedName = assigned[0];
      if (assignedName === 'Family' || assignedName === 'Everyone' || assignedName === 'All Ages' || assignedName === 'All') {
        return FAMILY_COLOR_THEME.bg;
      }
      const member = familyMembers.find(m => m.name.toLowerCase() === assignedName.toLowerCase());
      if (member) {
        return MEMBER_COLORS_MAP[member.color]?.bg || FAMILY_COLOR_THEME.bg;
      }
    }
    // Multiple people, empty, or custom Family target -> Green theme is reserved
    return FAMILY_COLOR_THEME.bg;
  };

  const handlePdfUpload = async (file: File) => {
    if (!file) return;
    setIsParsing(true);
    setErrorStatus(null);
    setParserStep(`Reading PDF file: ${file.name}...`);

    try {
      // Convert file to Base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve, reject) => {
        reader.onload = () => {
          const result = reader.result as string;
          // Extract base64 part
          const base64 = result.split(',')[1];
          resolve(base64);
        };
        reader.onerror = (err) => reject(err);
      });
      reader.readAsDataURL(file);
      const pdfBase64 = await base64Promise;

      setParserStep(`Sending PDF to Gemini AI model for calendar event extraction...`);

      const res = await apiFetch('/api/parse-pdf', {
        method: 'POST',
        body: JSON.stringify({
          pdfBase64,
          fileName: file.name,
          category: pdfCategory
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(
          res.status, errorData,
          `PDF extraction failed with status code ${res.status}`,
          'Or add the events manually, or try the "Paste Text" tab.',
        ));
      }

      const data = await res.json();
      const fetchedEvents: CalendarEvent[] = data.events || [];

      if (fetchedEvents.length === 0) {
        throw new Error('Gemini parsed the document, but found no calendar dates matching this category. Please check your document is a calendar or scheduling document.');
      }

      // Align with selected syncAssignee and tag with the source id for precise deletion
      const sourceId = 'pdf-' + uuid();
      const processedEvents = fetchedEvents.map(evt => ({
        ...evt,
        members: [syncAssignee],
        sourceId
      }));

      // Append directly (like manual add / the agentic path) — NOT through
      // mergeDeduplicateEvents, whose title+date key would (a) merge two kids' same-title
      // same-day events (data loss) and (b) drop the incoming sourceId on a collision,
      // breaking the per-source "undo import" (handleDeleteSource filters by sourceId).
      setEvents(prev => [...processedEvents, ...prev]);

      // Insert new source entry
      const sourceEntry: WebSource = {
        id: sourceId,
        name: `PDF: ${file.name}`,
        url: `Scanned PDF booklet`,
        category: pdfCategory,
        lastSync: 'Processed with Gemini AI',
        status: 'active',
        eventCount: processedEvents.length
      };

      setSources(prev => [sourceEntry, ...prev]);
      setPdfFile(null);
      setParserStep('');

      // Push Copilot Notification
      setCopilotMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: `📄 **Awesome!** I checked your uploaded PDF **"${file.name}"** and successfully extracted **${processedEvents.length} calendar events**. They are now color-coded on your planner!\n\nLet me know if you would like me to detect any conflicts or summarize the schedule.`
        }
      ]);

    } catch (err: any) {
      console.error(err);
      setErrorStatus(err.message || 'Connecting error processing PDF document.');
    } finally {
      setIsParsing(false);
    }
  };

  const handleTextSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pastedText.trim()) return;
    setIsParsing(true);
    setErrorStatus(null);
    setParserStep(`Sending text to Gemini for event extraction...`);

    try {
      const res = await apiFetch('/api/parse-text', {
        method: 'POST',
        body: JSON.stringify({
          calendarText: pastedText,
          category: textCategory
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(
          res.status, errData,
          `Text analysis failed with status code ${res.status}`,
          'Or add the events manually for now.',
        ));
      }

      const data = await res.json();
      const fetchedEvents: CalendarEvent[] = data.events || [];

      if (fetchedEvents.length === 0) {
        throw new Error('Gemini processed the pasted text, but could not detect any scheduling dates. Please ensure dates or timelines are included in the text.');
      }

      // Align with selected syncAssignee and tag with the source id for precise deletion
      const sourceId = 'text-' + uuid();
      const processedEvents = fetchedEvents.map(evt => ({
        ...evt,
        members: [syncAssignee],
        sourceId
      }));

      // Append directly (like manual add / the agentic path) — NOT through
      // mergeDeduplicateEvents, whose title+date key would (a) merge two kids' same-title
      // same-day events (data loss) and (b) drop the incoming sourceId on a collision,
      // breaking the per-source "undo import" (handleDeleteSource filters by sourceId).
      setEvents(prev => [...processedEvents, ...prev]);

      // Insert new source entry
      const currentSourceName = textSourceName.trim() || `Pasted text (${fetchedEvents.length} events)`;
      const sourceEntry: WebSource = {
        id: sourceId,
        name: currentSourceName,
        url: `AI Copied Text Clip`,
        category: textCategory,
        lastSync: 'Pasted directly',
        status: 'active',
        eventCount: processedEvents.length
      };

      setSources(prev => [sourceEntry, ...prev]);
      setPastedText('');
      setTextSourceName('');
      setParserStep('');

      // Push Copilot Notification
      setCopilotMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: `📋 **Direct text imported!** I analyzed your pasted list (**"${currentSourceName}"**) and extracted **${processedEvents.length} new activities** using Gemini. They're now plotted on your board!`
        }
      ]);
    } catch (err: any) {
      console.error(err);
      setErrorStatus(err.message || 'Error occurred while analyzing pasted calendar text.');
    } finally {
      setIsParsing(false);
    }
  };

  // Custom Event state
  const [isAddingEvent, setIsAddingEvent] = useState(false);
  const [selectedDayToAdd, setSelectedDayToAdd] = useState<string | null>(null);
  // Manual add-event form (state + submit/reset) extracted to useAddEventForm; the modal-open state
  // (selectedDayToAdd/isAddingEvent above) stays here since several surfaces set it.
  const addEventForm = useAddEventForm({ selectedDayToAdd, setSelectedDayToAdd, setIsAddingEvent, setEvents, authorStamp });
  const {
    customEventTitle, setCustomEventTitle, customEventCategory, setCustomEventCategory,
    customEventMembers, setCustomEventMembers, customEventDescription, setCustomEventDescription,
    customEventEnd, setCustomEventEnd, customEventLocation, setCustomEventLocation,
    customEventStartTime, setCustomEventStartTime, customEventEndTime, setCustomEventEndTime,
    customEventFreeBusy, setCustomEventFreeBusy, toggleEventMember, handleAddCustomEvent,
  } = addEventForm;

  // Filtering states
  const [searchQuery, setSearchQuery] = useState('');
  const [activeCategoryFilter, setActiveCategoryFilter] = useState<string>('All');
  const [activeMemberFilter, setActiveMemberFilter] = useState<string>('All');

  // Copilot State (the input text itself lives LOCAL in CopilotBar — §3.3 — so typing doesn't re-render the app).
  // The thread + the agent session id are PERSISTED to localStorage (lazy-init below + the effects under them)
  // so a page reload doesn't wipe the conversation — the agent then doesn't re-ask for what it already knew.
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>(() => {
    try {
      const saved = localStorage.getItem('famplan_copilot_messages');
      if (saved) { const arr = JSON.parse(saved) as CopilotMessage[]; if (Array.isArray(arr) && arr.length) return arr; }
    } catch { /* corrupt blob → fall through to the greeting */ }
    // Greet with the family's chosen name when the cached settings already carry one (reloads); a brand-new
    // device greets as "Copilot" until the household settings arrive/rename.
    const greetName = (settings[0]?.copilotName || '').trim() || 'Copilot';
    return [{
      role: 'assistant',
      text: `👋 **Hi! I'm ${greetName}, your family's copilot.** I am keeping an eye on your kids school schedule and activities, and can make recommendations about things you might like to do. Tell me what you'd like to start with.\n\nAsk me anything! For example:\n* *Are we busy in July?*\n* *Are there any overlapping calendar conflicts?*\n* *Find open weeks for dynamic family outings.*`
    }];
  });
  const [isCopilotThinking, setIsCopilotThinking] = useState(false);
  // Cloud-agent conversation id — kept so auto-routed + escalated agent turns continue ONE thread. Persisted
  // so a reload re-attaches to the still-alive server session (the in-memory ADK session survives a page reload).
  const [agentSessionId, setAgentSessionId] = useState(() => {
    try { return localStorage.getItem('famplan_agent_session') || ''; } catch { return ''; }
  });
  // Persist the thread (capped) + the session id so a reload keeps the conversation context. STRIP the
  // tap-to-add `suggestions` before persisting: the de-dupe memory (addedSuggestionKeys) is in-memory only,
  // so rehydrated chips would render as un-added and a second tap would DOUBLE-CREATE the event. Without the
  // chips, the rehydrated turn is read-only text (the suggestions were one-shot for that live turn anyway).
  useEffect(() => {
    try {
      const slim = copilotMessages.slice(-40).map(m => (m.suggestions ? { ...m, suggestions: undefined } : m));
      localStorage.setItem('famplan_copilot_messages', JSON.stringify(slim));
    } catch { /* quota/serialize — non-fatal */ }
  }, [copilotMessages]);
  useEffect(() => {
    try { localStorage.setItem('famplan_agent_session', agentSessionId); } catch { /* non-fatal */ }
  }, [agentSessionId]);
  // Copilot-proposed edits to EXISTING events, staged for confirm-before-apply (creates auto-apply).
  // Keys of copilot suggestions the parent has tapped ＋Create on (so the chip flips to ✓ Added).
  const [addedSuggestionKeys, setAddedSuggestionKeys] = useState<Set<string>>(new Set());

  // Highlighted Event Detail Panel
  const [selectedEventDetail, setSelectedEventDetail] = useState<CalendarEvent | null>(null);

  // New family member naming
  const [newMemberName, setNewMemberName] = useState('');
  const [showAddMember, setShowAddMember] = useState(false);
  // Inline member rename
  const [editingMember, setEditingMember] = useState<string | null>(null);
  const [editNameInput, setEditNameInput] = useState('');

  // (Reward-catalog form state now lives in useChores, destructured above.)

  // Single source of truth for every synced collection. Drives the persistence hooks
  // below, the cloud-load + join-replace loops, and the join "local data?" guard — so a
  // new collection can't accidentally miss one of those sites. `countsAsLocal` mirrors
  // the original hasLocalData guard (members + calendars deliberately excluded).
  const COLLECTIONS: { dataKey: string; localKey: string; value: any[]; set: (v: any) => void; countsAsLocal: boolean }[] = [
    { dataKey: 'events',      localKey: 'famplan_events',           value: events,             set: setEvents,             countsAsLocal: true },
    { dataKey: 'sources',     localKey: 'famplan_sources',          value: sources,            set: setSources,            countsAsLocal: true },
    { dataKey: 'members',     localKey: 'famplan_members',          value: familyMembers,      set: setFamilyMembers,      countsAsLocal: false },
    { dataKey: 'shopping',    localKey: 'famplan_shopping',         value: shoppingList,       set: setShoppingList,       countsAsLocal: true },
    { dataKey: 'pantry',      localKey: 'famplan_pantry',           value: pantryList,         set: setPantryList,         countsAsLocal: true },
    { dataKey: 'chores',      localKey: 'famplan_chores',           value: choresList,         set: setChoresList,         countsAsLocal: true },
    { dataKey: 'rewards',     localKey: 'famplan_rewards',          value: rewardsList,        set: setRewardsList,        countsAsLocal: true },
    { dataKey: 'redemptions', localKey: 'famplan_redemptions',      value: redemptionsList,    set: setRedemptionsList,    countsAsLocal: true },
    { dataKey: 'xpbank',      localKey: 'famplan_xpbank',           value: xpBankList,         set: setXpBankList,         countsAsLocal: true },
    { dataKey: 'choreweek',   localKey: 'famplan_choreweek',        value: choreWeekList,      set: setChoreWeekList,      countsAsLocal: false },
    { dataKey: 'calendars',   localKey: 'famplan_google_calendars', value: connectedCalendars, set: setConnectedCalendars, countsAsLocal: false },
    // Keyed by event id (NOT member name) — deliberately excluded from the member rename/delete cascades.
    { dataKey: 'hiddenevents', localKey: 'famplan_hidden_events',   value: hiddenEvents,       set: setHiddenEvents,       countsAsLocal: false },
    // Household settings (home location). Single-element blob; NOT member-keyed → out of the cascades.
    { dataKey: 'settings',     localKey: 'famplan_settings',        value: settings,           set: setSettings,           countsAsLocal: false },
    // Per-place "last visited" tracker (HISTORY FACTS). Keyed by place label → out of member cascades.
    { dataKey: 'visitlog',     localKey: 'famplan_visitlog',        value: visitLog,           set: setVisitLog,           countsAsLocal: false },
    // Docs Library — household-scoped, not member-keyed → out of the member cascades.
    { dataKey: 'documents',    localKey: 'famplan_documents',       value: libraryDocs,        set: setLibraryDocs,        countsAsLocal: false },
    // Bills (parsed from email by the auto-scan) — household-scoped, not member-keyed.
    { dataKey: 'bills',        localKey: 'famplan_bills',           value: billsList,          set: setBillsList,          countsAsLocal: false },
    // Goals the concierge tracks (A6) — household-scoped, not member-keyed.
    { dataKey: 'goals',        localKey: 'famplan_goals',           value: goalsList,          set: setGoalsList,          countsAsLocal: false },
    // Daily-briefing email prefs (single-element blob) — household-scoped, not member-keyed.
    { dataKey: 'digestprefs',  localKey: 'famplan_digestprefs',     value: digestPrefs,        set: setDigestPrefs,        countsAsLocal: false },
    // Append-only audit/RL logs — not member-keyed, not "local" (don't pollute a join), persisted.
    { dataKey: 'copilotlog',   localKey: 'famplan_copilotlog',      value: copilotLog,         set: setCopilotLog,         countsAsLocal: false },
    { dataKey: 'quickaddlog',  localKey: 'famplan_quickaddlog',     value: quickAddLog,        set: setQuickAddLog,        countsAsLocal: false },
    // Concierge action ledger — not member-keyed, not "local" (don't pollute a join), persisted.
    { dataKey: 'actionledger', localKey: 'famplan_actionledger',    value: actionLedger,       set: setActionLedger,       countsAsLocal: false },
  ];

  // Persist edits — localStorage offline cache + Supabase cross-device sync (suppressSync
  // blocks echo-writes during the initial cloud load). One call per COLLECTIONS entry.
  usePersistedCollection('famplan_events', 'events', events, householdId, suppressSync);
  usePersistedCollection('famplan_sources', 'sources', sources, householdId, suppressSync);
  usePersistedCollection('famplan_members', 'members', familyMembers, householdId, suppressSync);
  usePersistedCollection('famplan_shopping', 'shopping', shoppingList, householdId, suppressSync);
  usePersistedCollection('famplan_pantry', 'pantry', pantryList, householdId, suppressSync);
  usePersistedCollection('famplan_chores', 'chores', choresList, householdId, suppressSync);
  usePersistedCollection('famplan_rewards', 'rewards', rewardsList, householdId, suppressSync);
  usePersistedCollection('famplan_redemptions', 'redemptions', redemptionsList, householdId, suppressSync);
  usePersistedCollection('famplan_xpbank', 'xpbank', xpBankList, householdId, suppressSync);
  usePersistedCollection('famplan_choreweek', 'choreweek', choreWeekList, householdId, suppressSync);
  usePersistedCollection('famplan_google_calendars', 'calendars', connectedCalendars, householdId, suppressSync);
  usePersistedCollection('famplan_hidden_events', 'hiddenevents', hiddenEvents, householdId, suppressSync);
  usePersistedCollection('famplan_settings', 'settings', settings, householdId, suppressSync);
  usePersistedCollection('famplan_visitlog', 'visitlog', visitLog, householdId, suppressSync);
  usePersistedCollection('famplan_documents', 'documents', libraryDocs, householdId, suppressSync);
  usePersistedCollection('famplan_bills', 'bills', billsList, householdId, suppressSync);
  usePersistedCollection('famplan_goals', 'goals', goalsList, householdId, suppressSync);
  usePersistedCollection('famplan_digestprefs', 'digestprefs', digestPrefs, householdId, suppressSync);
  usePersistedCollection('famplan_copilotlog', 'copilotlog', copilotLog, householdId, suppressSync);
  usePersistedCollection('famplan_quickaddlog', 'quickaddlog', quickAddLog, householdId, suppressSync);
  usePersistedCollection('famplan_actionledger', 'actionledger', actionLedger, householdId, suppressSync);

  // Echo-write release — MUST stay declared after every usePersistedCollection() above so it runs last
  // in the commit (re-enabling cloud writes only once this load's persist effects have run + been
  // suppressed). See useEchoWriteGuard.
  useEchoWriteRelease(echoGuard);

  // Goals the concierge tracks (A6): mark done / remove. Goals are agent-created (set_goal); there's no
  // manual add — a typed goal had no plan and confusingly overlapped the copilot bar.
  const toggleGoal = (id: string) =>
    setGoalsList(prev => prev.map(g => (g.id === id ? { ...g, status: g.status === 'done' ? 'active' : 'done' } : g)));
  const deleteGoal = (id: string) => setGoalsList(prev => prev.filter(g => g.id !== id));
  // Manually tick a goal step done/undone — the human fallback (the agent also marks steps done via set_goal).
  // A 'blocked' step is waiting on an Approvals entry and advances when that's approved, so leave it untouched
  // here — a manual tick would desync the step↔ledger link.
  const toggleStep = (goalId: string, stepIndex: number) =>
    setGoalsList(prev => prev.map(g => {
      const s = g.steps?.[stepIndex];
      if (g.id !== goalId || !s || s.status === 'blocked') return g;
      return { ...g, steps: g.steps!.map((st, i) => (i === stepIndex ? { ...st, status: st.status === 'done' ? 'pending' : 'done' } : st)) };
    }));
  // Upsert a goal the AGENT produced via set_goal (A6): merge by id (preserving the original author
  // stamp) or prepend a new one. The validated Goal arrives without an Authored stamp — add it on create.
  const upsertGoal = (goal: Goal) => {
    setGoalsList(prev => {
      const idx = prev.findIndex(g => g.id === goal.id);
      if (idx >= 0) {
        const next = [...prev];
        // Merge new fields, keep the existing stamp, and reconcile steps so re-emitting set_goal to UPDATE
        // a goal doesn't wipe in-flight progress (done/blocked + ledgerId) — see mergeGoalSteps.
        next[idx] = { ...prev[idx], ...goal, steps: mergeGoalSteps(prev[idx].steps, goal.steps) };
        return next;
      }
      return [{ ...goal, ...authorStamp() }, ...prev].slice(0, 50);
    });
  };
  // When a goal-tied action is STAGED for approval, mark the goal's next pending step "blocked" (waiting on
  // the human) and link it to that Approvals entry — so the goal card shows "waiting on you" and the resume
  // hook can match the step back when it's approved. (Pure reducer in utils/goals.)
  const blockGoalStep = (goalId: string, ledgerId: string) =>
    setGoalsList(prev => prev.map(g => (g.id === goalId ? blockNextGoalStep(g, ledgerId) : g)));
  // Resume hook (the agentic goal loop): when a goal-tied Approvals entry is approved, advance the goal —
  // mark the step waiting on that entry done, then point at the next step (closing the goal when none remain).
  // The cross-time "loop": a staged step lands → the goal moves. (Pure reducer in utils/goals.)
  const advanceGoalOnApproval = (goalId: string, ledgerId: string) =>
    setGoalsList(prev => prev.map(g => (g.id === goalId ? advanceGoalStep(g, ledgerId) : g)));
  // A3 last-mile (3d): stage a confirm-tier "push to Google?" approval for newly-created event(s), so a
  // booking/trip event can reach the parent's REAL Google Calendar — reusing the existing push infra, only on
  // their approval (no silent external write). Client-staged (not an agent tool), keyed by the event ids.
  const stagePushToGoogle = (evs: CalendarEvent[]) => {
    if (!evs.length) return;
    const entry = buildLedgerEntry('ledg-' + uuid(), 'push_to_google', 'confirm', 'pending', {
      summary: evs.length === 1 ? `Push "${evs[0].title}" to your Google Calendar?` : `Push ${evs.length} events to your Google Calendar?`,
      refIds: evs.map(e => e.id),
    }, authorStamp());
    setActionLedger(prev => [...prev, entry].slice(-LEDGER_CAP));
  };

  // Kroger (client-staged, mirrors stagePushToGoogle): match the given shopping items to real products
  // at the household's chosen store, then stage ONE confirm-tier approval whose summary lists exactly
  // what will be added (+ what couldn't be matched). Approving it writes the cart (the applier above).
  const [krogerBusy, setKrogerBusy] = useState(false);
  const sendShoppingToKroger = async (items: string[]) => {
    const store = settings[0]?.krogerStoreId;
    if (!store) { setCopilotMessages(prev => [...prev, { role: 'assistant', text: 'Connect a Kroger store in Manage first.' }]); return; }
    if (!items.length) return;
    setKrogerBusy(true);
    try {
      const { matchKrogerItems } = await import('./utils/krogerClient');
      const { matched, unmatched } = await matchKrogerItems(items, store);
      if (!matched.length) {
        setCopilotMessages(prev => [...prev, { role: 'assistant', text: `Couldn't find any of those at ${settings[0]?.krogerStoreName || 'your store'} — ${unmatched.join(', ')} stay on your lists.` }]);
        return;
      }
      const { buildCartDraftSummary } = await import('./utils/krogerApi');
      const entry = buildLedgerEntry('ledg-' + uuid(), 'kroger_cart_write', 'confirm', 'pending', {
        summary: buildCartDraftSummary(settings[0]?.krogerStoreName || 'Kroger', matched, unmatched),
        payload: { items: matched.map(m => ({ upc: m.upc, quantity: 1, text: m.text })) },
      }, authorStamp());
      setActionLedger(prev => [...prev, entry].slice(-LEDGER_CAP));
      setCopilotMessages(prev => [...prev, { role: 'assistant', text: `🛒 Staged ${matched.length} item${matched.length === 1 ? '' : 's'} for your ${settings[0]?.krogerStoreName || 'Kroger'} cart — review in Approvals.` }]);
    } catch (err: any) {
      setCopilotMessages(prev => [...prev, { role: 'assistant', text: `⚠️ ${err?.message || 'Kroger matching failed.'}` }]);
    } finally {
      setKrogerBusy(false);
    }
  };

  // (Per-device idle/reminder prefs + their persistence + the reminder toggle now live in
  // useDevicePrefs; the reminder SCHEDULER below stays here because it reads events/chores.)

  // Show a reminder via the service-worker registration (required on mobile/installed PWAs);
  // fall back to a page Notification on desktop. All failures are non-fatal.
  const showReminderNotification = (content: ReminderContent) => {
    const opts = { body: content.body, tag: 'familyhub-daily', icon: '/icon.svg', badge: '/icon.svg', renotify: true } as NotificationOptions;
    try {
      if ('serviceWorker' in navigator && navigator.serviceWorker?.ready) {
        navigator.serviceWorker.ready
          .then(reg => reg.showNotification(content.title, opts))
          .catch(() => { try { new Notification(content.title, opts); } catch { /* ignore */ } });
      } else {
        new Notification(content.title, opts);
      }
    } catch { /* notifications unsupported — ignore */ }
  };

  // Resolve a typed home town to lat/lon via the server geocode endpoint and persist it to the
  // household settings blob (used to ground the copilot's weather lookup). Returns a result the
  // account menu can show; never throws. State lives here (App), not in the menu component.
  const handleSaveHomeLocation = async (query: string): Promise<{ ok: boolean; label?: string; error?: string }> => {
    const q = query.trim();
    if (!q) return { ok: false, error: 'Enter a ZIP code or "lat, lng".' };
    // Both ZIP and "lat, lng" go through /api/geocode now — the server reverse-geocodes coords to "City, State"
    // (#4) instead of storing the raw numbers as the label.
    try {
      const res = await apiFetch('/api/geocode', { method: 'POST', body: JSON.stringify({ q }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.label || typeof data.lat !== 'number' || typeof data.lng !== 'number') {
        return { ok: false, error: data?.error || `Couldn't find "${q}".` };
      }
      setSettings([{ homeLabel: data.label, homeLat: data.lat, homeLng: data.lng }]);
      return { ok: true, label: data.label };
    } catch (err: any) {
      return { ok: false, error: 'Could not reach the location service.' };
    }
  };

  // One-time migration (#4): a home previously stored with a raw "lat, lng" label gets reverse-geocoded to
  // "City, State" so the weather card + Manage stop showing bare coordinates (the ref guards against a loop).
  const homeLabelMigrated = useRef(false);
  useEffect(() => {
    if (homeLabelMigrated.current) return;
    const s = settings[0] as { homeLabel?: string; homeLat?: number; homeLng?: number } | undefined;
    if (s && typeof s.homeLat === 'number' && typeof s.homeLng === 'number'
        && /^\s*-?\d{1,2}(\.\d+)?\s*,\s*-?\d{1,3}(\.\d+)?\s*$/.test(String(s.homeLabel || ''))) {
      homeLabelMigrated.current = true;
      void handleSaveHomeLocation(`${s.homeLat}, ${s.homeLng}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  // Keep the latest events/chores in a ref so the 60s reminder interval can read them WITHOUT listing
  // them as effect deps — otherwise every event/chore edit tore down and recreated the interval
  // (re-running runAll() on each), churning during a Google-sync burst.
  const reminderDataRef = useRef({ events, choresList });
  useEffect(() => { reminderDataRef.current = { events, choresList }; }, [events, choresList]);

  // Daily reminder scheduler: while enabled, check each minute whether the configured time
  // has passed today and (if so, once) show today's events + still-due chores. Marks the day
  // as fired even when there's nothing to report, so it doesn't re-check all day.
  useEffect(() => {
    if (!remindersEnabled) return;
    const tick = () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = new Date();
      const today = toLocalDateStr(now);
      if (!shouldFireDailyReminder(now, reminderTime, reminderFiredDateRef.current, today)) return;
      const content = buildDailyReminder(reminderDataRef.current.events, reminderDataRef.current.choresList, today);
      // Nothing to report yet — stay "armed" (don't mark fired) so items added later today
      // still trigger the reminder, instead of silently skipping the whole day.
      if (!content) return;
      // Mark fired synchronously BEFORE the async notification so a StrictMode/dep-rerun
      // double-tick can't fire twice (the 2nd tick sees today's date and bails).
      reminderFiredDateRef.current = today;
      localStorage.setItem('famplan_reminder_lastfired', today);
      showReminderNotification(content);
    };

    // Per-event "X min before" reminders for today's timed events (fired once each per day).
    const tickEventReminders = () => {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      const now = new Date();
      const today = toLocalDateStr(now);
      const fired = eventRemindersFiredRef.current;
      if (fired.date !== today) { fired.date = today; fired.ids = new Set(); }
      const due = dueEventReminders(reminderDataRef.current.events, today, now, reminderLeadMinutes, fired.ids);
      if (!due.length) return;
      for (const d of due) { fired.ids.add(d.id); showReminderNotification({ title: d.title, body: d.body }); }
      localStorage.setItem('famplan_event_reminders_fired', JSON.stringify({ date: fired.date, ids: [...fired.ids] }));
    };

    const runAll = () => { tick(); tickEventReminders(); };
    runAll(); // check immediately (e.g. app opened after the reminder time)
    const iv = setInterval(runAll, 60 * 1000);
    return () => clearInterval(iv);
  }, [remindersEnabled, reminderTime, reminderLeadMinutes]); // events/chores read via ref — no re-subscribe churn

  // Weekly chore reset — shared by bootstrap AND on-wake refresh, so a multi-day always-on
  // display rolls the week without a manual reload. Once per ISO week: bank each kid's earned
  // XP, zero completedCounts, advance the marker. Computed from just-loaded cloud data and
  // persisted explicitly (callers hold suppressSync, so the persist effects won't write).
  // Reconcile chore resets against the stored week+day markers. WEEK rollover banks + zeroes ALL
  // chores (applyWeeklyReset); a same-week DAY rollover banks + zeroes only DAILY chores
  // (applyDailyReset) so e.g. "brush teeth" is actionable again each day without losing earned XP.
  // First run / legacy blobs (no markers) just stamp the markers — never a surprise reset.
  const reconcileChoreResets = (
    hid: string, loadedChores: Chore[], loadedBank: XpBankEntry[],
    storedWeek: string | undefined, storedDay: string | undefined,
  ) => {
    const currentWeek = isoWeekKey(new Date());
    const currentDay = toLocalDateStr(new Date());
    if (!storedWeek) {
      setChoreWeekList([{ week: currentWeek, day: currentDay }]);
      saveHouseholdData(hid, 'choreweek', [{ week: currentWeek, day: currentDay }]);
      return;
    }
    let chores = loadedChores, bank = loadedBank;
    const weekChanged = storedWeek !== currentWeek;
    const dayReset = !weekChanged && !!storedDay && storedDay !== currentDay;
    if (weekChanged) {
      ({ chores, bank } = applyWeeklyReset(loadedChores, loadedBank));
    } else if (dayReset) {
      ({ chores, bank } = applyDailyReset(loadedChores, loadedBank));
    }
    // Multi-tab guard (W8): the first tab of THIS browser to stamp the rollover marker persists it;
    // any sibling tab still applies the reset to its own state (so both render post-reset) but skips
    // the saves — no same-browser double-write race. Cross-device races stay the CAS's job.
    const rolled = weekChanged || dayReset;
    const ownsRollover = !rolled || acquireResetLock('famplan_choreResetDone', `${currentWeek}:${currentDay}`);
    if (rolled) {
      setChoresList(chores);
      setXpBankList(bank);
      if (ownsRollover) {
        saveHouseholdData(hid, 'chores', chores);
        saveHouseholdData(hid, 'xpbank', bank);
      }
    }
    if (weekChanged || storedDay !== currentDay) {
      setChoreWeekList([{ week: currentWeek, day: currentDay }]);
      if (ownsRollover) saveHouseholdData(hid, 'choreweek', [{ week: currentWeek, day: currentDay }]);
    }
  };

  // Reload all collections from the cloud (manual refresh button + screensaver wake) so an
  // always-on display never serves stale content. suppressSync blocks echo-writes during load.
  // The active load is tracked in a REF (not just isRefreshing state) so a concurrent caller
  // `await`s the RUNNING load instead of getting an instantly-resolved no-op — otherwise
  // applyAgentActions' "await refresh, THEN apply the optimistic goal/drafts" ordering silently
  // breaks (the await returns early and the in-flight refresh clobbers the just-added goal/ledger).
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshHouseholdData = (): Promise<void> => {
    if (!householdId) return Promise.resolve();
    if (refreshInFlightRef.current) return refreshInFlightRef.current; // join the running load
    const p = (async () => {
      setIsRefreshing(true);
      beginLoad();
      try {
        const cloud = await loadHouseholdData(householdId);
        COLLECTIONS.forEach(c => c.set(cloud[c.dataKey] ?? []));
        reconcileChoreResets(householdId, cloud.chores ?? [], cloud.xpbank ?? [], cloud.choreweek?.[0]?.week, cloud.choreweek?.[0]?.day);
      } catch (err: any) {
        setErrorStatus('Could not refresh your data: ' + (err?.message || String(err)));
      } finally {
        endLoad();
        setIsRefreshing(false);
        refreshInFlightRef.current = null;
      }
    })();
    refreshInFlightRef.current = p;
    return p;
  };

  // Optimistic concurrency (§5.3): when saveHouseholdData rejects a STALE write (a concurrent device/agent
  // wrote first), converge by reloading the latest. Registered once; the ref always points at the current
  // refreshHouseholdData so it isn't a stale closure.
  // W8 last-mile: the refresh used to be SILENT — the screen visibly changed under the user with no
  // explanation. Surface a short "Updated elsewhere" toast alongside it. Burst-debouncing lives in
  // supabase.ts (fireStaleRefresh, one handler call per 300ms burst); here we only show a 4s pill.
  const refreshRef = useRef(refreshHouseholdData);
  refreshRef.current = refreshHouseholdData;
  const [staleToastVisible, setStaleToastVisible] = useState(false);
  const staleToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setStaleWriteHandler(() => {
      void refreshRef.current();
      setStaleToastVisible(true);
      if (staleToastTimerRef.current) clearTimeout(staleToastTimerRef.current);
      staleToastTimerRef.current = setTimeout(() => { staleToastTimerRef.current = null; setStaleToastVisible(false); }, 4000);
    });
    return () => { setStaleWriteHandler(null); if (staleToastTimerRef.current) clearTimeout(staleToastTimerRef.current); };
  }, []);

  // Idle screensaver: after the configured idle window (0 = Off), blank to a power-saving
  // screen; waking refreshes data before revealing content.
  useIdleTimeout(!!googleUser && !screensaverOn && idleTimeoutMs > 0, () => setScreensaverOn(true), idleTimeoutMs);
  const handleWakeFromScreensaver = async () => {
    await refreshHouseholdData();
    setScreensaverOn(false);
  };

  // Security: optionally sign out after a longer idle (0 = Off). Tracks total inactivity
  // independently of the screensaver, so any activity (incl. waking) resets it.
  useIdleTimeout(!!googleUser && signOutMs > 0, () => {
    setScreensaverOn(false);
    setErrorStatus('Signed out after extended inactivity.');
    handleGoogleLogoutClick();
  }, signOutMs);

  // Keep the "new chore" assignee pointing at a real kid as the family list changes.
  useEffect(() => {
    const kidNames = familyMembers.filter(m => m.role === 'Kid').map(m => m.name);
    if (kidNames.length > 0 && !kidNames.includes(newChoreAssigned)) {
      setNewChoreAssigned(kidNames[0]);
    }
  }, [familyMembers, newChoreAssigned]);

  // Always-on display: reset daily chores at local midnight (and weekly at week rollover) even with
  // no manual refresh. Checks each minute against the stored week/day markers. Latest state is read
  // via refs so the interval is created ONCE per household (no teardown/restart on every chore action),
  // and it skips while a load is in flight (suppressSync > 0) to avoid racing a refresh's writes.
  const choresRef = useRef(choresList); choresRef.current = choresList;
  const xpBankRef = useRef(xpBankList); xpBankRef.current = xpBankList;
  const choreWeekRef = useRef(choreWeekList); choreWeekRef.current = choreWeekList;
  useEffect(() => {
    if (!householdId) return;
    const tick = () => {
      if (suppressSync.current > 0) return;
      const storedWeek = choreWeekRef.current[0]?.week;
      if (!storedWeek) return;
      const storedDay = choreWeekRef.current[0]?.day;
      if (storedWeek !== isoWeekKey(new Date()) || storedDay !== toLocalDateStr(new Date())) {
        reconcileChoreResets(householdId, choresRef.current, xpBankRef.current, storedWeek, storedDay);
      }
    };
    const iv = setInterval(tick, 60 * 1000);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  // Post-sign-in bootstrap: load the household's cloud data, prompt for a name on first
  // profile, detect a brand-new household, and auto-connect the primary Google calendar.
  // Extracted from the auth listener (below) so that listener reads as orchestration;
  // all state stays in App() so this keeps closure access to every setter/ref.
  const bootstrapSignedInUser = async (user: User, token: string | null) => {
    const gen = ++bootstrapGenRef.current; // this attempt's generation
    const local = getBackendMode() === 'sqlite';
    beginLoad();
    try {
      // Local appliance: the box owns the single household (the session carries it); no Supabase lookup.
      const hid = local ? 'local' : await withTimeout(getOrCreateHousehold(user.id), BOOTSTRAP_STEP_TIMEOUT_MS, 'household lookup');
      const cloudData = await withTimeout(loadHouseholdData(hid), BOOTSTRAP_STEP_TIMEOUT_MS, 'household data');
      // Bail if a newer sign-in or the watchdog superseded this attempt — don't commit stale state
      // into a reset/zombie UI (the finally still balances beginLoad).
      if (gen !== bootstrapGenRef.current) return;
      setHouseholdId(hid);
      // If this device's cached data belongs to a DIFFERENT household than the one we're loading,
      // REPLACE every collection (even empties) so stale data from a previous household can't bleed
      // through (e.g. old chores showing for one member but not the other). Same household → keep the
      // "only overwrite when the cloud has data" rule, which guards a racy/partial load from wiping
      // good local data (🐞 #6).
      const prevHid = localStorage.getItem(HOUSEHOLD_ID_KEY);
      const switchedHousehold = prevHid !== null && prevHid !== hid;
      COLLECTIONS.forEach(c => {
        if (switchedHousehold) c.set(cloudData[c.dataKey] ?? []);
        else if (cloudData[c.dataKey]?.length) c.set(cloudData[c.dataKey]);
      });
      localStorage.setItem(HOUSEHOLD_ID_KEY, hid);

      // Weekly chore reset (shared helper; also runs on screensaver-wake refresh).
      reconcileChoreResets(hid, cloudData.chores ?? [], cloudData.xpbank ?? [], cloudData.choreweek?.[0]?.week, cloudData.choreweek?.[0]?.day);

      // Find this user's OWN profile by auth userId OR (stable) Google email, and SELF-HEAL a
      // drifted/missing link so identity survives an auth id change — no spurious name prompt, no
      // split household. Persist the re-link immediately (the save-effect is suppressed in bootstrap).
      const existingMembers: FamilyMember[] = cloudData.members?.length ? cloudData.members : [];
      const ownIdx = matchOwnProfileIndex(existingMembers, user.id, user.email || undefined);
      if (ownIdx >= 0) {
        const { members: healed, changed } = healMemberLink(existingMembers, ownIdx, user.id, user.email || undefined);
        if (changed) {
          setFamilyMembers(healed);
          saveHouseholdData(hid, 'members', healed);
        }
      }
      const hasProfile = ownIdx >= 0;
      // Recovery: the cloud lost the members blob (a dropped write from the old save race) but this
      // device still has the cached members for THIS household → push them back so the profiles are
      // shared, not stranded on one device (and a joiner sees them). Only when NOT switching
      // households (a switch already replaced local with the cloud's empty members).
      if (!switchedHousehold && !existingMembers.length && familyMembers.length) {
        saveHouseholdData(hid, 'members', familyMembers);
      }
      // Only gate on a name when it's genuinely needed: a real first sign-in (nothing loaded at all)
      // or joining a household that already has members. If OTHER data loaded but `members` came back
      // empty, that's a racy/partial load for an EXISTING user — never prompt (🐞 #6 lockout guard).
      const hasOtherData = COLLECTIONS.some(c => c.dataKey !== 'members' && (cloudData[c.dataKey]?.length || 0) > 0);
      if (!hasProfile && (existingMembers.length > 0 || !hasOtherData)) {
        // No-login demo (Supabase anonymous auth): a brand-new anonymous visitor gets a SEEDED sample
        // household (members + a week of activity + a home location) instead of the name prompt, so the
        // demo lands on a populated, lively dashboard with the grounded copilot working. Persisted
        // directly (the save-effect is suppressed during bootstrap, like the member self-heal above).
        // `is_anonymous` is the primary signal; the one-shot demoSeedPendingRef (set by "Try the demo")
        // is a fallback in case the SDK doesn't surface it — consumed here so it can't leak to a later
        // sign-in on a different account.
        const wantDemoSeed = (user as any).is_anonymous === true || demoSeedPendingRef.current;
        demoSeedPendingRef.current = false;
        if (wantDemoSeed && !existingMembers.length && !hasOtherData) {
          const now = new Date();
          const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const seed = buildDemoSeed(todayStr, user.id);
          COLLECTIONS.forEach(c => { if (seed[c.dataKey]) c.set(seed[c.dataKey]); });
          Object.entries(seed).forEach(([k, v]) => saveHouseholdData(hid, k, v));
        } else {
          setNameInput('');
          setNeedsNamePrompt(true);
        }
      }

      // A brand-new household: no profile yet AND nothing previously connected.
      const isFirstSignIn = !hasProfile && !cloudData.calendars?.length;

      // Non-critical (only surfaced in the calendar sync panel): bound it and swallow failure so a
      // stalled/failed invite-code fetch can't hang the splash or fail an otherwise-good load.
      if (!local) {
        try {
          const code = await withTimeout(getInviteCode(hid), BOOTSTRAP_STEP_TIMEOUT_MS, 'invite code');
          setCloudInviteCode(code);
        } catch (e) {
          console.warn('Invite code fetch failed (non-fatal):', e);
        }
      }

      if (token) {
        // On the very first sign-in, auto-connect the user's primary Google
        // calendar and pull events once so "sign in with Google" actually
        // surfaces their existing events (Bug 3). Otherwise just list calendars.
        if (isFirstSignIn) {
          autoConnectPrimaryCalendar(token, 'Family', user.email || '');
        } else {
          fetchGoogleCalendars(token);
        }
      }
    } catch (err: any) {
      console.error('Error loading household data:', err);
      if (gen !== bootstrapGenRef.current) return; // superseded — don't clobber a newer attempt's UI
      // A genuine failure (a stalled round-trip that hit BOOTSTRAP_STEP_TIMEOUT_MS, or a real error):
      // drop back to the sign-in gate with the same retryable message the watchdog uses, and clear the
      // bootstrapped-user ref so "Sign in" re-runs the load from scratch. (Previously this only set an
      // errorStatus the gate never showed for a signed-in user, stranding them on a blank app.)
      bootstrappedUserIdRef.current = null;
      setGoogleUser(null);
      setErrorStatus(SERVER_UNREACHABLE_MSG);
    } finally {
      endLoad(); // balances beginLoad on every path (success / supersede-return / throw)
      if (gen === bootstrapGenRef.current) setBootstrapping(false); // clear the splash for THIS attempt only
    }
  };

  // Local appliance: a successful box login (or an existing box session) starts the bootstrap with a synthetic
  // local user, reusing bootstrapSignedInUser (which loads via /api/data and skips the Supabase household lookup).
  const startLocalSession = () => {
    const u = { id: 'local', email: undefined } as unknown as User;
    bootstrappedUserIdRef.current = 'local';
    setGoogleUser(u);
    setBootstrapping(true);
    setTimeout(() => bootstrapSignedInUser(u, null), 0);
  };
  const handleLocalAuthed = () => { setLocalConfigured(true); startLocalSession(); };

  // Boot: ask the box which backend it runs (cloud Supabase vs local SQLite). In local mode we drive our own
  // auth (LocalAuthGate) and disarm the Supabase watchdog; in cloud mode the Supabase listener below takes over
  // once appMode resolves. Runs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const status = await fetchAuthStatus();
      if (cancelled) return;
      setLocalConfigured(status.configured);
      setAppMode(status.mode);
      if (status.mode === 'sqlite') {
        authResolvedRef.current = true; // local mode resolves identity itself — disarm the Supabase watchdog
        setAuthChecked(true);
        if (hasLocalSession()) startLocalSession();
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Supabase auth listener — fires on mount (with cached session) and on sign-in/out.
  // NOTE: the callback is intentionally NOT async and does NOT await the household load. Supabase
  // invokes this while holding its auth lock; awaiting token-bearing queries (getOrCreateHousehold /
  // loadHouseholdData) here serializes them behind that lock and keeps the SESSION marked unresolved
  // until ALL the data finishes downloading — so a slow-but-successful load would let the watchdog
  // fire a false "couldn't reach server". Instead: resolve the session synchronously (we already know
  // who the user is), then run the data load DEFERRED (outside the lock) with its own splash + errors.
  useEffect(() => {
    if (appMode !== 'supabase') return; // local appliance handles its own bootstrap (see the boot effect below)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      const user = session?.user ?? null;
      setGoogleUser(user);
      const token = session?.provider_token ?? null;
      setGoogleToken(token);

      // Stash the Google refresh token when present (only right after OAuth) so
      // calendar sync keeps working after a page reload.
      if (session?.provider_refresh_token) {
        setStoredGoogleRefreshToken(session.provider_refresh_token);
      }

      if (user) {
        // Only bootstrap (load household + check for a profile) when the user actually changes.
        // Re-emitted events for the SAME user (token refresh, focus, USER_UPDATED) must NOT re-run
        // it — a racy re-load was falsely re-gating existing users with the name prompt (🐞 #6).
        // Set the ref BEFORE scheduling so a concurrent re-emit can't double-run.
        if (bootstrappedUserIdRef.current !== user.id) {
          bootstrappedUserIdRef.current = user.id;
          setBootstrapping(true); // hold the loading splash until the deferred load settles
          // Defer OUT of the auth-lock context (see note above). The app stays on the splash (gated by
          // `bootstrapping`) so no data effect mounts before the load completes — same invariant as before.
          setTimeout(() => { bootstrapSignedInUser(user, token); }, 0);
        }
      } else {
        bootstrappedUserIdRef.current = null;
        bootstrapGenRef.current++; // invalidate any in-flight bootstrap so it can't commit post-sign-out
        setBootstrapping(false);
        setHouseholdId(null);
        setCloudInviteCode(null);
        setGoogleCalendarsList([]);
        setNeedsNamePrompt(false);
        setStoredGoogleRefreshToken(null);
        suppressSync.current = 0;
      }

      authResolvedRef.current = true;
      setAuthChecked(true);
    });

    return () => subscription.unsubscribe();
  }, [appMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watchdog: now that the session resolves synchronously in the listener above, this only trips when
  // the auth event NEVER arrives within the grace period — i.e. Supabase's own auth init can't reach
  // supabase.co (no internet / captive portal / DNS), so onAuthStateChange never fires and the
  // "Loading…" splash would otherwise hang forever. Drop to the sign-in screen with a clear message.
  // (The household-load phase has its own BOOTSTRAP_STEP_TIMEOUT_MS guard; this guards the phase before
  // it.) Signing in again (a full OAuth redirect) remounts and retries from scratch.
  useEffect(() => {
    const t = setTimeout(() => {
      if (authResolvedRef.current) return; // session already resolved — nothing to do
      authResolvedRef.current = true;
      bootstrappedUserIdRef.current = null; // allow a later token-refresh/retry to re-run bootstrap
      bootstrapGenRef.current++;            // invalidate the in-flight bootstrap we're giving up on
      setBootstrapping(false);              // clear the splash
      setGoogleUser(null);                  // land on SignInGate, not a half-loaded app
      setErrorStatus(SERVER_UNREACHABLE_MSG);
      setAuthChecked(true);
    }, AUTH_RESOLVE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Dynamic helper: Days of Week starting on Monday
  const DAYS_OF_WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];


  const calendarCells = useMemo(
    () => generateCalendarCells(currentMonthInfo.index, currentMonthInfo.year),
    [currentMonthInfo.index, currentMonthInfo.year],
  );

  // Per-date event index: built once per `events` change (O(events), multi-day spans expanded), then
  // O(1) lookup per cell — replaces the O(cells × events) filtering the board did every render.
  const eventsByDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    const nextISO = (iso: string) => {
      const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10);
    };
    for (const evt of events) {
      if (!evt.start) continue;
      const start = evt.start.split('T')[0];
      const end = evt.end ? evt.end.split('T')[0] : start;
      let d = start;
      for (let guard = 0; d <= end && guard < 400; guard++) {
        const arr = m.get(d); if (arr) arr.push(evt); else m.set(d, [evt]);
        d = nextISO(d);
      }
    }
    return m;
  }, [events]);

  // Check event matches filters. useCallback so the calendar board (which calls this per cell ×
  // the 4-month window) gets a stable reference and only re-filters when a filter actually changes.
  const filterEvent = useCallback((item: CalendarEvent) => {
    // Search query match
    const searchLower = searchQuery.toLowerCase();
    const matchesSearch = !searchQuery ||
      item.title.toLowerCase().includes(searchLower) ||
      (item.description && item.description.toLowerCase().includes(searchLower)) ||
      (item.location && item.location.toLowerCase().includes(searchLower));

    // Category match
    const matchesCategory = activeCategoryFilter === 'All' || item.category === activeCategoryFilter;

    // Member match
    const matchesMember = activeMemberFilter === 'All' || (item.members && item.members.includes(activeMemberFilter));

    return !!(matchesSearch && matchesCategory && matchesMember); // coerce to boolean (the && chain can leak ''/undefined)
  }, [searchQuery, activeCategoryFilter, activeMemberFilter]);

  // O(1) per-date lookup via the prebuilt index (was an O(events) filter per cell). The returned
  // array is read-only (the calendar board only maps over it).
  const getEventsForDate = useCallback((dateStr: string) => eventsByDate.get(dateStr) || [], [eventsByDate]);


  // Find overlapping activity conflicts — memoized so it only recomputes when events change.
  const conflicts = useMemo(() => {
    // Time-aware detection (only overlapping TIMED events clash; all-day events never do),
    // then windowed to today … +2 weeks so no past/far-future noise. Both are pure + tested.
    const today = new Date();
    const horizon = new Date();
    horizon.setDate(today.getDate() + 14);
    return filterConflictWindow(detectConflicts(events), toLocalDateStr(today), toLocalDateStr(horizon));
  }, [events]);

  // Recurring daily events (e.g. a Google series expanded into one card per day) —
  // surfaced as a warning so the user can bulk-delete the clutter. Memoized like conflicts.
  const recurringGroups = useMemo(() => detectRecurringGroups(events), [events]);

  // Open weekend count in current month view
  // Saturdays and Sundays with zero events assigned
  const getOpenWeekendsCount = () => {
    let count = 0;
    // Iterate over Saturdays & Sundays in the current view month
    calendarCells.forEach(cell => {
      if (cell.isCurrentMonth) {
        const dateObj = parseLocalDate(cell.dateStr);
        const dayOfWeek = dateObj.getDay(); // 0 is Sunday, 6 is Saturday
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          const dayEvents = getEventsForDate(cell.dateStr);
          if (dayEvents.length === 0) {
            count++;
          }
        }
      }
    });
    return count;
  };

  const openWeekendsLeft = getOpenWeekendsCount();

  // First-sign-in convenience: auto-connect the user's primary Google calendar as a
  // PULL source and run a one-time import, so existing events show up immediately
  // instead of requiring a manual connect + "Execute Complete Sync" (Bug 3).
  const autoConnectPrimaryCalendar = async (token: string, assignTo: string, accountEmail: string) => {
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        console.error('Auto-connect: failed to fetch calendar list:', await res.text());
        return;
      }
      const data = await res.json();
      const items: GoogleCalendarListEntry[] = data.items || [];
      setGoogleCalendarsList(items);

      const primary = items.find(c => c.primary) || items[0];
      if (!primary) return;

      const newConn: ConnectedCalendar = {
        id: primary.id,
        summary: primary.summary || 'Primary Calendar',
        accountEmail: accountEmail || primary.id,
        direction: 'pull',
        assignedTo: assignTo,
        active: true,
      };
      setConnectedCalendars(prev =>
        prev.some(c => c.id === newConn.id && c.direction === 'pull') ? prev : [...prev, newConn]
      );
      setCalendarSyncLogs(prev => [
        ...prev,
        `Auto-connected your primary calendar "${newConn.summary}" and imported existing events.`,
      ]);

      // Sync the freshly-created connection directly — state isn't committed yet,
      // so pass it through explicitly instead of relying on connectedCalendars.
      await syncGoogleCalendars(token, [newConn]);
    } catch (err) {
      console.error('Auto-connect primary calendar failed:', err);
    }
  };

  // Multi-parent 2-way visibility: does the signed-in account have its OWN calendar connection yet?
  // connectedCalendars is SHARED household data, so a parent who JOINED an existing household sees the
  // other parent's rules but has none of their own — their events aren't in the shared schedule until
  // they connect. Drives the one-tap "Connect my calendar" auto-offer below.
  const hasOwnCalendarConnection = !!googleUser?.email && connectedCalendars.some(c => c.accountEmail === googleUser.email);

  // Auto-offer: connect the signed-in parent's OWN primary calendar (tagged to their member) and import,
  // so their events land in the shared schedule for the rest of the family — without hunting through the
  // Available list to find it. Reuses autoConnectPrimaryCalendar (the first-sign-in path).
  const connectOwnCalendar = async () => {
    const token = await getGoogleToken();
    if (!token) { alert('Please sign in with Google first to connect your calendar.'); return; }
    const ownName = familyMembers[matchOwnProfileIndex(familyMembers, googleUser?.id, googleUser?.email ?? undefined)]?.name || 'Family';
    await autoConnectPrimaryCalendar(token, ownName, googleUser?.email || '');
  };

  // Fetch calendar list of authenticated user from Google
  const fetchGoogleCalendars = async (token: string) => {
    setIsFetchingCalendars(true);
    try {
      const res = await fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setGoogleCalendarsList(data.items || []);
      } else {
        console.error('Failed to fetch calendar list:', await res.text());
      }
    } catch (err) {
      console.error('Error fetching calendar list:', err);
    } finally {
      setIsFetchingCalendars(false);
    }
  };

  // No-login demo — Supabase anonymous auth. onAuthStateChange picks up the anon session and
  // bootstrapSignedInUser seeds the sample household (see the is_anonymous branch there).
  const handleTryDemo = async () => {
    setErrorStatus(null);
    demoSeedPendingRef.current = true; // bootstrap consumes this to seed the demo household
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) { demoSeedPendingRef.current = false; throw error; }
    } catch (err: any) {
      console.error('Demo sign-in failed:', err);
      const msg = err?.message || String(err);
      setErrorStatus(
        'Could not start the demo: ' + msg +
        (/anonymous|disabled|provider/i.test(msg) ? ' — enable Anonymous sign-ins in Supabase → Auth → Providers.' : ''),
      );
    }
  };

  // Google OAuth Login — initiates Supabase redirect flow to Google
  const handleGoogleLogin = async () => {
    try {
      await signInWithGoogle();
      // Page redirects to Google; onAuthStateChange handles the session on return
    } catch (err: any) {
      console.error('Google Sign-in failed:', err);
      setErrorStatus(`Sign-in failed: ${err.message || err}`);
    }
  };

  // Sign out
  const handleGoogleLogoutClick = async () => {
    try {
      await supabaseSignOut(); // also clears the local box session token (signOut in supabase.ts)
      // Cloud: onAuthStateChange fires with null session and clears googleUser. Local appliance: that listener
      // isn't subscribed, so reset here ourselves → we land back on the LocalAuthGate.
      if (getBackendMode() === 'sqlite') {
        bootstrappedUserIdRef.current = null;
        setGoogleUser(null);
        setHouseholdId(null);
      }
      setGoogleCalendarsList([]);
      // Wipe the persisted copilot transcript + agent session on sign-out (incl. idle auto-sign-out) so the
      // family chat (kids' names, schedules, plans) doesn't survive in cleartext for the next user on a shared
      // device — the server-side data is RLS-scoped, this keeps the local cache consistent with that.
      try { localStorage.removeItem('famplan_copilot_messages'); localStorage.removeItem('famplan_agent_session'); } catch { /* non-fatal */ }
      setCopilotMessages([{ role: 'assistant', text: "👋 **Hi! I'm your Family's Copilot.** Tell me what you'd like to start with." }]);
      setAgentSessionId('');
      setCalendarSyncLogs(prev => [...prev, 'Signed out of Google account.']);
    } catch (err: any) {
      console.error('Logout failed:', err);
      setErrorStatus('Sign-out failed: ' + (err?.message || String(err)) + '. Please try again.');
    }
  };

  // Join another household via invite code (e.g. wife joining husband's household)
  const handleJoinHousehold = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!googleUser || !inviteCodeInput.trim()) return;

    // Joining replaces this device's data with the household's shared data, so local
    // items don't leak upward into the household. Warn if there's anything to lose.
    const hasLocalData = COLLECTIONS.some(c => c.countsAsLocal && c.value.length);
    if (hasLocalData && !window.confirm(
      'Joining a household replaces the data on THIS device with the shared household data. ' +
      'Items you added locally before joining will be discarded. Continue?'
    )) {
      return;
    }

    setIsJoiningHousehold(true);
    beginLoad();
    try {
      const success = await joinHousehold(googleUser.id, inviteCodeInput.trim());
      if (success) {
        const hid = await getOrCreateHousehold(googleUser.id);
        setHouseholdId(hid);
        const cloudData = await loadHouseholdData(hid);
        // Replace (not merge) — discard local data so it can't pollute the household.
        COLLECTIONS.forEach(c => c.set(cloudData[c.dataKey] ?? []));
        // Roll the chore week if the joined household's marker is stale (matches bootstrap/refresh) —
        // otherwise joining mid-week on a new device would skip the reset until the next reload.
        reconcileChoreResets(hid, cloudData.chores ?? [], cloudData.xpbank ?? [], cloudData.choreweek?.[0]?.week, cloudData.choreweek?.[0]?.day);
        // Tag the cache with the joined household so a later reload doesn't treat it as a switch.
        localStorage.setItem(HOUSEHOLD_ID_KEY, hid);
        const code = await getInviteCode(hid);
        setCloudInviteCode(code);

        // Prompt for a name only if the user has no profile in the joined household yet — matched by
        // BOTH userId and stable email (so a returning member whose profile is email-linked but whose
        // auth userId changed isn't wrongly re-prompted to create a duplicate; mirrors the bootstrap).
        const joinedMembers: FamilyMember[] = cloudData.members?.length ? cloudData.members : [];
        if (matchOwnProfileIndex(joinedMembers, googleUser.id, googleUser.email) < 0) {
          setNameInput('');
          setNeedsNamePrompt(true);
        }

        setInviteCodeInput('');
        alert('Joined household successfully! You now share data with your family.');
      } else {
        alert('Invite code not found. Please check with your family member and try again.');
      }
    } catch (err: any) {
      console.error('Join household error:', err);
      alert('Error joining household: ' + err.message);
    } finally {
      endLoad();
      setIsJoiningHousehold(false);
    }
  };

  // Create the signed-in user's own profile (Parent) from the name picker
  const handleSubmitName = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed || !googleUser) return;

    // If a member with this name already exists, RE-CLAIM it (link this account to that profile)
    // instead of rejecting. An established user whose member.userId drifted (🐞 #6) would otherwise
    // type their real name, hit "already exists", and be forced to create a DUPLICATE parent — the
    // lockout the owner hit. Only confirm when the profile is currently linked to a DIFFERENT account.
    const existing = familyMembers.find(m => m.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      const claimedByAnother = !!existing.userId && existing.userId !== googleUser.id;
      if (claimedByAnother && !window.confirm(
        `"${trimmed}" is currently linked to a different sign-in. Re-link this profile to the account you're signed in as now?`
      )) {
        return;
      }
      // Re-link the matching profile to this account (clears the drift) + record the stable email so
      // the link survives a future id change. Persist EXPLICITLY (not via the save-effect) so a
      // first-profile write can't be silently dropped by a load race — leaving the user re-prompted
      // on the next device/reload (the "members never reached the cloud" failure).
      const relinked = familyMembers.map(m =>
        m.name.toLowerCase() === trimmed.toLowerCase() ? { ...m, userId: googleUser.id, email: googleUser.email ?? m.email } : m
      );
      setFamilyMembers(relinked);
      if (householdId) saveHouseholdData(householdId, 'members', relinked);
      setNeedsNamePrompt(false);
      setNameInput('');
      return;
    }

    const usedColors = new Set(familyMembers.map(m => m.color));
    const nextColor = MEMBER_COLORS_LIST.find(c => !usedColors.has(c.id))?.id ?? MEMBER_COLORS_LIST[0].id;
    const newMember: FamilyMember = { name: trimmed, role: 'Parent', color: nextColor, userId: googleUser.id, email: googleUser.email ?? undefined };

    // Append the member AND persist explicitly — the save-effect alone could drop this first write
    // under a load race, stranding the profile in localStorage only (the cloud `members` blob would
    // stay empty and re-prompt on the next device).
    const withNew = [...familyMembers, newMember];
    setFamilyMembers(withNew);
    if (householdId) saveHouseholdData(householdId, 'members', withNew);
    setNameInput('');
    // Keep the modal open and advance to the optional onboarding-prefs step for this new profile.
    // (Reclaim above closes immediately — an existing user already has their prefs.)
    setOnboardingName(trimmed);
  };

  // Apply the (optional) first-login dietary/interests onto the just-created profile, then close.
  const handleSaveOnboardingPrefs = ({ dietary, interests }: { dietary: string; interests: string }) => {
    if (onboardingName) {
      const updated = familyMembers.map(m =>
        m.name === onboardingName ? { ...m, dietary: dietary.trim() || undefined, interests: interests.trim() || undefined } : m
      );
      setFamilyMembers(updated);
      if (householdId) saveHouseholdData(householdId, 'members', updated);
    }
    setOnboardingName(null);
    setNeedsNamePrompt(false);
  };

  // Skip the onboarding-prefs step (they can fill them later in Manage).
  const dismissOnboarding = () => {
    setOnboardingName(null);
    setNeedsNamePrompt(false);
  };

  // One-click "that's me" from the name prompt: re-link an existing profile to this account (clears
  // a drifted userId so the user isn't forced to create a duplicate). 🐞 #6 hardening.
  const handleReclaimProfile = (name: string) => {
    if (!googleUser) return;
    const relinked = familyMembers.map(m =>
      m.name.toLowerCase() === name.toLowerCase() ? { ...m, userId: googleUser.id, email: googleUser.email ?? m.email } : m
    );
    setFamilyMembers(relinked);
    if (householdId) saveHouseholdData(householdId, 'members', relinked); // persist explicitly (not via the racy effect)
    setNeedsNamePrompt(false);
    setNameInput('');
  };

  // Rename a family member, cascading the change to event member tags
  const handleRenameMember = (oldName: string, rawNewName: string) => {
    const newName = rawNewName.trim();
    if (!newName || newName === oldName) return;
    if (familyMembers.some(m => m.name.toLowerCase() === newName.toLowerCase())) {
      alert(`A family member named "${newName}" already exists.`);
      return;
    }

    const rename = (arr?: string[]) => arr?.map(n => (n === oldName ? newName : n));
    const swap = (v: string) => (v === oldName ? newName : v);

    setFamilyMembers(prev => prev.map(m => (m.name === oldName ? { ...m, name: newName } : m)));
    setEvents(prev => prev.map(e => ({ ...e, members: rename(e.members) })));
    setChoresList(prev => prev.map(c => (c.assignedTo === oldName ? { ...c, assignedTo: newName } : c)));
    // Cascade to the XP ledgers (both keyed by member name) so a renamed kid keeps their
    // banked lifetime-earned AND spent-XP history — otherwise their balance would shift.
    setXpBankList(prev => prev.map(b => (b.member === oldName ? { ...b, member: newName } : b)));
    setRedemptionsList(prev => prev.map(r => (r.member === oldName ? { ...r, member: newName } : r)));
    // Cascade to calendar connections and any in-flight selections so nothing orphans.
    setConnectedCalendars(prev => prev.map(c => (c.assignedTo === oldName ? { ...c, assignedTo: newName } : c)));
    setSyncAssignee(swap);
    setActiveMemberFilter(swap);
    setNewChoreAssigned(swap);
    setCustomEventMembers(prev => rename(prev) ?? []);
  };

  // Add Google Calendar setup connection (Pull or Push assignees)
  const addGoogleCalendarConnection = (gCal: any, direction: 'pull' | 'push', assignedTo: string) => {
    const exists = connectedCalendars.some(c => c.id === gCal.id && c.direction === direction);
    if (exists) {
      alert("This calendar connectivity has already been set up!");
      return;
    }
    
    const newConn: ConnectedCalendar = {
      id: gCal.id,
      summary: gCal.summary,
      accountEmail: googleUser?.email || 'Unknown',
      direction,
      assignedTo,
      active: true
    };
    
    setConnectedCalendars(prevConns => [...prevConns, newConn]);
    
    setCalendarSyncLogs(prev => [
      ...prev,
      `Connected "${gCal.summary}" as a ${direction.toUpperCase()} calendar for ${assignedTo}.`
    ]);
  };

  // Remove calendar connection from list
  const removeGoogleCalendarConnection = (id: string, direction: 'pull' | 'push') => {
    const confirmed = window.confirm("Are you sure you want to disconnect this Google Calendar connection?");
    if (!confirmed) return;
    
    setConnectedCalendars(prevConns => prevConns.filter(c => !(c.id === id && c.direction === direction)));
    
    // If it was a pull connection, remove pulled events + drop this calendar's now-dead
    // hidden-event entries (their gcal- ids can never recur once the connection is gone).
    if (direction === 'pull') {
      setEvents(prev => prev.filter(e => !e.id.startsWith(`gcal-${id}-`)));
      setHiddenEvents(prev => prev.filter(h => !h.id.startsWith(`gcal-${id}-`)));
    }
    
    setCalendarSyncLogs(prev => [
      ...prev,
      `Removed calendar connection (${id}).`
    ]);
  };

  // Toggle calendar active status
  const toggleGoogleCalendarActive = (id: string, direction: 'pull' | 'push') => {
    setConnectedCalendars(prevConns => prevConns.map(c => {
      if (c.id === id && c.direction === direction) {
        return { ...c, active: !c.active };
      }
      return c;
    }));
  };


  // Two-way synchronization engine (Pull and Push)
  // connsOverride lets callers (e.g. first-sign-in auto-connect) sync connections
  // that haven't been committed to state yet.
  const syncGoogleCalendars = async (tokenOverride?: string, connsOverride?: ConnectedCalendar[], hiddenOverride?: HiddenEvent[], pullOnly?: boolean) => {
    const token = tokenOverride || await getGoogleToken();
    if (!token) {
      alert("Please sign in with Google first to synchronize your calendars.");
      return;
    }

    setIsFetchingCalendars(true);
    const logs: string[] = ["🔄 Initiating sync synchronization..."];
    setCalendarSyncLogs([...logs]);

    // Blocklist of synced events the user deleted — filtered out of every pull below so
    // they don't re-appear. hiddenOverride lets "restore" re-sync with the updated list
    // (state setters are async, so the closure's hiddenEvents would otherwise be stale).
    const hiddenIds = new Set<string>((hiddenOverride ?? hiddenEvents).map(h => h.id));

    // Sync window is a bounded recent band (1 month back .. 4 months forward), kept narrow on purpose:
    // it's decoupled from the much wider display window (±12 months) so Google sync load stays small.
    const now = new Date();
    const syncMonths = buildMonthWindow(6, new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const { timeMin, timeMax } = monthWindowRange(syncMonths);

    // Track which pull-calendars we refresh + the events pulled, then merge into the CURRENT events at
    // the end (functional setEvents) — never a call-time snapshot, so an event added DURING the sync isn't lost.
    const pulledConnIds = new Set<string>();
    const freshImported: CalendarEvent[] = [];
    let syncedPullCount = 0;
    let syncedPushCount = 0;
    
    try {
      for (const conn of (connsOverride ?? connectedCalendars)) {
        if (!conn.active) {
          logs.push(`Skipped "${conn.summary}" [${conn.direction.toUpperCase()}] because it is deactivated.`);
          setCalendarSyncLogs([...logs]);
          continue;
        }
        // Multi-account: connectedCalendars is SHARED household data, but a calendar is only readable/writable
        // by the account that connected it (accountEmail). Only the signed-in account's token works — so skip
        // another parent's connections (they sync them in their OWN session; the pulled events are already in
        // the shared schedule). This is the fix for "404 Not Found" when one parent's token hits the other
        // parent's calendar. Legacy connections with no accountEmail are still attempted (single-parent compat).
        if (conn.accountEmail && googleUser?.email && conn.accountEmail !== googleUser.email) {
          logs.push(`Skipped "${conn.summary}" — connected under ${conn.accountEmail} (that account syncs it).`);
          setCalendarSyncLogs([...logs]);
          continue;
        }

        // Restore (pullOnly) re-pulls to surface un-hidden events — it must NOT push
        // (that would fire export-confirm dialogs and write to Google on a restore click).
        if (pullOnly && conn.direction === 'push') continue;

        if (conn.direction === 'pull') {
          logs.push(`📥 Pulling synchronized events from Google Calendar: "${conn.summary}"...`);
          setCalendarSyncLogs([...logs]);
          
          try {
            // Fetch events across the current rolling month window
            const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(await res.text());
            const data = await res.json();
            // Skip events WE pushed (they carry our [FamilyHub-id:…] marker) — the local original already
            // exists, so re-importing it as a gcal- copy would duplicate it (esp. once the silent auto-push
            // writes to a calendar we ALSO pull, like a parent's own gmail).
            const items = (data.items || []).filter((it: any) => !isFamilyHubMarked(it.description));

            // Mark this calendar pulled — its old gcal-<id>-* events are dropped in the final merge
            // (idempotent re-pull), without touching any other events.
            pulledConnIds.add(conn.id);
            
            const imported: CalendarEvent[] = items.map((item: any) => {
              const startVal = item.start.date || (item.start.dateTime ? item.start.dateTime.slice(0, 10) : '2026-06-15');
              // Google all-day end.date is EXCLUSIVE (the day after the last day) — convert it
              // to an inclusive end so it matches manual events + the inclusive conflict/agenda
              // logic (otherwise a 1-day all-day event spans 2 days and fakes a conflict).
              let endVal: string;
              if (item.end?.date) {
                endVal = shiftDateStr(item.end.date, -1);
                if (endVal < startVal) endVal = startVal;
              } else {
                endVal = item.end?.dateTime ? item.end.dateTime.slice(0, 10) : startVal;
              }
              // Capture wall-clock HH:MM for timed (dateTime) events; all-day (date) events have none.
              // Validate the slice (defense-in-depth) so only well-formed HH:MM is ever stored.
              const rawStartTime = item.start.dateTime ? item.start.dateTime.slice(11, 16) : undefined;
              const rawEndTime = item.end?.dateTime ? item.end.dateTime.slice(11, 16) : undefined;
              const startTime = rawStartTime && parseHmToMinutes(rawStartTime) !== null ? rawStartTime : undefined;
              const endTime = rawEndTime && parseHmToMinutes(rawEndTime) !== null ? rawEndTime : undefined;
              
              // Events from a HOLIDAY calendar (e.g. Google's "Holidays in United States") are days
              // off, not commitments → category Holiday + freeBusy 'free' so they free the day for
              // planning (fixes the copilot treating "Father's Day" as a booked day). Otherwise detect
              // the category from key phrases in the title.
              const titleLower = (item.summary || '').toLowerCase();
              const isHolidayCal = /\bholidays?\b/i.test(conn.summary || '');
              let category: Category = isHolidayCal ? 'Holiday' : 'Other';
              if (!isHolidayCal) {
                if (titleLower.includes('school') || titleLower.includes('class') || titleLower.includes('exam') || titleLower.includes('report')) {
                  category = 'School';
                } else if (titleLower.includes('camp') || titleLower.includes('summer')) {
                  category = 'Camp';
                } else if (titleLower.includes('soccer') || titleLower.includes('basketball') || titleLower.includes('sports') || titleLower.includes('swim') || titleLower.includes('run')) {
                  category = 'Sports';
                } else if (titleLower.includes('art') || titleLower.includes('music') || titleLower.includes('piano') || titleLower.includes('dance') || titleLower.includes('drama')) {
                  category = 'Arts';
                } else if (titleLower.includes('holiday') || titleLower.includes('trip') || titleLower.includes('vacation') || titleLower.includes('travel')) {
                  category = 'Holiday';
                }
              }

              return {
                id: `gcal-${conn.id}-${item.id}`,
                title: item.summary || 'Google Calendar Event',
                start: startVal,
                end: endVal,
                description: item.description || `Imported from Google Calendar: "${conn.summary}" (${conn.accountEmail})`,
                location: item.location || '',
                category,
                ...(isHolidayCal ? { freeBusy: 'free' as const } : {}),
                members: [conn.assignedTo],
                startTime,
                endTime,
                recurringEventId: item.recurringEventId // set when this is an instance of a recurring series
              };
            });
            
            // Drop blocklisted (locally-deleted) events BEFORE the concat/merge so a
            // hidden event can't be re-imported (and can't be id-promoted by the merge).
            const visibleImported = filterHiddenEvents(imported, hiddenIds);
            const hiddenSkipped = imported.length - visibleImported.length;
            freshImported.push(...visibleImported);
            syncedPullCount += visibleImported.length;
            logs.push(`✅ Successfully pulled ${visibleImported.length} events from "${conn.summary}" (assigned to: ${conn.assignedTo}).${hiddenSkipped > 0 ? ` (${hiddenSkipped} hidden)` : ''}`);
            setCalendarSyncLogs([...logs]);
          } catch (err: any) {
            console.error(err);
            logs.push(`❌ Error pulling from "${conn.summary}": ${err.message || 'Unknown'}`);
            setCalendarSyncLogs([...logs]);
          }
        } else if (conn.direction === 'push') {
          logs.push(`📤 Pushing family events ➡️ Google Calendar: "${conn.summary}"...`);
          setCalendarSyncLogs([...logs]);
          
          try {
            // Family calendar: push EVERY Family-Hub-owned event (any member tag) to the connected push
            // calendar — a trip or any event created here belongs on each parent's calendar. (gcal- events
            // were pulled FROM Google; pushing them back would echo them to their source.)
            const localEventsToPush = pushableLocalEvents(events);

            if (localEventsToPush.length === 0) {
              logs.push(`ℹ️ No Family-Hub events to push to "${conn.summary}".`);
              setCalendarSyncLogs([...logs]);
              continue;
            }
            
            // Confirm mutate operation as required by system guidelines!
            const proceed = window.confirm(`This will export/synchronize ${localEventsToPush.length} ${APP_NAME} events to your Google Calendar details for "${conn.summary}". Proceed?`);
            if (!proceed) {
              logs.push(`⚠️ Terminated pushing sequence for "${conn.summary}" due to user cancellation.`);
              setCalendarSyncLogs([...logs]);
              continue;
            }
            
            // Fetch current google events to avoid duplications
            const resG = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.id)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`, {
              headers: { Authorization: `Bearer ${token}` }
            });
            const existingGItems = resG.ok ? (await resG.json()).items || [] : [];
            
            for (const ev of localEventsToPush) {
              const marker = googleEventMarker(ev);
              const existingG = findGoogleEventByMarker(existingGItems, marker);
              const gBody = buildGoogleEventBody(ev); // shared with the manual per-event push

              if (existingG) {
                // Update
                const updateRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.id)}/events/${encodeURIComponent(existingG.id)}`, {
                  method: 'PUT',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(gBody)
                });
                if (updateRes.ok) syncedPushCount++;
              } else {
                // Insert
                const insertRes = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(conn.id)}/events`, {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(gBody)
                });
                if (insertRes.ok) syncedPushCount++;
              }
            }
            
            logs.push(`✅ Successfully pushed/synchronized ${localEventsToPush.length} events to "${conn.summary}".`);
            setCalendarSyncLogs([...logs]);
          } catch (err: any) {
            console.error(err);
            logs.push(`❌ Error pushing to "${conn.summary}": ${err.message || 'Unknown'}`);
            setCalendarSyncLogs([...logs]);
          }
        }
      }
      
      // Correctness: merge the pull into the CURRENT events (functional updater) so a concurrent add
      // during the sync isn't clobbered by a stale snapshot.
      setEvents(prev => applySyncedPull(prev, [...pulledConnIds], freshImported));
      // Cosmetic merge-count for the log (best-effort, from the call-time snapshot).
      const snapKept = events.filter(e => ![...pulledConnIds].some(cid => e.id.startsWith(`gcal-${cid}-`)));
      const mergedDiff = (snapKept.length + freshImported.length) - mergeDeduplicateEvents([...snapKept, ...freshImported]).length;

      logs.push(`🎉 Synchronization completed! Total pulled: ${syncedPullCount} events, Total pushed/updated: ${syncedPushCount} events.`);
      if (mergedDiff > 0) {
        logs.push(`✨ Successfully merged & deduplicated ${mergedDiff} overlapping events across synced family feed accounts.`);
      }
      setCalendarSyncLogs([...logs]);
    } catch (err: any) {
      console.error(err);
      logs.push(`❌ Critical error during synchronization: ${err.message || 'Unknown'}`);
      setCalendarSyncLogs([...logs]);
    } finally {
      setIsFetchingCalendars(false);
    }
  };

  // ── Manual single-event Google push (GE) ─────────────────────────────────────
  // Owner's decision: pushing app events to Google is MANUAL, not automatic. The user opens an
  // event, taps "Push to Google", and picks which of their writable Google calendars receive it.
  // Reuses the SAME marker + body builder as the bulk "Sync Now" push, so a re-push UPDATES the
  // existing Google event (found by marker) instead of inserting a duplicate.
  const [googlePushEvent, setGooglePushEvent] = useState<CalendarEvent | null>(null);
  const [isPushingEvent, setIsPushingEvent] = useState(false);
  const openGooglePush = (ev: CalendarEvent) => setGooglePushEvent(ev);
  const closeGooglePush = () => { if (!isPushingEvent) setGooglePushEvent(null); };

  const pushEventToGoogleCalendars = async (ev: CalendarEvent, calendarIds: string[]): Promise<string> => {
    if (!ev || !calendarIds.length) return 'Pick at least one calendar.';
    setIsPushingEvent(true);
    const logs = [...calendarSyncLogs];
    let ok = 0, fail = 0;
    try {
      const token = await getGoogleToken();
      if (!token) {
        const msg = '❌ Not signed in to Google — reconnect to push.';
        setCalendarSyncLogs([...logs, msg]);
        return msg;
      }
      const marker = googleEventMarker(ev);
      const gBody = buildGoogleEventBody(ev);
      // Search window around the event's day(s) so an already-pushed copy can be found by marker
      // (mirrors the bulk sync's find-or-insert, scoped tight to this one event).
      const timeMin = `${shiftDateStr(ev.start, -2)}T00:00:00Z`;
      const timeMax = `${shiftDateStr(ev.end || ev.start, 2)}T23:59:59Z`;
      for (const calId of calendarIds) {
        const calLabel = googleCalendarsList.find(c => c.id === calId)?.summary || calId;
        try {
          const resG = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const existingItems = resG.ok ? (await resG.json()).items || [] : [];
          const existingG = findGoogleEventByMarker(existingItems, marker);
          const res = existingG
            ? await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events/${encodeURIComponent(existingG.id)}`, {
                method: 'PUT',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(gBody),
              })
            : await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(gBody),
              });
          if (res.ok) { ok++; logs.push(`✅ Pushed "${ev.title}" ➡️ "${calLabel}"${existingG ? ' (updated)' : ''}.`); }
          else { fail++; logs.push(`❌ Failed to push "${ev.title}" to "${calLabel}" (${res.status}).`); }
        } catch (err: any) {
          fail++;
          logs.push(`❌ Error pushing to "${calLabel}": ${err.message || 'Unknown'}`);
        }
        setCalendarSyncLogs([...logs]);
      }
      return summarizePushResult(ok, fail);
    } finally {
      setIsPushingEvent(false);
    }
  };

  // Silent auto-push ("to all users"): when the app is open and the signed-in parent has a connected PUSH
  // rule, push this household's Family-Hub events to THEIR own Google calendar — so an approved/created trip
  // reaches every parent's calendar without a manual Sync. Each device pushes its OWN account only (token
  // scoping). Idempotent via the dedupe marker, windowed, and tracked in a per-account set so each event
  // pushes once (no per-load API spam); edits still go through manual Sync. A connected Push rule is the opt-in.
  const autoPushInFlightRef = useRef(false);
  useEffect(() => {
    const email = googleUser?.email;
    if (!email || autoPushInFlightRef.current) return;
    const targets = selectPushTargets(connectedCalendars, googleCalendarsList, email);
    if (!targets.length) return;
    const key = `famplan_autopushed_${email}`;
    let pushed: string[] = [];
    try { pushed = JSON.parse(localStorage.getItem(key) || '[]'); } catch { pushed = []; }
    const now = new Date();
    const fromDate = toLocalDateStr(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const toDate = toLocalDateStr(new Date(now.getFullYear(), now.getMonth() + 5, 0));
    const toPush = selectAutoPushEvents(events, pushed, fromDate, toDate);
    if (!toPush.length) return;
    autoPushInFlightRef.current = true;
    (async () => {
      try {
        const token = await getGoogleToken();
        if (!token) return; // no live token → skip silently; retries on the next change/open
        const done = new Set(pushed);
        for (const ev of toPush) {
          try { await pushEventToGoogleCalendars(ev, targets); done.add(ev.id); } catch { /* push logs its own errors */ }
        }
        try { localStorage.setItem(key, JSON.stringify([...done].slice(-1000))); } catch { /* non-fatal */ }
      } finally {
        autoPushInFlightRef.current = false;
      }
    })();
  }, [googleUser?.email, connectedCalendars, googleCalendarsList, events]);

  // Auto-PULL on sign-in (W8, owner ask): the family's Google events appear without a manual Sync click.
  // ONCE per session (ref-guarded like autoPushInFlightRef above), PULL-only (never pushes, never opens
  // export confirms), cloud mode only, and only when this account has an active pull rule — all decided
  // by shouldAutoPull (pure, tested). Token is fetched first and a missing one skips SILENTLY (no alert
  // from inside syncGoogleCalendars) — the manual Sync button stays the recovery path.
  const autoPullDoneRef = useRef(false);
  useEffect(() => {
    if (!shouldAutoPull({ backendMode: appMode, email: googleUser?.email, alreadyRan: autoPullDoneRef.current, connected: connectedCalendars })) return;
    autoPullDoneRef.current = true; // one attempt per session, even if the token below turns out missing
    (async () => {
      const token = await getGoogleToken();
      if (!token) return;
      await syncGoogleCalendars(token, undefined, undefined, true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appMode, googleUser?.email, connectedCalendars]);

  // Handle addition of Custom Source Url via server-side scraper API
  const handleAddSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl) return;

    setIsParsing(true);
    setErrorStatus(null);
    setParserStep('Connecting to server...');

    const calculatedName = newSourceName || newUrl.replace(/https?:\/\/(www\.)?/, '').substring(0, 24) + '...';

    try {
      setParserStep('Retrieving web contents & running Gemini AI parsing...');
      const res = await apiFetch('/api/parse-calendar', {
        method: 'POST',
        body: JSON.stringify({
          url: newUrl,
          category: newUrlCategory
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(
          res.status, errData,
          `Parse request failed with code ${res.status}`,
          'Or add the event manually, or paste the page text into the "Paste Text" tab.',
        ));
      }

      const data = await res.json();
      const fetchedEvents: CalendarEvent[] = data.events || [];

      if (fetchedEvents.length === 0) {
        throw new Error('Gemini parsed the page, but found no calendar dates for this category. Please check URL.');
      }

      // Align with selected syncAssignee and tag with the source id for precise deletion
      const sourceId = 'src-' + uuid();
      const processedEvents = fetchedEvents.map(evt => ({
        ...evt,
        members: [syncAssignee],
        sourceId
      }));

      // Append directly (like manual add / the agentic path) — NOT through
      // mergeDeduplicateEvents, whose title+date key would (a) merge two kids' same-title
      // same-day events (data loss) and (b) drop the incoming sourceId on a collision,
      // breaking the per-source "undo import" (handleDeleteSource filters by sourceId).
      setEvents(prev => [...processedEvents, ...prev]);

      // Insert new source entry
      const sourceEntry: WebSource = {
        id: sourceId,
        name: calculatedName,
        url: newUrl,
        category: newUrlCategory,
        lastSync: 'Sync success today',
        status: 'active',
        eventCount: processedEvents.length
      };

      setSources(prev => [sourceEntry, ...prev]);
      setNewUrl('');
      setNewSourceName('');
      setParserStep('');
      
      // Push Copilot Notification
      setCopilotMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: `✨ **Excellent news!** I scanned the URL: "${calculatedName}" and integrated **${processedEvents.length} upcoming events** directly to your summer plans. Select the category filters to look closely at them.`
        }
      ]);

    } catch (err: any) {
      console.error(err);
      setErrorStatus(err.message || 'Could not import from that URL. Check the link — or, fastest, copy the events text from the page and paste it into the "Paste Text" tab. You can also save the page as a PDF and use the PDF import tab.');
    } finally {
      setIsParsing(false);
    }
  };

  // Add customized manual activity via cell editor
  // Delete event action. Synced (gcal-) events return on the next pull unless we
  // remember they were hidden, so they go on the hiddenEvents blocklist (filtered out
  // at pull time) instead of just being removed. Local events are simply removed.
  const handleDeleteEvent = (id: string) => {
    if (id.startsWith('gcal-')) {
      const ev = events.find(e => e.id === id);
      setHiddenEvents(prev => prev.some(h => h.id === id)
        ? prev
        : [...prev, { id, title: ev?.title || 'Event', start: ev?.start || '' }]);
      setCalendarSyncLogs(prev => [
        ...prev,
        `🙈 Hid "${ev?.title || 'event'}" from sync. Restore it under Sync Sources → Google Cal → Hidden events.`,
      ]);
    }
    setEvents(prev => prev.filter(e => e.id !== id));
    if (selectedEventDetail?.id === id) {
      setSelectedEventDetail(null);
    }
  };

  // Bulk-delete every instance of a detected recurring series. Synced (gcal-) instances
  // are added to the hiddenEvents blocklist so the series doesn't return on the next pull
  // (this is the fix for the "recurring series reappears every sync" behavior); local
  // instances are just removed.
  const handleDeleteRecurringGroup = (group: RecurringGroup) => {
    if (!window.confirm(
      `Delete all ${group.instanceCount} instances of "${group.title}" from ${group.member}'s calendar?`
    )) return;
    const ids = new Set(group.eventIds);
    const gcalIds = group.eventIds.filter(eid => eid.startsWith('gcal-'));
    if (gcalIds.length) {
      const evMap: Map<string, CalendarEvent> = new Map(events.map((e): [string, CalendarEvent] => [e.id, e]));
      setHiddenEvents(prev => {
        const seen = new Set(prev.map(h => h.id));
        const additions: HiddenEvent[] = gcalIds
          .filter(eid => !seen.has(eid))
          .map(eid => ({ id: eid, title: group.title, start: evMap.get(eid)?.start || '' }));
        return additions.length ? [...prev, ...additions] : prev;
      });
      setCalendarSyncLogs(prev => [
        ...prev,
        `🙈 Hid recurring series "${group.title}" (${gcalIds.length}) from sync. Restore under Sync Sources → Google Cal → Hidden events.`,
      ]);
    }
    setEvents(prev => prev.filter(e => !ids.has(e.id)));
    if (selectedEventDetail && ids.has(selectedEventDetail.id)) {
      setSelectedEventDetail(null);
    }
  };

  // Restore a previously-hidden synced event (or all of them) and re-pull so they
  // reappear immediately. Pass the updated blocklist as an override because the state
  // setter is async — the sync closure would otherwise still see the old hiddenEvents.
  const restoreHiddenEvent = (id: string) => {
    const next = hiddenEvents.filter(h => h.id !== id);
    setHiddenEvents(next);
    syncGoogleCalendars(undefined, undefined, next, true); // pull-only — don't push on restore
  };
  const restoreAllHiddenEvents = () => {
    if (!hiddenEvents.length) return;
    setHiddenEvents([]);
    syncGoogleCalendars(undefined, undefined, [], true); // pull-only — don't push on restore
  };

  // ── Pantry + AI shopping (recipe→list, pantry→restock) ───────────────────────
  const VALID_STORES = storeList as readonly ShoppingItem['store'][];

  // (appendShoppingItems + pantry/recipe/restock handlers now live in useShopping; exposed via the
  // `shopping` hook above. appendShoppingItems is destructured for the copilot/quick-add path below.)

  // ── Natural-language quick-add + agentic copilot actions ─────────────────────
  // The validation/build logic lives in utils/aiActions.ts (pure + unit-tested); these
  // handlers are thin glue that call a builder then the relevant state setter.
  const addEventFromPayload = (p: any, idPrefix: string): boolean => {
    const built = buildEventFromPayload(p, idPrefix, familyMembers, toLocalDateStr(new Date()));
    if (!built) return false;
    const newEvt = { ...built, ...authorStamp() }; // stamp authorship (who/when)
    // Append directly (like manual add) — NOT through mergeDeduplicateEvents, whose
    // title+date key would merge two people's same-title/same-day events (data loss).
    setEvents(prev => [newEvt, ...prev]);
    return true;
  };
  // Expand multi-kid intent ("both kids" → one chore per kid) and skip any chore identical to one
  // already on the board (title + assignee + cadence + slot) — chores don't dedupe on add the way
  // events do, so a repeated quick-add used to stack duplicates. Deduping against the closure
  // `choresList` (this render's value) keeps it deterministic; returns the chores actually added
  // plus a duplicate count so the caller can report both.
  const addChoresFromPayload = (p: any): { added: Chore[]; duplicates: number } => {
    const stamp = authorStamp();
    const candidates = buildChoresFromPayload(p, familyMembers).map(c => ({ ...c, ...stamp }));
    if (!candidates.length) return { added: [], duplicates: 0 };
    const seen = new Set(choresList.map(choreDedupeKey));
    const added: Chore[] = [];
    let duplicates = 0;
    for (const c of candidates) {
      const key = choreDedupeKey(c);
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key); // guard intra-batch dups too
      added.push(c);
    }
    if (added.length) setChoresList(prev => [...prev, ...added]);
    return { added, duplicates };
  };

  // Dispatch a quick-add classification result to the right existing handler.
  const dispatchQuickAddResult = (result: any): string => {
    const kind = result?.kind;
    if (kind === 'event') {
      if (!addEventFromPayload(result.event, 'qa')) throw new Error("Couldn't read that event — try rephrasing.");
      return `✓ Added event "${result.event.title}"`;
    }
    if (kind === 'shopping') {
      const n = appendShoppingItems((result.items || []).slice(0, 25)); // cap, like copilot
      if (!n) throw new Error('No shopping items found in that note.');
      return `✓ Added ${n} shopping item${n > 1 ? 's' : ''}`;
    }
    if (kind === 'chore') {
      const title = result?.chore?.title;
      const { added, duplicates } = addChoresFromPayload(result.chore);
      if (!added.length && !duplicates) throw new Error("Couldn't read that chore — try rephrasing.");
      if (!added.length) return `↺ "${title}" is already on the chore board — nothing to add.`;
      const who = added.map(c => c.assignedTo).join(', ');
      const dupNote = duplicates ? ` (${duplicates} already existed)` : '';
      return `✓ Added chore "${title}" for ${who}${dupNote}`;
    }
    throw new Error("Couldn't classify that — try rephrasing.");
  };

  const handleQuickAdd = async () => {
    const text = quickAddText.trim();
    if (!text) return;
    setIsQuickAdding(true);
    setQuickAddMsg(null);
    try {
      const res = await apiFetch('/api/parse-quickadd', {
        method: 'POST',
        body: JSON.stringify({ text, members: familyMembers.map(m => m.name), stores: VALID_STORES }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(
          res.status, body,
          'Quick-add failed.',
          'Add it manually for now.',
        ));
      }
      const data = await res.json();
      const summary = dispatchQuickAddResult(data.result || {});
      setQuickAddMsg({ ok: true, text: summary });
      // Persist the quick-add prompt (raw text + classified kind + outcome) for audit/RL. The author
      // stamp records WHO typed it; rolling-capped. Captured before clearing the input field.
      const qaLogEntry = buildQuickAddLogEntry('qalog-' + uuid(), text, data.result?.kind, summary, authorStamp());
      setQuickAddLog(prev => appendCapped(prev, qaLogEntry, LOG_CAP));
      setQuickAddText('');
    } catch (err: any) {
      setQuickAddMsg({ ok: false, text: err.message || 'Quick-add failed.' });
    } finally {
      setIsQuickAdding(false);
    }
  };

  // Apply copilot-proposed actions. CREATE actions auto-apply via the existing mutators
  // (validated + clamped). UPDATE actions (which MUTATE an existing event) are NOT applied here —
  // they're staged as a confirm-tier 'pending' ledger entry, reviewed in the Approvals queue
  // (CopilotBar). Unknown/malformed actions are ignored. Returns a summary or ''.
  const applyCopilotActions = (actions: any[]): string => {
    if (!Array.isArray(actions) || !actions.length) return '';
    let nEvents = 0, nShop = 0;
    // Cumulative shopping-item budget across ALL add_shopping_item actions in this response, so many
    // small actions can't bypass the per-action cap (25 actions × 25 items would be 625 otherwise).
    let shopBudget = 25;
    // Working copies so multiple actions in ONE response COMPOSE (vs each call re-reading the stale
    // render-closure): a later update_event can resolve an event created earlier in the same batch,
    // and chores dedupe ACROSS actions, not just within one payload.
    const today = toLocalDateStr(new Date());
    const stamp = authorStamp(); // who/when — applied to every record this copilot response creates
    let workingEvents = events;
    const newEvents: CalendarEvent[] = [];
    const choreSeen = new Set(choresList.map(choreDedupeKey));
    const newChores: Chore[] = [];
    // Concierge ledger entries for this response (audit). Auto actions → 'applied'; update_event
    // (confirm tier) → 'pending'. Behavior-preserving: this records, it does not change what applies.
    // A1: this switch is the CANONICAL apply/validate path — it calls the aiActions builders
    // directly. TOOL_REGISTRY.validate is declared for A2 (when dispatch collapses into the table)
    // and for the allowlist/parity test; it is NOT yet load-bearing here. The registry is consulted
    // only for an action's risk tier, and tier() fails CLOSED (unknown → most-restrictive 'confirm')
    // so a future high-risk tool can never be mislabeled 'auto' in the audit trail.
    const ledger: LedgerEntry[] = [];
    const docMoves = new Map<string, string>(); // docId → target folder (auto-applied after the loop)
    let docDeleteMisses = 0; // delete_document calls that matched no doc/folder → tell the user (capstone #7)
    const tier = (type: string): LedgerEntry['riskTier'] => TOOL_REGISTRY[type]?.riskTier ?? 'confirm';
    // Cap per-response actions so a prompt-injected input can't mass-create items.
    for (const a of actions.slice(0, 25)) {
      const p = a?.payload || {};
      switch (a?.type) {
        case 'create_event': {
          const built = buildEventFromPayload(p, 'cop', familyMembers, today);
          if (built) {
            const ev = { ...built, ...stamp }; newEvents.unshift(ev); workingEvents = [ev, ...workingEvents]; nEvents++;
            ledger.push(buildLedgerEntry('ledg-' + uuid(), 'create_event', tier('create_event'), 'applied', { summary: `Added "${ev.title}" on ${ev.start}`, refId: ev.id }, stamp));
          }
          break;
        }
        case 'update_event': {
          // Stage (don't apply) — resolved against current + batch-created events; null if no match / no-op.
          const u = buildEventUpdateFromPayload(p, workingEvents, familyMembers);
          // update_event (confirm tier) stages a LINKED 'pending' ledger entry. The Approvals queue
          // (CopilotBar) acts on it, and approve/reject transitions the entry's status — no stranded rows.
          if (u) {
            const actionId = 'upd-' + uuid();
            // Store only the CHANGED-KEY subset of `before` (+ title for the heading), not the whole
            // event — enough for the before→after preview without duplicating the event's PII.
            const beforeSubset: Partial<CalendarEvent> = { title: u.before.title };
            for (const k of Object.keys(u.changes) as (keyof CalendarEvent)[]) (beforeSubset as any)[k] = (u.before as any)[k];
            ledger.push(buildLedgerEntry(actionId, 'update_event', tier('update_event'), 'pending', { summary: `Update "${u.before.title}"`, refId: u.id, before: beforeSubset, changes: u.changes }, stamp));
          }
          break;
        }
        case 'add_chore':
          // Inline the expansion + dedupe so two add_chore actions for the same chore in one
          // response can't both slip past (the per-call closure dedupe couldn't see each other).
          for (const c of buildChoresFromPayload(p, familyMembers)) {
            const key = choreDedupeKey(c);
            if (choreSeen.has(key)) continue;
            choreSeen.add(key);
            const chore = { ...c, ...stamp };
            newChores.push(chore);
            ledger.push(buildLedgerEntry('ledg-' + uuid(), 'add_chore', tier('add_chore'), 'applied', { summary: `Added chore "${chore.title}" for ${chore.assignedTo}`, refId: chore.id }, stamp));
          }
          break;
        case 'add_shopping_item': {
          // Clamp to the REMAINING cumulative budget, so neither one action nor many can mass-create.
          if (shopBudget <= 0) break;
          const items = (Array.isArray(p.items) ? p.items : [{ text: p.text, store: p.store }]).slice(0, shopBudget);
          const added = appendShoppingItems(items);
          shopBudget -= added;
          nShop += added;
          if (added) ledger.push(buildLedgerEntry('ledg-' + uuid(), 'add_shopping_item', tier('add_shopping_item'), 'applied', { summary: `Added ${added} shopping item${added > 1 ? 's' : ''}` }, stamp));
          break;
        }
        case 'reserve': {
          // Confirm-tier DRAFT (no money moves): stage a booking deep-link the parent opens to book. Carry the
          // booking stub so approving it also lands the booking on the calendar (A3 last-mile).
          const r = buildReservationDraft(p);
          if (r) ledger.push(buildLedgerEntry('ledg-' + uuid(), 'reserve', tier('reserve'), 'pending', { summary: r.summary, link: r.link, ...(r.booking ? { payload: { booking: r.booking } } : {}) }, stamp));
          break;
        }
        case 'add_to_cart': {
          // Confirm-tier DRAFT (B4): a prefilled Amazon cart/search link — checkout happens in the app.
          const c = buildCartDraft(p);
          if (c) ledger.push(buildLedgerEntry('ledg-' + uuid(), 'add_to_cart', tier('add_to_cart'), 'pending', { summary: c.summary, link: c.link }, stamp));
          break;
        }
        case 'move_document': {
          // Auto-tier (reversible): recategorize a Library doc into another folder, resolved by id or name.
          const doc = resolveDoc(libraryDocs, { id: p.id, name: p.name });
          if (doc) {
            const folder = normalizeFolder(p.folder);
            docMoves.set(doc.id, folder);
            ledger.push(buildLedgerEntry('ledg-' + uuid(), 'move_document', tier('move_document'), 'applied', { summary: `Moved "${doc.name}" → ${folder}`, refId: doc.id }, stamp));
          }
          break;
        }
        case 'delete_document': {
          // Confirm-tier (destructive): stage a "Delete X?" row in Approvals; the doc(s) removed on approve.
          // A folder-clear ("delete everything in Newsletters") stages the WHOLE folder as ONE row so the
          // action cap can't truncate it (capstone #7). A single delete uses fuzzy=false (exact id/name only).
          if (p.folder && !p.name && !p.id) {
            const fold = normalizeFolder(p.folder);
            const inFolder = libraryDocs.filter(d => normalizeFolder(d.folder) === fold);
            if (inFolder.length) ledger.push(buildLedgerEntry('ledg-' + uuid(), 'delete_document', tier('delete_document'), 'pending', { summary: `Delete all ${inFolder.length} docs in "${fold}"`, refIds: inFolder.map(d => d.id) }, stamp));
            else docDeleteMisses++;
            break;
          }
          const doc = resolveDoc(libraryDocs, { id: p.id, name: p.name }, false);
          if (doc) ledger.push(buildLedgerEntry('ledg-' + uuid(), 'delete_document', tier('delete_document'), 'pending', { summary: `Delete "${doc.name}"`, refId: doc.id }, stamp));
          else docDeleteMisses++;
          break;
        }
        default: break; // unknown/destructive types ignored
      }
    }
    const nChores = newChores.length;
    if (newEvents.length) setEvents(prev => [...newEvents, ...prev]);
    if (newChores.length) setChoresList(prev => [...prev, ...newChores]);
    if (docMoves.size) setLibraryDocs(prev => prev.map(d => (docMoves.has(d.id) ? { ...d, folder: docMoves.get(d.id)! } : d)));
    if (ledger.length) setActionLedger(prev => [...prev, ...ledger].slice(-LEDGER_CAP));
    const parts: string[] = [];
    if (nEvents) parts.push(`${nEvents} event${nEvents > 1 ? 's' : ''}`);
    if (nChores) parts.push(`${nChores} chore${nChores > 1 ? 's' : ''}`);
    if (nShop) parts.push(`${nShop} shopping item${nShop > 1 ? 's' : ''}`);
    if (docMoves.size) parts.push(`moved ${docMoves.size} doc${docMoves.size > 1 ? 's' : ''}`);
    let summary = parts.length ? `✓ Applied: ${parts.join(', ')}.` : '';
    const nUpdates = ledger.filter(e => e.status === 'pending' && e.tool === 'update_event').length;
    if (nUpdates) {
      const note = `📝 ${nUpdates} suggested change${nUpdates > 1 ? 's' : ''} to existing event${nUpdates > 1 ? 's' : ''} — review & confirm in Approvals.`;
      summary = summary ? `${summary}\n${note}` : note;
    }
    const nDrafts = ledger.filter(e => e.status === 'pending' && (e.tool === 'reserve' || e.tool === 'add_to_cart')).length;
    if (nDrafts) {
      const note = `🛎️ ${nDrafts} draft${nDrafts > 1 ? 's' : ''} staged in Approvals — review & confirm (tap Approvals above).`;
      summary = summary ? `${summary}\n${note}` : note;
    }
    if (docDeleteMisses) {
      const note = `⚠️ Couldn't find that document to delete — check the exact name in the Docs Library.`;
      summary = summary ? `${summary}\n${note}` : note;
    }
    return summary;
  };

  // Confirm-before-apply for copilot event edits: commit the staged change, or discard it.
  // Resolve a staged update_event whose id is ALSO its 'pending' ledger entry id. On approve, merge
  // the change into the target event; either way remove the pending row AND transition the linked
  // ledger entry (approved/rejected) so the audit trail never strands a 'pending'. Both the inline
  // Transition a resolved ledger row to approved/rejected, stamping who/when on approve. `blocked`
  // (delete_event's ambiguous-title guard) forces a reject even when the user approved. Collapses the
  // ~7 copy-pasted status maps in resolveLedgerUpdate into one (behavior-preserving).
  const markLedger = (entryId: string, approve: boolean, s0: ReturnType<typeof authorStamp>, blocked = false) => {
    const ok = approve && !blocked;
    setActionLedger(prev => prev.map(le => (le.id === entryId
      ? { ...le, status: ok ? 'approved' : 'rejected', resolvedAt: s0.createdAt, ...(ok ? { resolvedByUserId: s0.createdByUserId } : {}) }
      : le)));
  };
  // The Approvals queue (CopilotBar) calls these to resolve a staged confirm-tier entry.
  const resolveLedgerUpdate = (id: string, approve: boolean, stepUpVerified = false) => {
    // The LEDGER entry (persisted) is the durable source of the staged change, so approval works after a
    // reload or on another device.
    const entry = actionLedger.find(le => le.id === id && le.status === 'pending');
    if (!entry) return;
    // Defense-in-depth (A3): a stepup-tier entry can only be APPROVED with a verified step-up PIN.
    // The UI gates this (CopilotBar), but enforce it at the logic layer so no future caller bypasses it.
    if (approve && entry.riskTier === 'stepup' && !stepUpVerified) {
      setCopilotMessages(prev => [...prev, { role: 'assistant', text: '🔒 That action needs your security PIN — approve it from the copilot bar.' }]);
      return;
    }
    // Tool-specific appliers live in the REGISTRY (src/utils/ledgerAppliers.ts) — one testable applier
    // per approvable tool, dispatched with the live collections + injected effects. Registry tools
    // resolve fully in their applier (including deliberate keep-pending retries) and never reach the
    // goal-resume hook below (behavior identical to the former inline early-return blocks).
    const applier = LEDGER_APPLIERS[entry.tool];
    if (applier) {
      applier({
        entry, approve,
        events, choresList, shoppingList,
        connectedCalendars, googleCalendarsList, googleUserEmail: googleUser?.email,
        markLedger: (entryId, ok, blocked = false) => markLedger(entryId, ok, authorStamp(), blocked),
        say: (text) => setCopilotMessages(prev => [...prev, { role: 'assistant', text }]),
        setEvents, setChoresList, setShoppingList, setLibraryDocs,
        appendShoppingItems, pushEventToGoogleCalendars, krogerCartAdd,
      });
      return;
    }
    const res = resolveLedgerEntry(entry, events, approve);
    if (res.applied && res.refId) {
      const changes = res.changes as Partial<CalendarEvent>;
      setEvents(prev => prev.map(e => (e.id === res.refId ? { ...e, ...changes } : e)));
    }
    const s = authorStamp();
    setActionLedger(prev => prev.map(le => (le.id === id
      ? { ...le, status: res.status, resolvedAt: s.createdAt, ...(res.applied ? { resolvedByUserId: s.createdByUserId } : {}) }
      : le)));
    // Only an update_event has a target event to merge — so only it can "no longer exist". A draft
    // (reserve / add_to_cart: link, no refId/changes) resolves to approved-but-not-applied; approving it
    // just acknowledges (the parent opens the link). Gating the messages by tool fixes the phantom
    // "Couldn't update 'the event'" that fired when a reservation/cart draft was approved.
    if (entry.tool === 'update_event') {
      const title = (entry.before as { title?: string } | undefined)?.title || 'the event';
      if (res.applied) setCopilotMessages(prev => [...prev, { role: 'assistant', text: `✓ Updated "${title}".` }]);
      else if (approve) setCopilotMessages(prev => [...prev, { role: 'assistant', text: `⚠️ Couldn't update "${title}" — it no longer exists.` }]);
    } else if (approve) {
      // A reservation/handoff draft carrying a booking stub (venue + date/time) → ALSO put the booking on the
      // calendar so it's visible (A3 last-mile), then offer to push it to Google. Best-effort: only when a real
      // date parsed; otherwise just acknowledge the link.
      const booking = (entry.payload as { booking?: { title: string; start: string; startTime?: string } } | undefined)?.booking;
      const built = booking?.start
        ? buildEventFromPayload({ title: booking.title, start: booking.start, startTime: booking.startTime, category: 'Other' }, 'cop', familyMembers, toLocalDateStr(new Date()))
        : null;
      if (built) {
        const ev = { ...built, ...authorStamp() } as CalendarEvent;
        setEvents(prev => [ev, ...prev]);
        // Only offer the Google-push follow-up when a Google calendar is actually connected — otherwise
        // (anonymous demo, or no sync set up) the chained draft is a dead-end that can never be approved.
        if (connectedCalendars.length) {
          stagePushToGoogle([ev]);
          setCopilotMessages(prev => [...prev, { role: 'assistant', text: `🗓️ Added "${ev.title}" to your calendar. (Approve the Google-push draft to add it there too.)` }]);
        } else {
          setCopilotMessages(prev => [...prev, { role: 'assistant', text: `🗓️ Added "${ev.title}" to your calendar.` }]);
        }
      } else {
        setCopilotMessages(prev => [...prev, { role: 'assistant', text: `✓ Marked done.` }]);
      }
    }
    // Resume the goal loop: approving a goal-tied draft (the external step) advances its plan.
    if (approve && entry.goalId) advanceGoalOnApproval(entry.goalId, entry.id);
  };
  const approveLedgerEntry = (id: string, stepUpVerified = false) => resolveLedgerUpdate(id, true, stepUpVerified);
  const rejectLedgerEntry = (id: string) => resolveLedgerUpdate(id, false);
  // Stage pre-built pending entries into the Approvals queue (the morning planner's on-demand path:
  // BriefingCard builds them client-side under the visitor's own identity). Append-only + capped.
  const stageLedgerEntries = (entries: LedgerEntry[]) => {
    if (!entries.length) return;
    setActionLedger(prev => [...prev, ...entries].slice(-LEDGER_CAP));
  };

  // HITL "Modify" (#4): steer a pending draft in plain language instead of rejecting it. Re-prompt the model
  // via /api/revise-draft, shape/sanitize the result, and restage the SAME entry IN PLACE (still pending →
  // a final Approve still required). Stays a draft, so the no-payment invariant holds.
  const reviseLedgerEntry = async (id: string, feedback: string): Promise<{ ok: boolean; error?: string }> => {
    const entry = actionLedger.find(le => le.id === id && le.status === 'pending');
    if (!entry || !feedback.trim()) return { ok: false, error: 'Nothing to revise.' };
    try {
      const res = await apiFetch('/api/revise-draft', {
        method: 'POST',
        body: JSON.stringify({ tool: entry.tool, summary: entry.summary, before: entry.before, changes: entry.changes, payload: entry.payload, link: entry.link, feedback: feedback.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        return { ok: false, error: aiErrorMessage(res.status, body, 'Could not revise that draft.', 'Try rephrasing your change.') };
      }
      const { revised: raw } = await res.json();
      const revised = shapeRevisedDraft(entry.tool, raw, { summary: entry.summary });
      // Modify on a DELETE draft (#3). The only safe reinterpretation is "keep the event, mark it free/busy
      // instead of deleting it" — the one intentional, safety-DECREASING tool switch (delete → update). Anything
      // else must NOT silently relabel a deletion (the "make it free but it deleted anyway" trap).
      if (entry.tool === 'delete_event') {
        const fb = (revised.changes as { freeBusy?: string } | undefined)?.freeBusy;
        if (fb === 'free' || fb === 'busy') {
          const pay = (entry.payload || {}) as { title?: string; start?: string };
          const { victims } = resolveEventDeletion(events, { refId: entry.refId, title: pay.title, start: pay.start });
          const target = victims[0];
          if (!target) return { ok: false, error: "I couldn't find that event to keep — it may already be gone." };
          setActionLedger(prev => prev.map(le => (le.id === id ? {
            ...le,
            tool: 'update_event',
            summary: `Mark "${target.title}" ${fb}`,
            refId: target.id,
            before: { title: target.title, freeBusy: target.freeBusy },
            changes: { freeBusy: fb },
            payload: undefined,
          } : le)));
          return { ok: true };
        }
        return { ok: false, error: 'Modify can only adjust an action, not turn a deletion into something else. To KEEP this event, Dismiss the deletion — or ask me to "mark it free" and I\'ll change it to a free/busy update instead.' };
      }
      setActionLedger(prev => prev.map(le => (le.id === id ? {
        ...le,
        summary: revised.summary,
        ...(revised.changes ? { changes: { ...(le.changes as object || {}), ...revised.changes } } : {}),
        ...(revised.link ? { link: revised.link } : {}),
        ...(revised.text && le.payload ? { payload: { ...(le.payload as object), text: revised.text } } : {}),
      } : le)));
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Revision failed.' };
    }
  };
  // ── Step-up PIN (gates 'stepup'-tier concierge actions; A3) ──────────────────
  // The raw PIN never lives in app state: the server hashes it; we persist only {hash,salt} in the
  // household settings blob, and verify by sending a candidate PIN to the server.
  const hasStepUpPin = !!settings[0]?.stepUpPinHash && !!settings[0]?.stepUpPinSalt;
  // The family's name for the copilot (kid-pickable; synced household setting). Clamped on save; every
  // engine sees it — the bar label + goals strip read it here, the quick path gets it via `home: settings[0]`,
  // and agent turns carry it in the turn context (api.py injects it into the grounded prompt).
  const copilotName = (settings[0]?.copilotName || '').trim() || 'Copilot';
  const setCopilotName = (name: string) =>
    setSettings(prev => [{ ...(prev[0] || {}), copilotName: name.trim().slice(0, 24) }]);
  // Kroger chosen store (household config; the OAuth token stays per-device in localStorage).
  const setKrogerStore = (storeId: string | null, storeName: string | null) =>
    setSettings(prev => [{ ...(prev[0] || {}), krogerStoreId: storeId || undefined, krogerStoreName: storeName || undefined }]);
  // Household store-list editor (Phase-5): sanitize on the way IN so the shared blob never carries junk.
  const setStoreList = (stores: string[]) =>
    setSettings(prev => [{ ...(prev[0] || {}), storeList: sanitizeStoreList(stores) }]);
  // Pattern-4 routines: mined CANDIDATES (from the quick-add log, client-side) + the parent-enabled
  // set persisted in settings. Enabling one is what authorizes its weekday digest draft — never silent.
  const routineCandidates = useMemo(() => mineShoppingRoutines(quickAddLog), [quickAddLog]);
  const routines = settings[0]?.routines || [];
  const setRoutines = (r: Routine[]) =>
    setSettings(prev => [{ ...(prev[0] || {}), routines: r.slice(0, 12) }]);
  const handleSetStepUpPin = async (pin: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const { hash, salt } = await apiSetStepUpPin(pin);
      setSettings(prev => [{ ...(prev[0] || {}), stepUpPinHash: hash, stepUpPinSalt: salt }]);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Could not set the PIN.' };
    }
  };
  const verifyStepUpPinRemote = async (pin: string): Promise<boolean> => {
    const s = settings[0];
    if (!s?.stepUpPinHash || !s?.stepUpPinSalt) return false;
    return apiVerifyStepUpPin(pin, s.stepUpPinHash, s.stepUpPinSalt);
  };

  // Tap-to-add a copilot suggestion: build a real (clamped) event via the existing trust-boundary
  // builder, mark it added so the chip flips to ✓, and post a confirmation line. NOT auto-applied —
  // only fires on the parent's explicit ＋Create tap.
  const handleCreateSuggestion = (s: CopilotSuggestion) => {
    if (addedSuggestionKeys.has(suggestionKey(s))) return; // already added — don't duplicate the event
    const ok = addEventFromPayload(
      { title: s.title, start: s.start, category: s.category, members: s.members, description: s.note },
      'cop-sug',
    );
    if (!ok) return;
    setAddedSuggestionKeys(prev => new Set(prev).add(suggestionKey(s)));
    setCopilotMessages(prev => [...prev, { role: 'assistant', text: `✓ Added "${s.title}" on ${s.start}.` }]);
  };

  // Email scans (B1 bills / B2 packages / B3 kids' activities) — all the same provider-agnostic path:
  // mint a Google token, the server reads filtered mail + parses it (bodies never stored), returns
  // tap-to-add suggestions. One helper; thin per-kind wrappers exposed on the context.
  const scanEmail = async (path: string): Promise<{ suggestions: CopilotSuggestion[]; scanned: number; error?: string; bills?: ParsedBillLike[] }> => {
    const accessToken = await getGoogleToken();
    if (!accessToken) return { suggestions: [], scanned: 0, error: 'Connect your Google account first (sign out and back in if you just enabled email access).' };
    try {
      // Pass the Google token in a header (not the body) so it isn't captured in request-body logs.
      const res = await apiFetch(path, { method: 'POST', headers: { 'X-Google-Token': accessToken } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { suggestions: [], scanned: 0, error: data?.error || 'Email scan failed.' };
      // Validate before surfacing: require a title and a YYYY-MM-DD start (drop malformed AI output).
      const suggestions = (Array.isArray(data.suggestions) ? data.suggestions : []).filter(
        (s: any) => s && typeof s.title === 'string' && s.title.trim() && typeof s.start === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s.start),
      );
      // scan-bills also returns the raw parsed bills (parsed fields only) for autonomous persistence.
      return { suggestions, scanned: Number(data.scanned) || 0, bills: Array.isArray(data.bills) ? data.bills : undefined };
    } catch (e) {
      console.error('Email scan failed:', e);
      return { suggestions: [], scanned: 0, error: 'Email scan failed.' };
    }
  };
  const scanEmailForBills = () => scanEmail('/api/scan-bills');
  const scanEmailForPackages = () => scanEmail('/api/scan-packages');
  const scanEmailForKidsActivities = () => scanEmail('/api/scan-kids');
  // Newsletter ingest — returns normalized messages (from/subject/snippet) for the Library corpus.
  const scanNewsletters = async (): Promise<NormalizedMessage[]> => {
    const accessToken = await getGoogleToken();
    if (!accessToken) return [];
    try {
      const res = await apiFetch('/api/scan-newsletters', { method: 'POST', headers: { 'X-Google-Token': accessToken } });
      const data = await res.json().catch(() => ({}));
      return res.ok && Array.isArray(data.newsletters) ? data.newsletters : [];
    } catch { return []; }
  };

  // Opt-in proactive email scan (Manage → "Auto-scan email"). While enabled AND signed in with Gmail,
  // scan all three categories every 30 min (and once on enable) and surface the de-duplicated finds in
  // the copilot bar (already-added ones are filtered at render). Client-only: runs while the app is open.
  const [autoEmailSuggestions, setAutoEmailSuggestions] = useState<CopilotSuggestion[]>([]);
  useEffect(() => {
    if (!autoScanEnabled || !googleUser) { setAutoEmailSuggestions([]); return; }
    let active = true;
    const runAll = async () => {
      const [results, newsletters] = await Promise.all([
        Promise.all([scanEmailForBills(), scanEmailForPackages(), scanEmailForKidsActivities()]),
        scanNewsletters(),
      ]);
      if (!active) return;
      const seen = new Set<string>();
      const fresh = results.flatMap(r => r.suggestions).filter(s => {
        const k = suggestionKey(s);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      setAutoEmailSuggestions(fresh);
      // Agentic ingest: persist the parsed bills to the `bills` collection (deduped) so the agent's
      // get_bills reflects the inbox WITHOUT any human action — this is the autonomous scan, not a button.
      const scannedBills = results[0]?.bills;
      if (scannedBills?.length) {
        setBillsList(prev => mergeBills(prev, scannedBills, () => ({ id: 'bill-' + uuid(), ...authorStamp() })));
      }
      // Agentic ingest: persist newsletters into the Docs Library corpus (deduped) so the copilot + agent
      // ground on them — autonomously, no manual "import" click.
      if (newsletters.length) {
        setLibraryDocs(prev => mergeNewsletterDocs(prev, newsletters, () => ({ id: 'doc-' + uuid(), ...authorStamp() })));
      }
    };
    runAll();
    const iv = setInterval(runAll, 30 * 60 * 1000);
    return () => { active = false; clearInterval(iv); };
    // scanEmailFor* only call stable module-level helpers (apiFetch/getGoogleToken) and fetch a fresh
    // token per call, so omitting them is safe — adding them would restart the interval every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoScanEnabled, googleUser?.email]);

  // "We went" capture: upsert a per-place last-visit from a (past) event for HISTORY FACTS grounding.
  const handleMarkVisited = (event: CalendarEvent) => {
    const label = (event.location || event.title || '').trim();
    if (!label) return;
    setVisitLog(prev => upsertVisit(prev, {
      id: 'visit-' + uuid(),
      label,
      category: event.category,
      lastVisited: String(event.start).slice(0, 10),
    }));
  };

  // Override an existing event's availability classification (or clear it back to auto) so the
  // owner can correct a copilot misread ("OOO sync meeting"). '' clears the field.
  const handleSetEventFreeBusy = (id: string, value: '' | 'busy' | 'free') => {
    setEvents(prev => prev.map(e =>
      e.id === id ? { ...e, freeBusy: value || undefined } : e,
    ));
    setSelectedEventDetail(prev => (prev && prev.id === id ? { ...prev, freeBusy: value || undefined } : prev));
  };

  // Delete Web source calendar action — removes only events imported from THIS source
  const handleDeleteSource = (id: string) => {
    setSources(prev => prev.filter(s => s.id !== id));
    setEvents(prev => prev.filter(e => e.sourceId !== id));
  };

  // Toggle family member checkbox in add event form

  // Connect to Copilot AI Summer Coordinator
  // Bridge the cloud agent's mutating tool results into the SAME UI the local copilot uses. Auto-tier
  // writes already persisted server-side under the visitor's JWT (MCP persistResult) → resync local state
  // instead of re-applying (which would double-write). Confirm/stepup → Approve-queue ledger rows. Returns
  // a one-line summary (or '').
  const applyAgentActions = async (actions: AgentAction[]): Promise<{ summary: string; suggestions: CopilotSuggestion[] }> => {
    // Goals (A6): set_goal is auto-tier and CLIENT-owned (not server-persisted) — upsert each goal the
    // agent produced into the goals collection (RLS-synced so the scheduler can later nudge it). Handled
    // here (not buildAgentActionResult, which yields ledger rows) since a goal is its own collection.
    const goals = (Array.isArray(actions) ? actions : [])
      .filter(a => a?.tool === 'set_goal' && a.artifact)
      .map(a => a.artifact as Goal);
    const { appliedCount, ledger, summary } = buildAgentActionResult(actions, () => 'led-' + uuid(), authorStamp());
    // Tie this turn's staged approvals to the goal it serves (Phase 1: same-turn association) so approving
    // one ADVANCES the goal's plan (the resume hook in resolveLedgerUpdate). Only the EXTERNAL/booking drafts
    // are goal steps — and crucially, only THOSE resolve through the resume hook's branch. A destructive
    // chore/shopping edit (from another sub-agent in a multi-intent turn) handles its own early-return branch
    // and would NEVER reach the hook, so tying it would wedge the goal in 'waiting' forever — exclude it.
    const goalId = goals.length ? goals[goals.length - 1].id : undefined;
    const staged = goalId ? ledger.map(e => (GOAL_STEP_TOOLS.has(e.tool) ? { ...e, goalId } : e)) : ledger;
    // ORDER MATTERS: when the agent also auto-applied a write this turn (e.g. a trip's calendar event),
    // refreshHouseholdData() reloads + OVERWRITES every collection — including the client-owned goals and
    // actionledger. Doing it BEFORE we add this turn's optimistic goal + drafts would clobber them with the
    // stale cloud copy (they haven't persisted yet) — the bug where a trip's goal + booking drafts vanished.
    // So: await the refresh FIRST (pulls the server-applied write), THEN layer the goal + ledger on top.
    if (appliedCount) await refreshHouseholdData(); // auto-tier writes already persisted server-side → resync local
    for (const g of goals) upsertGoal(g);
    if (staged.length) setActionLedger(prev => [...prev, ...staged].slice(-LEDGER_CAP));
    // (The agent's create_event writes reach the parent's real Google Calendar via the silent auto-push effect
    // when a Push rule is connected — so we no longer stage a redundant "Push N events?" approval here. See the
    // auto-push effect + README "Auto-push to Google".)
    // Each goal-step approval marks the goal's next pending step "waiting on you" (zips in order).
    if (goalId) staged.forEach(e => { if (GOAL_STEP_TOOLS.has(e.tool)) blockGoalStep(goalId, e.id); });
    const goalNote = goals.length ? `🎯 Tracking goal: ${goals[goals.length - 1].text}` : '';
    // suggest_event is auto-tier + client-owned (like set_goal): the agent's outings picks ride back as
    // tap-to-add chips on this turn's assistant message (rendered by CopilotBar), NOT Approve-queue rows.
    const suggestions = (Array.isArray(actions) ? actions : [])
      .filter(a => a?.tool === 'suggest_event' && a.artifact)
      .map(a => a.artifact as CopilotSuggestion);
    return { summary: [summary, goalNote].filter(Boolean).join(' '), suggestions };
  };

  // Cloud-agent turn (Gemini ADK multi-agent over MCP). Returns true if it HANDLED the turn; false → the
  // caller falls back to the local copilot (resilience). Renders the reply + bridges its tool results.
  const runAgentTurn = async (query: string, isRetry = false): Promise<boolean> => {
    let r;
    try {
      const jwt = await getAuthToken();
      // Hand the agent the SAME context the copilot has: recent conversation + the family roster (names +
      // ages) so an escalated turn hears the user's framing and doesn't guess ages.
      const history = copilotMessages.slice(-8).map(m => ({ role: m.role, text: m.text }));
      const family = familyMembers.map(m => (m.age ? `${m.name} (${m.age}, ${m.role})` : `${m.name} (${m.role})`)).join(', ');
      // The family's CURRENT active goals — so the agent can reference the right id to mark a step/goal done and
      // honestly "recheck" (it has no get_goals tool; this rides in the prompt, surviving model fallback).
      const goals = goalsList
        .filter(g => g.status !== 'done' && g.status !== 'abandoned')
        .slice(0, 5)
        .map(g => ({ id: g.id, text: g.text, status: g.status, ...(g.nextAction ? { nextAction: g.nextAction } : {}), steps: (g.steps || []).map(s => ({ title: s.title, status: s.status })) }));
      r = await askConciergeAgent(jwt, agentSessionId, query, { history, family, goals, copilotName, stores: storeList });
    } catch (e) {
      console.warn('Agent turn failed; falling back to local copilot.', e);
      return false;
    }
    setAgentSessionId(r.sessionId);
    const reply = (r.reply || '').trim();
    // SOFT-FAILURE auto-retry (once). A 200 where the agent gave up with NO actions and a tool-trouble apology
    // (the Vancouver "I'm having trouble finding places using my tools" case) — the tool usually succeeds on a
    // second try. Re-run ONCE before surfacing the give-up. The narrow pattern + one-shot guard keep a genuine
    // clarifying question (or a 2nd identical give-up) from being looped.
    if (!isRetry && !(r.actions?.length) && /having (trouble|issues)|could ?n'?t (find|retrieve|access)|trouble (finding|retrieving|accessing)/i.test(reply)) {
      return runAgentTurn(query, true);
    }
    // Backstop: drop any unrequested delete of an all-day / Holiday event the agent staged (holidays don't
    // block a new plan). An explicit "delete/remove/cancel …" in the user's message keeps the delete.
    const guard = filterUnrequestedHolidayDeletes<AgentAction>(
      (r.actions || []) as AgentAction[], events, query,
      (a: AgentAction) => ({ isDeleteEvent: a.tool === 'delete_event', ref: (a.artifact || {}) as { id?: string; title?: string; start?: string } }),
    );
    const { summary, suggestions } = await applyAgentActions(guard.kept);
    if (!reply && !summary && !suggestions.length) return false; // empty 200 (no reply / actions / chips) → let local handle it
    // Honesty guard: if the reply CLAIMS it set up a goal / staged a booking but no matching tool action came
    // back, surface an honest correction rather than letting the empty claim stand (the narrate-not-call bug).
    const corrections = detectUnbackedClaims(reply, r.actions);
    const holidayNote = guard.dropped.length
      ? `ℹ️ I left ${guard.dropped.map(d => `"${d.title}"`).join(', ')} in place — a holiday or all-day event doesn't block a new plan. Say "delete <name>" if you really want it removed.`
      : '';
    setCopilotMessages(prev => [
      ...prev,
      { role: 'assistant' as const, text: reply || '(done)', source: 'agent' as const, ...(r.model ? { model: r.model } : {}), ...(suggestions.length ? { suggestions } : {}) },
      ...(holidayNote ? [{ role: 'assistant' as const, text: holidayNote, source: 'agent' as const }] : []),
      ...(summary ? [{ role: 'assistant' as const, text: summary, source: 'agent' as const }] : []),
      ...corrections.map(c => ({ role: 'assistant' as const, text: c, source: 'agent' as const })),
    ]);
    return true;
  };

  // Local copilot turn (/api/copilot — local gpt-oss harness with FACTS grounding + staged suggestions).
  // `degraded` = the cloud agent was the intended engine but was unreachable, so this LOCAL answer is a
  // labeled fallback ('fallback' source → "⚠ offline — limited" badge), never mistaken for the cloud agent.
  const runLocalCopilotTurn = async (query: string, opts?: { degraded?: boolean }): Promise<void> => {
    const src: 'local' | 'fallback' = opts?.degraded ? 'fallback' : 'local';
    try {
      const res = await apiFetch('/api/copilot', {
        method: 'POST',
        body: JSON.stringify({
          events: events,
          prompt: query,
          familyMembers: familyMembers.map(m => ({ name: m.name, age: m.age })), // names + ages (don't guess ages)
          home: settings[0], // home location (if set) for weather grounding; server ignores if absent
          visitLog: visitLog, // per-place "last visited" log for HISTORY FACTS grounding (planning queries)
          // Docs Library text for LOCAL KNOWLEDGE FACTS grounding; the server keyword-retrieves + caps it.
          documents: libraryDocs.map(d => ({ name: d.name, folder: d.folder, text: d.text, createdAt: d.createdAt })),
          // Short conversation memory: prior transcript turns (current `prompt` excluded) so the model
          // can resolve "that"/"extend it". Last 8 here; the server sanitizes + caps to the last few.
          // Strip suggestions — only role+text matter for memory (keeps the payload lean).
          chatHistory: copilotMessages.slice(-8).map(m => ({ role: m.role, text: m.text }))
        })
      });

      if (!res.ok) {
        throw new Error('Copilot endpoint error.');
      }

      const data = await res.json();
      // If the primary model was overloaded and we answered via a discovered fallback, say so.
      const fallbackNote = data.usedFallback && data.model
        ? `_⚠️ The usual model was busy, so I switched to **${data.model}** to answer:_\n\n`
        : '';
      setCopilotMessages(prev => [
        ...prev,
        {
          role: 'assistant',
          text: fallbackNote + (data.answer || "No suggestions returned."),
          // Tap-to-add chips ride on this assistant turn (rendered under it in CopilotBar).
          suggestions: Array.isArray(data.suggestions) && data.suggestions.length ? data.suggestions : undefined,
          source: src,
        },
      ]);
      // Apply any create-only actions the copilot proposed, and report what was done.
      const actionSummary = applyCopilotActions(data.actions || []);
      if (actionSummary) {
        setCopilotMessages(prev => [...prev, { role: 'assistant', text: actionSummary, source: src }]);
      }
      // Persist this Q+A turn (structured) for audit + RL — RAW answer (not the fallback-note display
      // text), truncated; model; returned suggestions/actions. Author-stamped (who asked), rolling-
      // capped. See utils/historyLog (buildCopilotLogEntry truncates the answer; appendCapped bounds).
      const cpLogEntry = buildCopilotLogEntry('cplog-' + uuid(), query, data, authorStamp());
      setCopilotLog(prev => appendCapped(prev, cpLogEntry, LOG_CAP));
    } catch (err: any) {
      console.error(err);
      // Surface a real error instead of fabricating fake content (the old fallback
      // invented hardcoded "Robotics Camp" answers that misled the user on failures).
      setCopilotMessages(prev => [
        ...prev,
        { role: 'assistant', text: "⚠️ The AI is overloaded right now — I tried the main model and the available fallbacks, but they're all busy. Please try again in a moment.", source: src, error: true }
      ]);
    }
  };

  // The ONE copilot entry point. Routes each turn to the cloud agent (actions/discovery) or the local
  // copilot (Q&A), per copilotRouter; `forced` is the "escalate to cloud agent" override. Agent failure
  // silently falls back to local so the bar always answers.
  const handleSendCopilotMessage = async (textToSend?: string, opts?: { forced?: boolean }) => {
    const query = (textToSend ?? '').trim();
    if (!query) return;
    setCopilotMessages(prev => [...prev, { role: 'user' as const, text: query }]);
    setIsCopilotThinking(true);
    const engine = routeTurn(query, { agentReachable: isAgentConfigured(), forced: opts?.forced });
    try {
      if (engine === 'agent') {
        if (await runAgentTurn(query)) return; // the concierge handled it
        // Hard failure (agent unreachable / empty 200). Auto-retry ONCE — a transient 503 usually clears on a
        // second attempt — before degrading to the honest "busy" message (the manual Retry covers further tries).
        if (await runAgentTurn(query)) return;
        // The concierge's full (tool-using) engine is unreachable. This is an action/planning turn (quick Q&A
        // routes to the fast path), and the tool-LESS quick path can't actually plan or act — so DON'T fabricate
        // a degraded answer (the old "July 3/4" fake). Say so honestly + offer Retry. NOTE: runLocalCopilotTurn's
        // `degraded` path is intentionally KEPT (not called here) for when a LOCAL tool-using engine (gpt-oss)
        // comes online.
        setCopilotMessages(prev => [...prev, {
          role: 'assistant' as const,
          text: 'The full planner is busy right now — I can still answer quick questions. Tap Retry to reach it.',
          source: 'fallback' as const,
          error: true,
        }]);
        return;
      }
      await runLocalCopilotTurn(query); // pure read-only quick path (unbadged)
    } finally {
      setIsCopilotThinking(false);
    }
  };

  // Add custom family member
  const handleAddMember = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newMemberName.trim();
    if (!trimmed) return;
    
    // Check if member already exists
    if (familyMembers.some(m => m.name.toLowerCase() === trimmed.toLowerCase())) {
      alert(`A family member named "${trimmed}" is already registered!`);
      return;
    }
    
    // Verify unique color - if selected color is taken, pick first untaken color
    let selectedColor = newMemberColor;
    const takenColors = new Set(familyMembers.map(m => m.color));
    if (takenColors.has(selectedColor)) {
      const remainingColor = MEMBER_COLORS_LIST.find(c => !takenColors.has(c.id));
      if (remainingColor) {
        selectedColor = remainingColor.id;
      } else {
        // Fallback if all colors taken
        selectedColor = MEMBER_COLORS_LIST[familyMembers.length % MEMBER_COLORS_LIST.length].id;
      }
    }
    
    const parsedAge = parseInt(newMemberAge, 10);
    const newMember: FamilyMember = {
      name: trimmed,
      role: newMemberRole,
      color: selectedColor,
      dietary: newMemberDietary.trim() || undefined,
      interests: newMemberInterests.trim() || undefined,
      age: Number.isFinite(parsedAge) && parsedAge > 0 && parsedAge < 120 ? parsedAge : undefined,
    };

    setFamilyMembers(prev => [...prev, newMember]);
    setNewMemberName('');
    setNewMemberRole('Kid');
    setNewMemberDietary('');
    setNewMemberInterests('');
    setNewMemberAge('');
    
    // Find next untaken color for the next addition
    const updatedTakenColors = new Set([...familyMembers, newMember].map(m => m.color));
    const nextFreeColor = MEMBER_COLORS_LIST.find(c => !updatedTakenColors.has(c.id));
    if (nextFreeColor) {
      setNewMemberColor(nextFreeColor.id);
    }
    
    setShowAddMember(false);
  };

  // Delete family member — cascade removal so no name-keyed data orphans (mirror of
  // handleRenameMember, with removal semantics). Without this, a deleted kid's chores,
  // redemptions, event tags, and calendar connections would linger invisibly.
  const handleDeleteMember = (name: string) => {
    const confirmed = window.confirm(`Are you sure you want to delete profile for "${name}"?`);
    if (!confirmed) return;
    const strip = (arr?: string[]) => arr?.filter(n => n !== name);
    const unset = (v: string) => (v === name ? 'All' : v);

    setFamilyMembers(prev => prev.filter(m => m.name !== name));
    setChoresList(prev => prev.filter(c => c.assignedTo !== name));
    setRedemptionsList(prev => prev.filter(r => r.member !== name));
    setXpBankList(prev => prev.filter(b => b.member !== name));
    setEvents(prev => prev.map(e => ({ ...e, members: strip(e.members) })));
    // Reassign the deleted member's calendar connections to Family rather than drop them.
    setConnectedCalendars(prev => prev.map(c => (c.assignedTo === name ? { ...c, assignedTo: 'Family' } : c)));
    setActiveMemberFilter(unset);
    setSyncAssignee(v => (v === name ? 'Family' : v));
    setCustomEventMembers(prev => strip(prev) ?? []);
  };

  // ── Chore rewards: catalog + redemption (debits a kid's earned XP) ───────────
  // (Reward add/delete/redeem handlers now live in useChores, destructured above.)

  // ── Onboarding gate ──────────────────────────────────────────────────────────
  // While the session is being restored, show a minimal splash to avoid flashing
  // the sign-in screen for already-authenticated users.
  // Pre-auth: loading splash, then a blocking Google sign-in (rendered before the provider).
  // Loading splash while the session is unresolved OR a signed-in user's data is still loading;
  // the sign-in form once resolved with no user. Passing authChecked=false to SignInGate renders the
  // splash, so `bootstrapping` (data phase) reuses it — keeping the app unmounted until data is ready.
  // Local appliance (SQLite): a household passphrase setup/login screen instead of Google. Only once the
  // mode is known and there's no box session yet; the splash below covers mode-detection + post-login bootstrap.
  if (appMode === 'sqlite' && !googleUser && !bootstrapping) {
    return <LocalAuthGate configured={localConfigured} onAuthed={handleLocalAuthed} />;
  }
  if (!authChecked || bootstrapping || !googleUser) {
    // SignInGate's `authChecked` toggles splash (false) vs sign-in form (true). Show the splash while
    // the session is unresolved OR data is loading; the form only once resolved with no user.
    return <SignInGate authChecked={authChecked && !bootstrapping} onLogin={handleGoogleLogin} onTryDemo={handleTryDemo} errorStatus={errorStatus} />;
  }

  const ctx: AppCtx = {
    shoppingList, setShoppingList,
    sendShoppingToKroger, krogerBusy, krogerStoreName: settings[0]?.krogerStoreName || null,
    krogerOffer, dismissKrogerOffer,
    storeList, setStoreList,
    routineCandidates, routines, setRoutines,
    newShopText, setNewShopText,
    newShopStore, setNewShopStore,
    newShopQty, setNewShopQty,
    newShopNotes, setNewShopNotes,
    pantryList,
    newPantryText, setNewPantryText,
    handleAddPantryItem, handleDeletePantryItem,
    recipeInput, setRecipeInput,
    handleParseRecipe, isParsingRecipe,
    handleSuggestRestock, isSuggestingRestock,
    handlePlanMeals, isPlanningMeals, mealPlan,
    isScanningPantry, pantryScan, handleScanPantryPhoto, confirmPantryScan, dismissPantryScan,
    shoppingAiError, setShoppingAiError,
    goalsList, toggleGoal, deleteGoal, toggleStep,
    choresList, setChoresList,
    authorStamp,
    familyMembers,
    choreTimeFilter, setChoreTimeFilter,
    newChoreTitle, setNewChoreTitle,
    newChoreAssigned, setNewChoreAssigned,
    newChorePoints, setNewChorePoints,
    newChoreTimesPerDay, setNewChoreTimesPerDay,
    newChoreRepeatType, setNewChoreRepeatType,
    newChoreScheduleTime, setNewChoreScheduleTime,
    newChoreNotes, setNewChoreNotes,
    rewardsList, redemptionsList, xpBankList,
    newRewardTitle, setNewRewardTitle,
    newRewardCost, setNewRewardCost,
    handleAddReward, handleDeleteReward, handleRedeemReward,
    setFamilyMembers,
    editingMember, setEditingMember,
    editNameInput, setEditNameInput,
    handleRenameMember, handleDeleteMember,
    showAddMember, setShowAddMember,
    handleAddMember,
    newMemberName, setNewMemberName,
    newMemberRole, setNewMemberRole,
    newMemberColor, setNewMemberColor,
    newMemberDietary, setNewMemberDietary,
    newMemberInterests, setNewMemberInterests,
    newMemberAge, setNewMemberAge,
    handleSubmitName, handleReclaimProfile, nameInput, setNameInput,
    onboardingName, handleSaveOnboardingPrefs, dismissOnboarding,
    inviteCodeInput, setInviteCodeInput, isJoiningHousehold, handleJoinHousehold,
    selectedDayToAdd, setSelectedDayToAdd, setIsAddingEvent,
    handleAddCustomEvent,
    customEventTitle, setCustomEventTitle,
    customEventCategory, setCustomEventCategory,
    customEventLocation, setCustomEventLocation,
    customEventEnd, setCustomEventEnd,
    customEventStartTime, setCustomEventStartTime,
    customEventEndTime, setCustomEventEndTime,
    customEventFreeBusy, setCustomEventFreeBusy,
    customEventDescription, setCustomEventDescription,
    customEventMembers, toggleEventMember,
    // Concierge action ledger + approval handlers (foundation A2)
    actionLedger, approveLedgerEntry, rejectLedgerEntry, reviseLedgerEntry, stageLedgerEntries,
    // Step-up PIN gate (A3)
    hasStepUpPin, verifyStepUpPin: verifyStepUpPinRemote, setStepUpPin: handleSetStepUpPin,
    digestPrefs, setDigestPrefs,
    // Kid mode (per-device — see useDevicePrefs)
    kidMode, setKidMode,

    // The family's name for the copilot (synced household setting)
    copilotName, setCopilotName,
    clearCopilotHistory,
    setKrogerStore, krogerStoreId: settings[0]?.krogerStoreId || null,
    homeLat: settings[0]?.homeLat ?? null, homeLng: settings[0]?.homeLng ?? null,

    // Email scans (B1 bills / B2 packages / B3 kids) + shared suggestion-create (also used by the copilot panel)
    scanEmailForBills, scanEmailForPackages, scanEmailForKidsActivities, handleCreateSuggestion, addedSuggestionKeys,
    autoEmailSuggestions,
    autoScanActive: autoScanEnabled && !!googleUser,
  };

  // Calendar/shell context value (state stays here in App; consumed by the DarkShell surface via
  // useCalendar()). Kept separate from AppCtx so the calendar state doesn't bloat the app-wide context.
  const calendarCtx: CalendarCtx = {
    events, sources, familyMembers, googleUser,
    activeCategoryFilter, setActiveCategoryFilter,
    activeMemberFilter, setActiveMemberFilter,
    searchQuery, setSearchQuery,
    syncMode, setSyncMode,
    errorStatus, setErrorStatus,
    newUrl, setNewUrl,
    newSourceName, setNewSourceName,
    newUrlCategory, setNewUrlCategory,
    syncAssignee, setSyncAssignee,
    isParsing, parserStep,
    pastedText, setPastedText,
    textSourceName, setTextSourceName,
    textCategory, setTextCategory,
    pdfCategory, setPdfCategory,
    dragActive, setDragActive,
    handleAddSource, handleTextSubmit, handlePdfUpload, handleDeleteSource,
    cloudInviteCode,
    inviteCodeInput, setInviteCodeInput,
    isJoiningHousehold, handleJoinHousehold,
    isFetchingCalendars, connectedCalendars, googleCalendarsList,
    calendarSyncLogs, setCalendarSyncLogs,
    syncGoogleCalendars, toggleGoogleCalendarActive, removeGoogleCalendarConnection, addGoogleCalendarConnection,
    hasOwnCalendarConnection, connectOwnCalendar,
    handleGoogleLogoutClick,
    googlePushEvent, openGooglePush, closeGooglePush, isPushingEvent, pushEventToGoogleCalendars,
    currentMonthInfo, monthsData, currentMonthStep, setCurrentMonthStep,
    calendarCells, DAYS_OF_WEEK, conflicts, recurringGroups, openWeekendsLeft,
    getEventsForDate, filterEvent, getEventColor,
    selectedEventDetail, setSelectedEventDetail,
    setSelectedDayToAdd, setIsAddingEvent,
    handleDeleteEvent, handleDeleteRecurringGroup,
    hiddenEvents, restoreHiddenEvent, restoreAllHiddenEvents,
    copilotMessages, isCopilotThinking, handleSendCopilotMessage,
    visitLog, handleMarkVisited, handleSetEventFreeBusy,
    libraryDocs, setLibraryDocs,
    addedSuggestionKeys, handleCreateSuggestion,
    // Mandatory-location gate for the copilot: a home location must be set before planning/place queries
    // can be grounded (no home → no real venues → the fabrication path the prompt now refuses).
    hasHomeLocation: !!(settings[0] && Number.isFinite(settings[0].homeLat) && Number.isFinite(settings[0].homeLng)),
    saveHomeLocation: handleSaveHomeLocation,
    homeLat: settings[0]?.homeLat,
    homeLng: settings[0]?.homeLng,
    homeLabel: settings[0]?.homeLabel,
  };

  return (
    <AppContext.Provider value={ctx}>
    <CalendarContext.Provider value={calendarCtx}>
    <div id="app-root" className="bg-shell text-primary antialiased">

      {/* Name picker — first-run gate (not dismissable), or on-demand from the account menu to link
          a profile (dismissable). */}
      {needsNamePrompt && (
        <NamePromptModal
          dismissable={namePromptDismissable}
          onDismiss={() => { setNeedsNamePrompt(false); setNamePromptDismissable(false); }}
        />
      )}

      {/* COPILOT-FIRST DARK SHELL — one persistent copilot bar + four swipeable context pages
          (Today · Chores · Shopping · Library). Replaces the old header / quick-add / tab switcher;
          the idle screensaver now lives inside the shell. */}
      <DarkShell
        screensaverOn={screensaverOn}
        onWakeFromScreensaver={handleWakeFromScreensaver}
        isRefreshing={isRefreshing}
        photosScreensaver={photosScreensaver}
        account={{
          user: googleUser,
          nickname: familyMembers[matchOwnProfileIndex(familyMembers, googleUser?.id, googleUser?.email ?? undefined)]?.name,
          onSignOut: handleGoogleLogoutClick,
          onLinkProfile: openNamePrompt,
          idleTimeoutMs,
          onChangeIdleTimeout: setIdleTimeoutMs,
          photosScreensaver,
          onChangePhotosScreensaver: setPhotosScreensaver,
          signOutMs,
          onChangeSignOut: setSignOutMs,
          remindersEnabled,
          onToggleReminders: handleToggleReminders,
          reminderTime,
          onChangeReminderTime: setReminderTime,
          reminderLead: reminderLeadMinutes,
          onChangeReminderLead: setReminderLeadMinutes,
          onRefresh: refreshHouseholdData,
          isRefreshing,
          autoScanEnabled,
          onToggleAutoScan: setAutoScanEnabled,
        }}
      />

      {/* DYNAMIC SPANNING MODAL: QUICK POPUP TO MANUALLY ADD EVENTS FOR A SPECIFIC DATE (lazy) */}
      <Suspense fallback={null}>
        {isAddingEvent && selectedDayToAdd && <AddEventModal />}
      </Suspense>

      {/* Stale-write toast (§5.3 last-mile): a rejected concurrent write triggered a convergence
          refresh — tell the user why the screen just updated. aria-live so screen readers hear it. */}
      {staleToastVisible && (
        <div
          aria-live="polite"
          className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-[13px] font-bold"
          // C.elevated / C.emerald / C.primary from the shell palette (App.tsx doesn't pull in shell/theme).
          style={{ background: '#1e2538', border: '2px solid #34d399', color: '#e2e8f4', boxShadow: '0 4px 14px rgba(0,0,0,0.5)' }}
        >
          Updated elsewhere — refreshed to the latest.
        </div>
      )}

    </div>
    </CalendarContext.Provider>
    </AppContext.Provider>
  );
}

