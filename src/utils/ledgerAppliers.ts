// Approvals-applier REGISTRY (Phase-5 stores decoupling, step 1). Every confirm-tier tool that used to
// be an inline if-block inside App.tsx's resolveLedgerUpdate is now a small, independently-testable
// applier keyed by tool name: App assembles the ctx (live collections + state effects) and dispatches.
// Adding a new approvable tool = one entry here + its tests — zero new App.tsx branches.
//
// BEHAVIOR CONTRACT (preserved exactly from the inline versions):
// - An applier fully OWNS its entry's resolution: the ledger transition goes through ctx.markLedger —
//   or the applier deliberately KEEPS the entry PENDING for a retry (push_to_google with no Push
//   calendar connected; a failed Kroger cart write) by not calling it.
// - Registry tools do NOT trigger the goal-resume hook (inline, they early-returned before it too);
//   only the generic fallthrough in App (update_event / booking drafts) advances goals.
// - User feedback goes through ctx.say (a copilot-thread assistant message).
import type { Dispatch, SetStateAction } from 'react';
import type { CalendarEvent, Chore, LedgerEntry, LibraryDoc, ShoppingItem } from '../types';
import { resolveEventDeletion } from './aiActions';
import { selectPushTargets } from './googleEvent';

export interface LedgerApplierCtx {
  entry: LedgerEntry;
  approve: boolean;
  // Live collections (read at dispatch time — victims resolve against what the parent actually sees).
  events: CalendarEvent[];
  choresList: Chore[];
  shoppingList: ShoppingItem[];
  connectedCalendars: Parameters<typeof selectPushTargets>[0];
  googleCalendarsList: Parameters<typeof selectPushTargets>[1];
  googleUserEmail?: string;
  // Effects (injected by App so appliers stay unit-testable with plain mocks).
  markLedger: (entryId: string, approve: boolean, blocked?: boolean) => void;
  say: (text: string) => void;
  setEvents: Dispatch<SetStateAction<CalendarEvent[]>>;
  setChoresList: Dispatch<SetStateAction<Chore[]>>;
  setShoppingList: Dispatch<SetStateAction<ShoppingItem[]>>;
  setLibraryDocs: Dispatch<SetStateAction<LibraryDoc[]>>;
  appendShoppingItems: (items: { text?: string; store?: string }[]) => number;
  pushEventToGoogleCalendars: (ev: CalendarEvent, targets: string[]) => Promise<unknown>;
  krogerCartAdd: (items: { upc: string; quantity?: number }[]) => Promise<number>;
}

export type LedgerApplier = (ctx: LedgerApplierCtx) => void;

// Library doc deletion (confirm-tier): on approve, remove the doc(s) by id; on reject, keep them.
// A folder-clear stages many ids in refIds; a single delete uses refId — handle both.
const deleteDocument: LedgerApplier = ({ entry, approve, markLedger, say, setLibraryDocs }) => {
  const ids = new Set([...(entry.refIds || []), ...(entry.refId ? [entry.refId] : [])]);
  if (approve && ids.size) setLibraryDocs(prev => prev.filter(d => !ids.has(d.id)));
  markLedger(entry.id, approve);
  say(approve ? `🗑️ Deleted ${(entry.summary || '').replace(/^Delete /, '') || 'the document'}.` : 'Okay, kept the document.');
};

// Proactive shopping draft (#1, confirm-tier): on approve, actually append the staged item to the
// shopping list (the morning agent stages these closed-app; they apply only on the parent's approval).
const addShoppingItem: LedgerApplier = ({ entry, approve, markLedger, say, appendShoppingItems }) => {
  let added = 0;
  if (approve && entry.payload) added = appendShoppingItems([entry.payload as { text?: string; store?: string }]);
  markLedger(entry.id, approve);
  say(approve ? (added ? `🛒 Added "${(entry.payload as { text?: string } | undefined)?.text}" to the shopping list.` : 'That item was already on the list.') : 'Okay, skipped it.');
};

// Chore delete / bulk clear (confirm-tier, destructive): resolve the target(s) against the LIVE
// chores by refId or title (clear_chores = all), then remove on approve. Resolving from the live list
// (not inside the state updater) keeps the result reliable for the confirmation message.
const deleteOrClearChores: LedgerApplier = ({ entry, approve, choresList, setChoresList, markLedger, say }) => {
  const refId = entry.refId;
  const wantTitle = String((entry.payload as { title?: string } | undefined)?.title || '').trim().toLowerCase();
  const victims = entry.tool === 'clear_chores'
    ? choresList
    : choresList.filter(c => (refId ? c.id === refId : (!!wantTitle && String(c.title).trim().toLowerCase() === wantTitle)));
  if (approve && victims.length) {
    const ids = new Set(victims.map(c => c.id));
    setChoresList(prev => prev.filter(c => !ids.has(c.id)));
  }
  markLedger(entry.id, approve);
  say(approve
    ? (victims.length
        ? (entry.tool === 'clear_chores' ? `🗑️ Cleared all ${victims.length} chore${victims.length > 1 ? 's' : ''}.` : `🗑️ Deleted ${victims.length} chore${victims.length > 1 ? 's' : ''}.`)
        : (entry.tool === 'clear_chores' ? `The chore list was already empty.` : `⚠️ Couldn't find that chore to delete.`))
    : 'Okay, kept the chores.');
};

// Event delete (confirm-tier, destructive): resolve against the LIVE events by refId, else by exact
// title (+ optional start to disambiguate same-named events), then remove on approve. A title-ONLY
// reference matching several events is NOT bulk-deleted on a single approval — the parent only saw one
// title, so the scope must never be larger than what was approved (destructive-action invariant).
const deleteEvent: LedgerApplier = ({ entry, approve, events, setEvents, markLedger, say }) => {
  const pay = (entry.payload as { title?: string; start?: string } | undefined) || {};
  const { victims, ambiguous } = resolveEventDeletion(events, { refId: entry.refId, title: pay.title, start: pay.start });
  const blocked = approve && ambiguous;
  if (approve && !ambiguous && victims.length) {
    const ids = new Set(victims.map(e => e.id));
    setEvents(prev => prev.filter(e => !ids.has(e.id)));
  }
  markLedger(entry.id, approve, blocked);
  say(!approve
    ? 'Okay, kept the event.'
    : blocked
      ? `⚠️ There are ${victims.length} events named "${victims[0].title}" — tell me which date to delete.`
      : victims.length
        ? (victims.length > 1 ? `🗑️ Deleted ${victims.length} events named "${victims[0].title}".` : `🗑️ Deleted the event "${victims[0].title}".`)
        : `⚠️ Couldn't find that event to delete.`);
};

// Shopping-item delete (confirm-tier): remove by refId or by text against the LIVE list.
const deleteShoppingItem: LedgerApplier = ({ entry, approve, shoppingList, setShoppingList, markLedger, say }) => {
  const refId = entry.refId;
  const wantText = String((entry.payload as { text?: string } | undefined)?.text || '').trim().toLowerCase();
  const victims = shoppingList.filter(i => (refId ? i.id === refId : (!!wantText && String(i.text).trim().toLowerCase() === wantText)));
  if (approve && victims.length) {
    const ids = new Set(victims.map(i => i.id));
    setShoppingList(prev => prev.filter(i => !ids.has(i.id)));
  }
  markLedger(entry.id, approve);
  say(approve
    ? (victims.length ? `🗑️ Removed ${victims.length > 1 ? `${victims.length} "${victims[0].text}" entries` : `"${victims[0].text}"`} from the shopping list.` : `⚠️ Couldn't find that item to remove.`)
    : 'Okay, kept it on the list.');
};

// Chore edit (confirm-tier): resolve the target by refId/matchTitle, merge the clamped changes.
const updateChore: LedgerApplier = ({ entry, approve, choresList, setChoresList, markLedger, say }) => {
  const ref = (entry.payload as { ref?: { id?: string; matchTitle?: string } } | undefined)?.ref || {};
  const changes = (entry.changes || {}) as Partial<Chore>;
  const wantTitle = String(ref.matchTitle || '').trim().toLowerCase();
  const target = choresList.find(c => (ref.id ? c.id === ref.id : (!!wantTitle && String(c.title).trim().toLowerCase() === wantTitle)));
  const hasChanges = Object.keys(changes).length > 0;
  if (approve && target && hasChanges) {
    setChoresList(prev => prev.map(c => {
      if (c.id !== target.id) return c;
      const merged = { ...c, ...changes };
      for (const k in changes) if ((merged as any)[k] === null) delete (merged as any)[k];
      return merged;
    }));
  }
  markLedger(entry.id, approve);
  say(approve
    ? (target ? `✏️ Updated the chore "${target.title}".` : `⚠️ Couldn't find that chore to update.`)
    : 'Okay, left the chore as is.');
};

// Push to Google (3d, confirm-tier): on approve, push the referenced event(s) to the parent's connected
// PUSH-rule calendar(s) (else the writable primary) via the existing infra. With NO push target, the
// entry deliberately stays PENDING so it can be approved again after connecting a Push calendar.
const pushToGoogle: LedgerApplier = (ctx) => {
  const { entry, approve, events, markLedger, say } = ctx;
  const ids = new Set([...(entry.refIds || []), ...(entry.refId ? [entry.refId] : [])]);
  const evs = events.filter(e => ids.has(e.id));
  if (approve) {
    const targets = selectPushTargets(ctx.connectedCalendars, ctx.googleCalendarsList, ctx.googleUserEmail);
    if (!targets.length) {
      say(`To push to Google, connect a **Push** calendar in Manage → Google sync first, then approve this again.`);
      return; // stays pending — there's no other way to re-stage it
    }
    if (evs.length) {
      for (const ev of evs) void ctx.pushEventToGoogleCalendars(ev, targets).catch(() => { /* push reports its own result/errors in the sync log */ });
      say(`📤 Pushing ${evs.length} event${evs.length > 1 ? 's' : ''} to your Google Calendar…`);
    } else {
      say(`⚠️ Those events no longer exist — nothing to push.`);
    }
  }
  markLedger(entry.id, approve);
};

// Kroger cart write (confirm-tier): on approve, add the matched products to the parent's real Kroger
// cart via the device's refresh token, then check the added items off the shopping list. On FAILURE the
// entry stays PENDING (like push_to_google) so the parent can reconnect Kroger and re-approve.
const krogerCartWrite: LedgerApplier = ({ entry, approve, markLedger, say, setShoppingList, krogerCartAdd }) => {
  if (!approve) { markLedger(entry.id, false); return; }
  const payload = entry.payload as { items?: { upc: string; quantity?: number; text?: string }[] } | undefined;
  const items = Array.isArray(payload?.items) ? payload!.items : [];
  krogerCartAdd(items.map(i => ({ upc: i.upc, quantity: i.quantity })))
    .then(added => {
      markLedger(entry.id, true);
      // Check off the shopping items that made it into the cart (match by the text we staged).
      const carted = new Set(items.map(i => String(i.text || '').trim().toLowerCase()).filter(Boolean));
      if (carted.size) setShoppingList(prev => prev.map(i => (carted.has(String(i.text).trim().toLowerCase()) ? { ...i, completed: true } : i)));
      say(`🛒 Added ${added} item${added === 1 ? '' : 's'} to your Kroger cart — open the Kroger app to check out.`);
    })
    .catch(err => {
      // Leave the entry pending; surface the reason so the parent can reconnect Kroger and re-approve.
      say(`⚠️ ${(err as Error | undefined)?.message || 'Could not update your Kroger cart.'}`);
    });
};

export const LEDGER_APPLIERS: Record<string, LedgerApplier> = {
  delete_document: deleteDocument,
  add_shopping_item: addShoppingItem,
  delete_chore: deleteOrClearChores,
  clear_chores: deleteOrClearChores,
  delete_event: deleteEvent,
  delete_shopping_item: deleteShoppingItem,
  update_chore: updateChore,
  push_to_google: pushToGoogle,
  kroger_cart_write: krogerCartWrite,
};
