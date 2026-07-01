// Pure resolution of a staged confirm-tier ledger entry (today: update_event). Given the ledger
// entry, the current events, and approve/reject, it decides the new status and what to merge — with
// NO dependency on the ephemeral in-session `pendingEventUpdates`. The ledger entry itself carries
// the durable staged change (`refId` = target event id, `changes` = validated partial), so approval
// works after a reload or on another device, and a target deleted since staging resolves to 'failed'
// rather than a silent no-op recorded as 'approved'. Kept pure → unit-testable; the App handler is
// thin glue (apply via a functional setState, transition the ledger).
import type { CalendarEvent, LedgerEntry, LedgerStatus } from '../types';

export interface LedgerResolution {
  status: LedgerStatus;                 // 'approved' | 'rejected' | 'failed'
  applied: boolean;                     // true iff the change should be merged into events
  refId?: string;                       // target event id to merge into (when applied)
  changes?: Partial<CalendarEvent>;     // the validated partial to merge (when applied)
}

export function resolveLedgerEntry(
  entry: LedgerEntry | undefined,
  events: CalendarEvent[],
  approve: boolean,
): LedgerResolution {
  if (!approve) return { status: 'rejected', applied: false };
  if (!entry) return { status: 'failed', applied: false }; // unknown/missing entry → never "approve"
  const refId = entry.refId;
  const changes = (entry.changes ?? undefined) as Partial<CalendarEvent> | undefined;
  // Pure DRAFT (reservation / Amazon cart): no event to merge — approving just acknowledges it (the
  // parent completes via the booking/cart link). Approved, nothing applied.
  if (!refId && !changes) return { status: 'approved', applied: false };
  const targetExists = !!refId && (Array.isArray(events) ? events : []).some(e => e.id === refId);
  // An update_event whose target is gone (deleted since staging) or that lacks a change set → failed,
  // never a silent success.
  if (!targetExists || !changes) return { status: 'failed', applied: false };
  return { status: 'approved', applied: true, refId, changes };
}
