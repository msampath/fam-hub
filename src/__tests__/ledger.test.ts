import { describe, it, expect } from 'vitest';
import { resolveLedgerEntry } from '../utils/ledger';
import type { CalendarEvent, LedgerEntry } from '../types';

const target: CalendarEvent = { id: 'e1', title: 'Soccer', start: '2026-06-20', category: 'Sports' };
const events: CalendarEvent[] = [target];

function pendingUpdate(refId: string | undefined, changes: any): LedgerEntry {
  return {
    id: 'upd-1', tool: 'update_event', riskTier: 'confirm', status: 'pending',
    summary: 'Update "Soccer"', refId, before: { title: 'Soccer', start: '2026-06-20' }, changes,
  };
}

describe('resolveLedgerEntry (confirm-tier lifecycle, durable — no pendingEventUpdates dependency)', () => {
  it('approve with a matching target → approved + applied, returns refId + changes to merge', () => {
    const res = resolveLedgerEntry(pendingUpdate('e1', { start: '2026-06-22' }), events, true);
    expect(res).toEqual({ status: 'approved', applied: true, refId: 'e1', changes: { start: '2026-06-22' } });
  });

  it('approve when the target was deleted since staging → failed, NOT a silent approved no-op', () => {
    const res = resolveLedgerEntry(pendingUpdate('e1', { start: '2026-06-22' }), [], true);
    expect(res.status).toBe('failed');
    expect(res.applied).toBe(false);
  });

  it('approve with no refId on the entry → failed', () => {
    const res = resolveLedgerEntry(pendingUpdate(undefined, { start: '2026-06-22' }), events, true);
    expect(res.status).toBe('failed');
    expect(res.applied).toBe(false);
  });

  it('approve with no changes on the entry → failed', () => {
    const res = resolveLedgerEntry(pendingUpdate('e1', undefined), events, true);
    expect(res.status).toBe('failed');
    expect(res.applied).toBe(false);
  });

  it('approve a pure DRAFT entry (reservation/cart — no refId/changes) → approved, nothing merged', () => {
    const draft: LedgerEntry = { id: 'res-1', tool: 'reserve', riskTier: 'confirm', status: 'pending', summary: 'Reserve: Cafe Flora', link: 'https://x' };
    const res = resolveLedgerEntry(draft, events, true);
    expect(res).toEqual({ status: 'approved', applied: false });
  });

  it('reject → rejected, never applies a merge (regardless of target)', () => {
    const res = resolveLedgerEntry(pendingUpdate('e1', { start: '2026-06-22' }), events, false);
    expect(res).toEqual({ status: 'rejected', applied: false });
  });

  it('is null-safe on a missing entry / non-array events', () => {
    expect(resolveLedgerEntry(undefined, events, true).status).toBe('failed');
    expect(resolveLedgerEntry(pendingUpdate('e1', { start: '2026-06-22' }), null as any, true).status).toBe('failed');
  });
});
