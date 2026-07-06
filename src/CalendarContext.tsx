import React, { createContext, useContext } from 'react';
import type { User } from '@supabase/supabase-js';
import type {
  CalendarEvent,
  WebSource,
  FamilyMember,
  Category,
  ConnectedCalendar,
  GoogleCalendarListEntry,
  HiddenEvent,
  VisitLogEntry,
  CopilotMessage,
  CopilotSuggestion,
  LibraryDoc,
} from './types';
import type { MonthInfo, CalendarCell } from './utils/dates';
import type { RecurringGroup } from './utils/events';

export type SyncMode = 'url' | 'text' | 'pdf' | 'google';

export interface Conflict {
  date: string;
  member: string;
  overlappingEvents: CalendarEvent[];
}

// Calendar/shell-scoped state/handlers. Kept SEPARATE from AppContext (which is for
// the cross-tab feature state) so the calendar surface doesn't bloat the app-wide
// context — per the tech-lead review. All state/effects still live in App(); this is
// just the shared read/dispatch surface the DarkShell consumes via useCalendar().
export interface CalendarCtx {
  // Shared data
  events: CalendarEvent[];
  sources: WebSource[];
  familyMembers: FamilyMember[];
  googleUser: User | null;

  // Filters / search
  activeCategoryFilter: string;
  setActiveCategoryFilter: React.Dispatch<React.SetStateAction<string>>;
  activeMemberFilter: string;
  setActiveMemberFilter: React.Dispatch<React.SetStateAction<string>>;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;

  // Import (Sync Sources: url / text / pdf)
  syncMode: SyncMode;
  setSyncMode: React.Dispatch<React.SetStateAction<SyncMode>>;
  errorStatus: string | null;
  setErrorStatus: React.Dispatch<React.SetStateAction<string | null>>;
  newUrl: string;
  setNewUrl: React.Dispatch<React.SetStateAction<string>>;
  newSourceName: string;
  setNewSourceName: React.Dispatch<React.SetStateAction<string>>;
  newUrlCategory: Category;
  setNewUrlCategory: React.Dispatch<React.SetStateAction<Category>>;
  syncAssignee: string;
  setSyncAssignee: React.Dispatch<React.SetStateAction<string>>;
  isParsing: boolean;
  parserStep: string;
  pastedText: string;
  setPastedText: React.Dispatch<React.SetStateAction<string>>;
  textSourceName: string;
  setTextSourceName: React.Dispatch<React.SetStateAction<string>>;
  textCategory: Category;
  setTextCategory: React.Dispatch<React.SetStateAction<Category>>;
  pdfCategory: Category;
  setPdfCategory: React.Dispatch<React.SetStateAction<Category>>;
  dragActive: boolean;
  setDragActive: React.Dispatch<React.SetStateAction<boolean>>;
  handleAddSource: (e: React.FormEvent) => void;
  handleTextSubmit: (e: React.FormEvent) => void;
  handlePdfUpload: (file: File) => void;
  handleDeleteSource: (id: string) => void;
  // Feed re-sync (W8): manual re-pull of every saved source (ICS/HTML) — no background polling.
  handleSyncSources: () => void;
  isSyncingSources: boolean;

  // Google Calendar sync
  cloudInviteCode: string | null;
  inviteCodeInput: string;
  setInviteCodeInput: React.Dispatch<React.SetStateAction<string>>;
  isJoiningHousehold: boolean;
  handleJoinHousehold: (e: React.FormEvent) => void;
  isFetchingCalendars: boolean;
  connectedCalendars: ConnectedCalendar[];
  googleCalendarsList: GoogleCalendarListEntry[];
  calendarSyncLogs: string[];
  setCalendarSyncLogs: React.Dispatch<React.SetStateAction<string[]>>;
  syncGoogleCalendars: (tokenOverride?: string, connsOverride?: ConnectedCalendar[], hiddenOverride?: HiddenEvent[], pullOnly?: boolean) => void;
  // Multi-parent 2-way visibility: whether the signed-in account has its OWN calendar connection, plus
  // a one-tap "connect my primary calendar" auto-offer for a parent who joined an existing household.
  hasOwnCalendarConnection: boolean;
  connectOwnCalendar: () => void;
  toggleGoogleCalendarActive: (id: string, direction: 'pull' | 'push') => void;
  removeGoogleCalendarConnection: (id: string, direction: 'pull' | 'push') => void;
  addGoogleCalendarConnection: (gCal: any, direction: 'pull' | 'push', assignedTo: string) => void;
  handleGoogleLogoutClick: () => void;

  // Manual single-event Google push (owner picks which calendars). `googlePushEvent` is the event
  // the picker is operating on (null = closed); the handler reuses the bulk-sync marker/body so a
  // re-push updates rather than duplicates. Returns a short result summary for the picker to show.
  googlePushEvent: CalendarEvent | null;
  openGooglePush: (ev: CalendarEvent) => void;
  closeGooglePush: () => void;
  isPushingEvent: boolean;
  pushEventToGoogleCalendars: (ev: CalendarEvent, calendarIds: string[]) => Promise<string>;

  // Calendar board + metrics + conflicts + recurring
  currentMonthInfo: MonthInfo;
  monthsData: MonthInfo[];
  currentMonthStep: number;
  setCurrentMonthStep: React.Dispatch<React.SetStateAction<number>>;
  calendarCells: CalendarCell[];
  DAYS_OF_WEEK: string[];
  conflicts: Conflict[];
  recurringGroups: RecurringGroup[];
  openWeekendsLeft: number;
  getEventsForDate: (dateStr: string) => CalendarEvent[];
  filterEvent: (item: CalendarEvent) => boolean;
  getEventColor: (evt: CalendarEvent) => string;
  selectedEventDetail: CalendarEvent | null;
  setSelectedEventDetail: React.Dispatch<React.SetStateAction<CalendarEvent | null>>;
  setSelectedDayToAdd: React.Dispatch<React.SetStateAction<string | null>>;
  setIsAddingEvent: React.Dispatch<React.SetStateAction<boolean>>;
  handleDeleteEvent: (id: string) => void;
  handleDeleteRecurringGroup: (group: RecurringGroup) => void;

  // Hidden (locally-deleted) synced events + restore handlers (Sync panel UI)
  hiddenEvents: HiddenEvent[];
  restoreHiddenEvent: (id: string) => void;
  restoreAllHiddenEvents: () => void;

  // Copilot
  copilotMessages: CopilotMessage[];
  isCopilotThinking: boolean;
  handleSendCopilotMessage: (textToSend?: string, opts?: { forced?: boolean }) => void;

  // Per-place visit log (HISTORY FACTS) + one-tap "We went" capture from a past event.
  visitLog: VisitLogEntry[];
  handleMarkVisited: (event: CalendarEvent) => void;

  // Override an existing event's availability classification (free/busy) or clear to auto ('').
  handleSetEventFreeBusy: (id: string, value: '' | 'busy' | 'free') => void;

  // Docs Library (the copilot's readable memory) — CRUD via the Library page.
  libraryDocs: LibraryDoc[];
  setLibraryDocs: React.Dispatch<React.SetStateAction<LibraryDoc[]>>;

  // Copilot tap-to-add suggestions: which have been added (keys) + the ＋Create handler.
  addedSuggestionKeys: Set<string>;
  handleCreateSuggestion: (s: CopilotSuggestion) => void;

  // Copilot grounding gate: whether the household has a home location set, and the inline setter the
  // copilot uses to capture one. A planning/place query is mandatory-gated on this — with no home there
  // are no real nearby venues to ground on, so the copilot captures the location before answering.
  hasHomeLocation: boolean;
  saveHomeLocation: (query: string) => Promise<{ ok: boolean; label?: string; error?: string }>;
  // Resolved home coordinates (for the dark shell's live weather card + screensaver). Undefined
  // until a home location is set.
  homeLat?: number;
  homeLng?: number;
  homeLabel?: string;
}

export const CalendarContext = createContext<CalendarCtx | null>(null);

export const useCalendar = (): CalendarCtx => {
  const ctx = useContext(CalendarContext);
  if (!ctx) throw new Error('useCalendar must be used within a CalendarContext.Provider');
  return ctx;
};
