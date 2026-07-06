// The Approvals-applier registry: every confirm-tier tool's apply logic, unit-tested directly with a
// mock ctx (this is exactly what the inline-in-App version could never do). Behavior contract per
// applier: resolves via markLedger (or deliberately keeps the entry PENDING), narrates via say.
import { describe, it, expect, vi } from 'vitest';
import { LEDGER_APPLIERS, type LedgerApplierCtx } from '../utils/ledgerAppliers';
import type { LedgerEntry } from '../types';

const entry = (over: Partial<LedgerEntry> & { tool: string }): LedgerEntry =>
  ({ id: 'led-1', riskTier: 'confirm', status: 'pending', summary: 's', ...over } as LedgerEntry);

function ctx(over: Partial<LedgerApplierCtx> = {}): LedgerApplierCtx {
  return {
    entry: entry({ tool: 'noop' }),
    approve: true,
    events: [], choresList: [], shoppingList: [],
    connectedCalendars: [], googleCalendarsList: [], googleUserEmail: undefined,
    markLedger: vi.fn(), say: vi.fn(),
    setEvents: vi.fn(), setChoresList: vi.fn(), setShoppingList: vi.fn(), setLibraryDocs: vi.fn(),
    appendShoppingItems: vi.fn(() => 1),
    pushEventToGoogleCalendars: vi.fn(async () => ''),
    krogerCartAdd: vi.fn(async () => 2),
    ...over,
  };
}

// Run a state-updater captured by a vi.fn() setter against a prev value.
const runUpdater = (setter: any, prev: any) => setter.mock.calls.at(-1)[0](prev);

describe('LEDGER_APPLIERS registry', () => {
  it('covers exactly the tools App used to special-case inline', () => {
    expect(Object.keys(LEDGER_APPLIERS).sort()).toEqual([
      'add_shopping_item', 'clear_chores', 'delete_chore', 'delete_document',
      'delete_event', 'delete_shopping_item', 'kroger_cart_write', 'push_to_google', 'update_chore',
    ]);
  });

  it('delete_document removes refIds + refId on approve; keeps on reject', () => {
    const c = ctx({ entry: entry({ tool: 'delete_document', refId: 'd1', refIds: ['d2'] }) });
    LEDGER_APPLIERS.delete_document(c);
    const kept = runUpdater(c.setLibraryDocs, [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }]);
    expect(kept.map((d: any) => d.id)).toEqual(['d3']);
    expect(c.markLedger).toHaveBeenCalledWith('led-1', true);
    const r = ctx({ approve: false, entry: entry({ tool: 'delete_document', refId: 'd1' }) });
    LEDGER_APPLIERS.delete_document(r);
    expect(r.setLibraryDocs).not.toHaveBeenCalled();
    expect(r.say).toHaveBeenCalledWith('Okay, kept the document.');
  });

  it('add_shopping_item appends only on approve and narrates the already-there case', () => {
    const c = ctx({ entry: entry({ tool: 'add_shopping_item', payload: { text: 'Umbrella', store: 'Other' } }) });
    LEDGER_APPLIERS.add_shopping_item(c);
    expect(c.appendShoppingItems).toHaveBeenCalledWith([{ text: 'Umbrella', store: 'Other' }]);
    const dup = ctx({ appendShoppingItems: vi.fn(() => 0), entry: entry({ tool: 'add_shopping_item', payload: { text: 'Milk' } }) });
    LEDGER_APPLIERS.add_shopping_item(dup);
    expect(dup.say).toHaveBeenCalledWith('That item was already on the list.');
  });

  it('delete_chore targets by refId or title; clear_chores wipes all; both keep on reject', () => {
    const chores = [{ id: 'c1', title: 'Feed dog' }, { id: 'c2', title: 'Dishes' }] as any;
    const byTitle = ctx({ choresList: chores, entry: entry({ tool: 'delete_chore', payload: { title: 'dishes' } }) });
    LEDGER_APPLIERS.delete_chore(byTitle);
    expect(runUpdater(byTitle.setChoresList, chores).map((c: any) => c.id)).toEqual(['c1']);
    const clearAll = ctx({ choresList: chores, entry: entry({ tool: 'clear_chores' }) });
    LEDGER_APPLIERS.clear_chores(clearAll);
    expect(runUpdater(clearAll.setChoresList, chores)).toEqual([]);
    expect(clearAll.say).toHaveBeenCalledWith('🗑️ Cleared all 2 chores.');
  });

  it('delete_event BLOCKS an ambiguous title-only match (marks rejected via blocked, deletes nothing)', () => {
    const events = [
      { id: 'e1', title: 'Soccer practice', start: '2026-07-08' },
      { id: 'e2', title: 'Soccer practice', start: '2026-07-15' },
    ] as any;
    const c = ctx({ events, entry: entry({ tool: 'delete_event', payload: { title: 'Soccer practice' } }) });
    LEDGER_APPLIERS.delete_event(c);
    expect(c.setEvents).not.toHaveBeenCalled();
    expect(c.markLedger).toHaveBeenCalledWith('led-1', true, true); // blocked
    expect(String((c.say as any).mock.calls[0][0])).toMatch(/2 events named/);
    // Disambiguated by start → deletes exactly one.
    const ok = ctx({ events, entry: entry({ tool: 'delete_event', payload: { title: 'Soccer practice', start: '2026-07-15' } }) });
    LEDGER_APPLIERS.delete_event(ok);
    expect(runUpdater(ok.setEvents, events).map((e: any) => e.id)).toEqual(['e1']);
  });

  it('push_to_google with NO push target keeps the entry PENDING (no markLedger call)', () => {
    const c = ctx({
      events: [{ id: 'e1', title: 'Zoo', start: '2026-07-08' }] as any,
      entry: entry({ tool: 'push_to_google', refId: 'e1' }),
    });
    LEDGER_APPLIERS.push_to_google(c);
    expect(c.markLedger).not.toHaveBeenCalled();
    expect(String((c.say as any).mock.calls[0][0])).toMatch(/connect a \*\*Push\*\* calendar/);
  });

  it('push_to_google pushes each referenced event to the selected targets and resolves', () => {
    const c = ctx({
      events: [{ id: 'e1', title: 'Zoo', start: '2026-07-08' }] as any,
      connectedCalendars: [{ id: 'cal-push', direction: 'push', active: true }],
      googleCalendarsList: [{ id: 'cal-push', accessRole: 'owner' }],
      entry: entry({ tool: 'push_to_google', refId: 'e1' }),
    });
    LEDGER_APPLIERS.push_to_google(c);
    expect(c.pushEventToGoogleCalendars).toHaveBeenCalledTimes(1);
    expect(c.markLedger).toHaveBeenCalledWith('led-1', true);
  });

  it('kroger_cart_write: success resolves + checks carted items off; failure keeps PENDING', async () => {
    const shopping = [{ id: 's1', text: 'paneer', completed: false }, { id: 's2', text: 'bread', completed: false }] as any;
    const c = ctx({ entry: entry({ tool: 'kroger_cart_write', payload: { items: [{ upc: '0001', quantity: 1, text: 'paneer' }] } }) });
    LEDGER_APPLIERS.kroger_cart_write(c);
    await vi.waitFor(() => expect(c.markLedger).toHaveBeenCalledWith('led-1', true));
    expect(c.krogerCartAdd).toHaveBeenCalledWith([{ upc: '0001', quantity: 1 }]);
    const after = runUpdater(c.setShoppingList, shopping);
    expect(after.find((i: any) => i.id === 's1').completed).toBe(true);
    expect(after.find((i: any) => i.id === 's2').completed).toBe(false);

    const fail = ctx({
      krogerCartAdd: vi.fn(async () => { throw new Error('Kroger is not connected on this device.'); }),
      entry: entry({ tool: 'kroger_cart_write', payload: { items: [{ upc: '0001', text: 'paneer' }] } }),
    });
    LEDGER_APPLIERS.kroger_cart_write(fail);
    await vi.waitFor(() => expect(fail.say).toHaveBeenCalled());
    expect(fail.markLedger).not.toHaveBeenCalled(); // stays pending for reconnect + re-approve
    const reject = ctx({ approve: false, entry: entry({ tool: 'kroger_cart_write' }) });
    LEDGER_APPLIERS.kroger_cart_write(reject);
    expect(reject.markLedger).toHaveBeenCalledWith('led-1', false);
    expect(reject.krogerCartAdd).not.toHaveBeenCalled();
  });

  it('update_chore merges changes into the matched chore only', () => {
    const chores = [{ id: 'c1', title: 'Feed dog', points: 5 }] as any;
    const c = ctx({ choresList: chores, entry: entry({ tool: 'update_chore', payload: { ref: { matchTitle: 'feed dog' } }, changes: { points: 10 } as any }) });
    LEDGER_APPLIERS.update_chore(c);
    expect(runUpdater(c.setChoresList, chores)[0].points).toBe(10);
    expect(c.say).toHaveBeenCalledWith('✏️ Updated the chore "Feed dog".');
  });
});
