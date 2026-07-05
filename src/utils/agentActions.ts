// Pure bridge: turn the cloud agent's mutating tool results into what the bar renders — an applied-count
// (auto-tier writes already persisted server-side → the caller just resyncs), staged Approve-queue ledger
// rows (confirm/stepup drafts), and a one-line summary. Untrusted: only known mutating tools become rows,
// and a draft link must be http(s) (no javascript:/data: phishing into the Approve queue). Unit-tested.
import type { AgentAction } from './agentClient';
import type { LedgerEntry, Authored, RiskTier } from '../types';
import { buildLedgerEntry } from './historyLog';
import { bookingFromFields, type BookingStub } from './aiActions';
import { USER_COMPLETES } from '../constants';

const MUTATING = new Set(['create_event', 'add_chore', 'add_shopping_item', 'update_event', 'delete_event', 'reserve', 'add_to_cart', 'move_document', 'delete_document', 'delete_chore', 'clear_chores', 'update_chore', 'delete_shopping_item', 'prepare_handoff']);
const safeLink = (u: unknown): string | undefined => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : undefined);

// Artifact shape across the mutating tools (loosely typed — the validators clamped it; we only read).
type Artifact = {
  id?: string; ids?: string[]; folder?: string; count?: number; summary?: string; link?: string; url?: string;
  title?: string; text?: string; name?: string; all?: boolean; start?: string;
  ref?: { id?: string; matchTitle?: string }; changes?: Record<string, unknown>; before?: Record<string, unknown>;
  fields?: { label?: string; value?: string }[]; booking?: BookingStub;
};

// Map a confirm/stepup tool result to the ledger-entry fields. The chore/shopping deletes & edits carry
// the reference (refId when the id is known, else payload.title/text) — the Approve flow resolves it
// against the LIVE list and applies on confirm (mirrors how delete_document removes by id on approval).
function ledgerFieldsFor(tool: string, art: Artifact, message?: string) {
  switch (tool) {
    case 'delete_document': {
      const isFolderClear = Array.isArray(art.ids) && art.ids.length > 0;
      return isFolderClear
        ? { summary: `Delete all ${art.count ?? art.ids!.length} docs in "${art.folder || 'folder'}"`, refIds: art.ids }
        : { summary: `Delete "${art.name || art.title || 'document'}"`, ...(art.id ? { refId: art.id } : {}) };
    }
    case 'delete_chore':
      return { summary: `Delete chore "${art.title || ''}"`.trim(), ...(art.id ? { refId: art.id } : { payload: { title: art.title } }) };
    case 'delete_event':
      return { summary: `Delete event "${art.title || ''}"`.trim(), ...(art.id ? { refId: art.id } : { payload: { title: art.title, start: art.start } }) };
    case 'clear_chores':
      return { summary: 'Delete ALL chores', payload: { all: true } };
    case 'delete_shopping_item':
      return { summary: `Remove "${art.text || ''}" from the shopping list`, ...(art.id ? { refId: art.id } : { payload: { text: art.text } }) };
    case 'update_chore':
      return { summary: art.ref?.matchTitle ? `Update chore "${art.ref.matchTitle}"` : 'Update a chore', payload: { ref: art.ref }, changes: art.changes };
    case 'update_event': {
      // artifact = { id, before (the full target event), changes } from buildEventUpdateFromPayload. Carry
      // refId + a before-subset (only the changing keys) + changes so approval merges them (resolveLedgerEntry).
      // Without this the default case dropped changes/refId and every agent-staged update resolved to 'failed'.
      const before: Record<string, unknown> = {};
      if (art.changes && art.before) for (const k of Object.keys(art.changes)) before[k] = (art.before as any)[k];
      return {
        summary: `Update "${(art.before as any)?.title || art.title || 'event'}"`,
        ...(art.id ? { refId: art.id } : {}),
        ...(art.before ? { before } : {}),
        ...(art.changes ? { changes: art.changes } : {}),
      };
    }
    case 'reserve':
    case 'prepare_handoff': {
      // Carry a booking stub (venue + date/time) so approving the draft can ALSO put the booking on the
      // calendar (A3 last-mile): reserve's validator already produced `booking`; a handoff carries it in its
      // gathered `fields`. Only when a real date is present — else it's just the link.
      const booking = art.booking || bookingFromFields(art.title || '', art.fields);
      return {
        // Generous clamp: a handoff summary carries the full "details to enter" list, which was being cut
        // off at 200 chars so the user couldn't see the whole ask. The card wraps freely (no CSS clamp).
        summary: String(message || art.summary || art.title || tool).slice(0, 600),
        link: safeLink(art.link) ?? safeLink(art.url),
        ...(booking ? { payload: { booking } } : {}),
      };
    }
    default:
      return { summary: String(message || art.summary || art.title || tool).slice(0, 200), link: safeLink(art.link) ?? safeLink(art.url) };
  }
}

export interface AgentActionResult { appliedCount: number; ledger: LedgerEntry[]; summary: string }

export function buildAgentActionResult(actions: AgentAction[], mkId: () => string, stamp: Authored): AgentActionResult {
  let appliedCount = 0;
  const ledger: LedgerEntry[] = [];
  for (const a of Array.isArray(actions) ? actions : []) {
    if (!a || !MUTATING.has(a.tool)) continue;          // ignore read tools / anything not a known mutator
    if (a.status === 'applied') { appliedCount++; continue; }
    if (a.status === 'requires_confirmation' || a.status === 'requires_stepup') {
      const tier: RiskTier = a.status === 'requires_stepup' ? 'stepup' : 'confirm';
      ledger.push(buildLedgerEntry(mkId(), a.tool, tier, 'pending', ledgerFieldsFor(a.tool, (a.artifact || {}) as Artifact, a.message), stamp));
    }
  }
  const parts: string[] = [];
  // "saved — refreshing…" not "applied": the write is durable server-side, but the calendar re-renders after
  // the async resync, so don't claim it's already visible.
  if (appliedCount) parts.push(`✓ ${appliedCount} change${appliedCount > 1 ? 's' : ''} saved — refreshing…`);
  // Say WHERE each draft actually lands: handoffs (USER_COMPLETES — you open & finish them) live under
  // "Actions"; agent-executed drafts live under "Approvals". One combined "review in Approve" line used to
  // mislabel handoffs.
  const actionsN = ledger.filter(e => USER_COMPLETES.has(e.tool)).length;
  const approvalsN = ledger.length - actionsN;
  if (approvalsN) parts.push(`🛎️ ${approvalsN} draft${approvalsN > 1 ? 's' : ''} staged — review in Approvals.`);
  if (actionsN) parts.push(`🛎️ ${actionsN} draft${actionsN > 1 ? 's' : ''} staged in Actions — open & complete.`);
  return { appliedCount, ledger, summary: parts.join(' ') };
}

// Honesty guard for the cloud agent's reply. The failure mode (live): the model writes "I have set up a Goal"
// / "staged two booking drafts" in its prose but never actually CALLED set_goal / prepare_handoff — so the
// family sees a confident claim with nothing behind it (empty Goals, empty Actions). We can't make the model
// call the tool, but we CAN refuse to let the claim stand: if the reply asserts (past-tense / completed) that
// it set up a goal or staged a booking, yet no matching action came back, return an honest correction to show.
// Targets COMPLETED claims only ("I have set up …", "staged two …") — a deferred "I'll set that up once…" is
// fine and must NOT trip it. Pure → unit-tested.
export function detectUnbackedClaims(reply: string, actions: AgentAction[]): string[] {
  const text = (reply || '').toLowerCase();
  const tools = new Set((Array.isArray(actions) ? actions : []).map(a => a?.tool));
  const out: string[] = [];
  const claimsGoal =
    /\b(have|i'?ve)\b[^.!?]{0,40}\b(set up|set-up|created|started|added)\b[^.!?]{0,20}\bgoal\b/.test(text) ||
    /\bset up a (new )?(multi-step )?goal\b/.test(text);
  if (claimsGoal && !tools.has('set_goal')) {
    out.push("⚠️ I mentioned setting up a tracked Goal, but it didn't actually get created — ask me to \"track this as a goal\" and I'll do it for real.");
  }
  const claimsBooking =
    /\bstaged\b[^.!?]{0,40}\b(booking|reservation|draft|pass|lodging|cart)\b/.test(text) ||
    /\b(have|i'?ve)\b[^.!?]{0,40}\b(put|added|set up|staged)\b[^.!?]{0,40}\bin (your )?(actions|approvals)\b/.test(text);
  const hasHandoff = tools.has('prepare_handoff') || tools.has('reserve') || tools.has('add_to_cart');
  if (claimsBooking && !hasHandoff) {
    out.push("⚠️ I described setting up a booking/pass for you, but nothing was actually staged in Actions — ask me to set up the booking and I'll do it for real.");
  }
  // COMPLETED-goal claim. Marking a goal/step done is a set_goal call (the goal card reflects it); narrating
  // "I marked the goal complete" / "the task is now done" WITHOUT a set_goal action is the lie a fallback model
  // told (the card never changed). Distinct from the creation claim above — this catches the UPDATE/close.
  const claimsGoalDone =
    // first-person agent claim: "I('ve) marked/updated/completed/closed the goal/step/task/trip [as] done".
    // Requires the first-person subject so a briefing's "you marked it done" / a 3rd-party report doesn't trip.
    /\b(i|i'?ve|i have)\b[^.!?]{0,15}\b(mark(ed)?|updated|completed|closed|finished)\b[^.!?]{0,30}\b(goal|step|task|trip)\b/.test(text) ||
    // goal/step REPORTED complete ("the goal is now fully complete"). NOT 'task'/'it' — a chore is a "task" and a
    // briefing saying "that task is done" must not trip this; only a real goal/step status claim does.
    /\b(goal|step)\b[^.!?]{0,30}\b(is|are|'s)\b[^.!?]{0,20}\b(now\s+)?(fully\s+)?(complete|completed|done|finished)\b/.test(text);
  if (claimsGoalDone && !tools.has('set_goal')) {
    out.push("⚠️ I said the goal/task was updated or complete, but I didn't actually change it — it still shows its real status. Ask me to update it and I'll do it for real.");
  }
  // COMPLETED-purchase claim. The agent NEVER books, reserves, or pays (no-payment invariant) — it only stages
  // DRAFTS the parent completes — so an affirmative "I booked / it's booked / fully booked / I paid" is ALWAYS a
  // false claim, whatever tool ran. Self-claims only; negations ("I haven't booked") + 2nd-person ("you book
  // it") don't match. This is the honesty backstop for the "fully planned and booked" lie a lite model told.
  const claimsCompletedPurchase =
    // first-person: "I booked / I've successfully reserved / I paid". (Negation "I haven't booked" can't match —
    // the verb must follow the subject directly, modulo an adverb.)
    /\b(i|i'?ve|i have)\s+(just\s+|now\s+|already\s+|successfully\s+)?(booked|reserved|purchased|ordered|paid for|paid)\b/.test(text) ||
    // the distinctive completion phrasing an availability note never uses ("fully planned and booked").
    /\bplanned and booked\b/.test(text) ||
    // a tracked item reported done — scoped to trip/booking/reservation/lodging so "the hotel is fully booked"
    // (a legitimate NO-availability report) doesn't trip the no-payment warning.
    /\b(your|the)\s+(trip|booking|reservation|lodging|stay|order)\b[^.!?]{0,15}\b(is|are|'s|has been|have been)\b[^.!?]{0,8}\b(now\s+)?(booked|confirmed|reserved|paid)\b/.test(text);
  if (claimsCompletedPurchase) {
    out.push("⚠️ I never book, reserve, or pay for anything — I only set up drafts you complete yourself, so nothing was actually booked. Open the link in Actions to finish it.");
  }
  return out;
}
