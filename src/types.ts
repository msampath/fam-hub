// Shared domain types for Family-Hub.

export type Category = 'School' | 'Camp' | 'Sports' | 'Arts' | 'Holiday' | 'Other';

// Per-record authorship — who created a record and when. Best-effort metadata (never gate creation
// on it; never overwrite on edit) for the audit trail + RL dataset. Stamped at create sites via the
// AppContext `authorStamp()` helper. The data itself is household-scoped/shared; this records WHICH
// member (by stable email + auth userId) created the individual record.
export interface Authored {
  createdAt?: string;        // ISO timestamp
  createdByUserId?: string;  // Supabase auth user id
  createdByEmail?: string;   // stable Google email
}

export interface CalendarEvent extends Authored {
  id: string;
  title: string;
  start: string; // YYYY-MM-DD format
  end?: string;  // YYYY-MM-DD format
  startTime?: string; // 'HH:MM' (24h, event-local). Optional — absent = all-day event.
  endTime?: string;   // 'HH:MM'
  description?: string;
  location?: string;
  category: Category;
  // Optional explicit availability override for the copilot's AVAILABILITY/long-weekend grounding:
  // 'free' = the family is available (time off, holidays, OOO, no-school — frees the day for
  // planning); 'busy' = occupies the person. Absent → classified from the category/title keywords.
  // Lets the owner correct a misread title ("OOO sync meeting").
  freeBusy?: 'busy' | 'free';
  ageGroup?: string;
  members?: string[]; // Handled family members
  sourceId?: string; // id of the WebSource this event was imported from (for precise deletion)
  recurringEventId?: string; // Google Calendar series id; set on each expanded instance of a recurring event
}

// A copilot-proposed dated activity the parent can one-tap add (tap-to-add, NOT auto-applied).
// Returned in the copilot response's `suggestions[]`; `note` (weather / what-to-bring) becomes the
// created event's description.
export interface CopilotSuggestion {
  start: string;       // YYYY-MM-DD
  title: string;
  category?: Category;
  members?: string[];
  note?: string;
  url?: string;        // a REAL link for a grounded "place"/"event" suggestion (server-resolved from a
                       // PLACES/EVENTS fact — official site → Google Maps link). Absent for generic ideas.
}

// A single copilot chat turn. `suggestions` rides on an assistant turn so the panel can render a
// ＋Create chip per suggestion right under that reply.
export interface CopilotMessage {
  role: 'user' | 'assistant';
  text: string;
  suggestions?: CopilotSuggestion[];
  // Which engine answered (shown as a subtle tag on assistant turns). 'fallback' = the cloud agent was the
  // intended engine but was unreachable, so the limited local copilot answered — labeled so it's never
  // mistaken for the cloud agent (which carries the ☁ badge).
  source?: 'local' | 'agent' | 'fallback';
  model?: string; // for an 'agent' turn: the Gemini model that answered (shown next to the ☁ badge)
  error?: boolean; // a dead-end failure (both engines down) → the bar renders a one-tap Retry on this turn
}

// Append-only log of copilot Q+A turns — persisted (data_key 'copilotlog') as a ROLLING WINDOW of
// the most-recent turns (capped — see LOG_CAP in utils/historyLog), not a complete forever-archive.
// For audit + an RL dataset. Household-scoped, but each entry carries its author (via Authored).
// Structured (prompt + answer[truncated] + model + the returned suggestions/actions) so it can
// train/evaluate later. `createdAt` (from Authored) is the turn timestamp.
export interface CopilotLogEntry extends Authored {
  id: string;
  prompt: string;
  answer: string;
  model?: string;
  usedFallback?: boolean;
  suggestions?: CopilotSuggestion[];
  actions?: any[];
}

// Append-only log of natural-language quick-add prompts — persisted (data_key 'quickaddlog').
export interface QuickAddLogEntry extends Authored {
  id: string;
  text: string;     // the raw text the user typed
  kind?: string;    // classified kind: event | shopping | chore
  summary?: string; // human-readable outcome
}

// ── Concierge action spine (foundation A1) ──────────────────────────────────────
// Risk tier of a concierge tool — governs how an action is applied:
//   'auto'    = reversible, free, internal (create event/chore/shopping) → auto-apply
//   'confirm' = spends money / drafts something external (cart, reservation) → human confirms
//   'stepup'  = touches the physical world (arm/disarm, unlock, thermostat) → confirm + PIN
export type RiskTier = 'auto' | 'confirm' | 'stepup';

// Lifecycle of a ledger entry. 'applied' = an auto action that already ran (audit only).
// 'pending' = awaiting human approval. 'approved'/'rejected' = resolved. 'failed' = execute errored.
export type LedgerStatus = 'applied' | 'pending' | 'approved' | 'rejected' | 'failed';

// Append-only ledger of concierge actions (data_key 'actionledger'), a ROLLING WINDOW like the
// copilot/quick-add logs (capped — see LEDGER_CAP in utils/historyLog). It is the audit trail AND
// (from A2) the approval queue: every applied auto-action lands here as 'applied'; every action that
// needs a human lands as 'pending'. Additive optional fields (mirrors Authored/CopilotLogEntry), so
// older blobs stay valid. Household-scoped; each entry carries its author via Authored.
export interface LedgerEntry extends Authored {
  id: string;
  tool: string;            // registered tool name = the copilot action type (e.g. 'create_event')
  riskTier: RiskTier;
  status: LedgerStatus;
  summary?: string;        // human-readable one-liner for the ledger/inbox row
  link?: string;           // booking/cart deep-link for a confirm-DRAFT action (reservation, Amazon
                           // cart) — the parent opens it to complete; the agent never books/pays.
  refId?: string;          // id of the record this action created/affects (e.g. the new event id) —
                           // a REFERENCE, not a copy, so the ledger doesn't duplicate the record's
                           // PII (it already lives in events/chores/shopping).
  refIds?: string[];       // multiple record ids for a bulk action (e.g. "delete all docs in a folder")
                           // staged as ONE Approvals row — same reference-not-copy rule as refId.
  payload?: unknown;       // reserved for tools whose data ISN'T a duplicate of an existing record
                           // (e.g. a draft Amazon cart). NOT used for internal creates (use refId).
  before?: unknown;        // for update tools: the CHANGED-KEYS subset of the pre-change values
                           // (+ title for the heading) for the before→after preview — not the full event.
  changes?: unknown;       // for update tools: the validated partial to merge on approve
  sourceLogId?: string;    // links to the CopilotLogEntry.id that proposed this action
  proactiveDate?: string;  // YYYY-MM-DD: this entry was pre-staged by the morning proactive agent (#1) on
                           // that date — used to de-dupe a same-day re-run of the scheduler.
  goalId?: string;         // links this action to a tracked Goal — on approval the goal's matching step
                           // advances (the agentic goal loop, A6). Set when an action is staged to serve a goal.
  resolvedAt?: string;     // ISO when approved/rejected (set in A2)
  resolvedByUserId?: string; // who approved a confirm/stepup action (step-up audit, A2/A3)
}

export interface WebSource {
  id: string;
  name: string;
  url: string;
  category: Category;
  lastSync: string;
  status: 'active' | 'warning' | 'error';
  eventCount: number;
}

export interface ShoppingItem extends Authored {
  id: string;
  text: string;
  completed: boolean;
  // Household-defined (Phase-5): one of settings.storeList — defaults in constants.SHOP_STORES.
  // Was a hardcoded union; validation now happens where items are created (sanitizeStoreList +
  // normalizeShoppingItems against the live list), not in the type.
  store: string;
  quantity?: string;
  notes?: string;
  staple?: boolean; // recurring household staple — re-addable after being checked off
}

export interface PantryItem {
  id: string;
  text: string; // freeform inventory note, e.g. "500g besan", "low on yogurt"
}

// A multi-step goal the concierge is tracking (agentic A6) — so a longer task follows through and is
// visible to the family ("Plan the Rainier trip"). Extended into a tracked object: the agent records
// the PLAN as `steps[]`, and the goal advances ('active' → 'waiting' on a human → 'done') as reversible
// steps apply and staged steps are approved. All new fields are optional so older {text,status} blobs
// stay valid; 'open' remains a synonym for a not-yet-started goal.
export interface GoalStep {
  title: string;                              // e.g. "Reserve the timed-entry pass"
  status: 'pending' | 'active' | 'done' | 'blocked';
  ledgerId?: string;                          // the Approvals entry this step is waiting on (if any)
}
export interface Goal extends Authored {
  id: string;
  text: string;                  // the goal, e.g. "Plan a Mount Rainier day trip for July 11"
  status: 'open' | 'active' | 'waiting' | 'done' | 'abandoned';
  nextAction?: string;           // the next concrete step, e.g. "Book the timed-entry pass"
  steps?: GoalStep[];            // the agent's plan; advances as steps apply/are approved
  category?: string;             // e.g. 'outing' | 'birthday' | 'camps' (free-form; for grouping later)
  context?: string;              // the FACTS the agent gathered (chosen date, the itinerary, decisions) so
                                 // "Continue" can resume self-sufficiently even after a reload/new session
}

// The weekly dinner plan (agentic meal planner). ONE plan per weekStart — set_meal_plan upserts by
// week (replace, not merge) so "swap Thursday to rajma" is a clean re-issue. `source` marks whether
// the family dictated the dish ('given') or the agent proposed it ('generated' — ✨ in the strip).
// Deliberately NOT calendar events (owner decision): dinners live in a Today strip + the briefing.
export interface MealPlanDay {
  date: string;                   // YYYY-MM-DD
  dish: string;                   // "Paneer butter masala"
  note?: string;                  // "we're out" / "quick — soccer night"
  source?: 'given' | 'generated';
}
export interface MealPlan extends Authored {
  id: string;
  weekStart: string;              // Monday of the week, YYYY-MM-DD — the upsert key
  days: MealPlanDay[];            // ≤7, unique dates, sorted
  status: 'active' | 'archived';
}

export interface Chore extends Authored {
  id: string;
  title: string;
  assignedTo: string;
  points: number;
  completed: boolean;
  completedCount: number; // current completions for today (e.g. 0 to timesPerDay)
  timesPerDay: number; // total target times to complete per day (1 to N)
  repeatType: 'daily' | 'weekly';
  scheduleTimeOfDay?: string; // e.g. 'Morning', 'Evening', 'End of Day'
  notes?: string;
}

export interface Reward {
  id: string;
  title: string;
  cost: number; // XP price to redeem
}

export interface Redemption {
  id: string;
  rewardTitle: string;
  cost: number;
  member: string; // kid's name (members are keyed by name across the app)
  date: string;   // ISO timestamp
}

// Per-member banked lifetime XP. Each weekly reset banks that week's earned XP here
// (then chore completedCounts are zeroed), so lifetime earnings can't be reduced by
// unchecking/deleting chores in a later week.
export interface XpBankEntry {
  member: string;
  earned: number;
}

// A synced (Google "gcal-") event the user deleted locally. We remember it so the
// next pull doesn't re-import it (the pull is a destructive rebuild). Keyed by the
// deterministic gcal- event id; title/start are stored only so the restore UI can
// show what was hidden. NOT member-keyed — must stay OUT of the member cascades.
export interface HiddenEvent {
  id: string;
  title: string;
  start: string;
}

// One entry from Google Calendar's CalendarList resource (the subset the app reads). Used to type
// the fetched `googleCalendarsList` so `accessRole` literal comparisons are checked (a typo'd role
// would otherwise silently filter the writable-calendar list to empty).
export interface GoogleCalendarListEntry {
  id: string;
  summary?: string;
  primary?: boolean;
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
  backgroundColor?: string;
  timeZone?: string;
}

export interface ConnectedCalendar {
  id: string;
  summary: string;
  accountEmail: string;
  direction: 'pull' | 'push';
  assignedTo: string;
  active: boolean;
}

// Household-level settings (one per household), synced as a single-element blob through the
// COLLECTIONS registry. Home location grounds the copilot's weather lookup (lat/lon for Open-Meteo).
// NOT member-keyed — deliberately excluded from the member rename/delete cascades.
export interface HouseholdSettings {
  homeLabel?: string;  // human-readable resolved place, e.g. "Sammamish, Washington"
  homeLat?: number;
  homeLng?: number;
  copilotName?: string; // what the family calls the copilot (kid-pickable, e.g. "Sparkles"); default "Copilot"
  // Step-up PIN for approving high-risk (physical-world / spend) concierge actions. Hashed
  // SERVER-SIDE (node crypto) — never store the raw PIN, and don't rely on client crypto.subtle
  // (unavailable over the plain-http LAN). Set/verified via /api/stepup/* in A3.
  stepUpPinHash?: string;
  stepUpPinSalt?: string;
  // Kroger cart integration — the chosen store is HOUSEHOLD config (shared), but the OAuth refresh
  // token is a per-DEVICE secret kept in localStorage (famplan_kroger_refresh), never in this shared
  // RLS collection — the exact Google-refresh-token precedent.
  // LEGACY single-store Kroger config (pre-bindings): kept so existing households keep working —
  // effectiveBindings() reads it as a 'Grocery Store' binding when storeBindings is absent.
  krogerStoreId?: string;
  krogerStoreName?: string;
  // Household-defined store lists (Phase-5): replaces the hardcoded Costco/Indian Store/Grocery/Other
  // set everywhere. Unset → constants.SHOP_STORES defaults (sanitizeStoreList is the shared gate).
  storeList?: string[];
  // LEGACY (pre-bindings): which list mapped to the single Kroger store. Superseded by storeBindings.
  krogerListStore?: string;
  // TRANSITIONAL (one release): the first bindings cut stored resolved {list → location} directly.
  // Superseded by krogerConnection + listLinks below; effectiveBindings() still reads it through.
  storeBindings?: Record<string, { locationId: string; name: string }>;
  // TWO-LEVEL retailer model (owner's design):
  // Level 1 — the CONNECTION: the Kroger API is connected once, and the physical store location is a
  // property of the connection (step 2), not of any list.
  krogerConnection?: { locationId: string; name: string };
  // Level 2 — LIST LINKS: each list may link to a connection (many lists → one connection is fine).
  // Values are retailer ids ('kroger' today; 'instacart' etc. later).
  listLinks?: Record<string, 'kroger'>;
  // Pattern-4 routines the PARENT enabled (mined from the quick-add log, surfaced as Manage toggles —
  // never silently injected). An enabled routine stages a confirm-tier draft on its weekday's digest.
  routines?: Routine[];
}

// A weekday shopping routine (Pattern-4). weekday: 0=Sun … 6=Sat. Lives in settings.routines.
export interface Routine { text: string; store?: string; weekday: number; enabled: boolean }

// A "last visited" tracker per place (venue/outing), NOT a full event history — bounded and
// concrete. Captured via the one-tap "We went" button on a past event; the server turns it into a
// HISTORY FACTS block ("days since last visit") so the copilot can favor not-recently-visited
// places. NOT member-keyed — out of the member rename/delete cascades (like settings/hiddenevents).
export interface VisitLogEntry {
  id: string;
  label: string;          // normalized place label (event.location || event.title)
  category?: Category;
  lastVisited: string;    // YYYY-MM-DD of the most recent visit
}

export interface FamilyMember {
  name: string;
  role: 'Parent' | 'Kid';
  color: string;
  userId?: string; // Supabase auth user id, set for the profile a signed-in user creates for themselves
  email?: string;  // the signed-in user's Google email — the STABLE link that survives an auth userId change
  dietary?: string;   // free-text dietary restrictions/preferences (used by the copilot for food suggestions)
  interests?: string; // free-text interests/hobbies (used by the copilot for outing/activity suggestions)
  age?: number;       // age in years — fed to the copilot/agent so it doesn't GUESS ages for activity picks
}

// Daily-briefing email opt-in (single-element blob). Read SERVER-SIDE by the digest scheduler so the
// briefing arrives with the app closed. `lastRunDate` is stamped by the server to fire at most once/day.
export interface DigestPrefs {
  enabled: boolean;
  email: string;          // legacy single recipient (kept for back-compat; merged into `emails` on read)
  emails?: string[];      // recipient list — each parent can add their own so the whole household gets the digest
  sendHour: number;       // 0–23, server-local
  lastRunDate?: string;   // YYYY-MM-DD, set by the scheduler
}

// A bill parsed from email (capability B1) and PERSISTED so the agent can read it (get_bills) without
// re-scanning Gmail. Parsed fields ONLY — the email body is never stored (the email-seam privacy contract).
export interface Bill extends Authored {
  id: string;
  payee: string;
  amount?: string;   // display string ("$84.20") — not coerced
  dueDate?: string;  // YYYY-MM-DD
  account?: string;
}

// A note/document in the Docs Library — the copilot's readable "memory". Stored as extracted TEXT
// (not a binary blob) so it rides the existing JSONB-collection plumbing and the copilot can ground
// answers on it. Binary file storage + vector RAG are a deferred upgrade.
export interface LibraryDoc extends Authored {
  id: string;
  folder: string; // grouping label (folders are the distinct folder values across docs)
  name: string;
  text: string;   // the document's contents (pasted, or read from an uploaded text file)
}
