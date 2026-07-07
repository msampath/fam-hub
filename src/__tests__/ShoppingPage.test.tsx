// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShoppingPage from '../components/shell/pages/ShoppingPage';
import { renderWithApp } from './helpers/mockContexts';
import type { ShoppingItem } from '../types';

const item = (over: Partial<ShoppingItem> & { id: string }): ShoppingItem => ({
  text: 'Milk', completed: false, store: 'Grocery Store', ...over,
});

describe('ShoppingPage', () => {
  it('groups items by store and shows the items-left count', () => {
    renderWithApp(<ShoppingPage />, {
      shoppingList: [
        item({ id: 'c1', text: 'Paper towels', store: 'Costco' }),
        item({ id: 'g1', text: 'Bananas', store: 'Grocery Store' }),
      ],
    });
    expect(screen.getByText('Costco')).toBeInTheDocument();
    expect(screen.getByText('Grocery Store')).toBeInTheDocument();
    expect(screen.getByText('Paper towels')).toBeInTheDocument();
    expect(screen.getByText('2 items left')).toBeInTheDocument();
  });

  it('toggling an item updates the list', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'g1', text: 'Eggs' })] });
    await user.click(screen.getByLabelText(/Mark Eggs done/i));
    expect(ctx.setShoppingList).toHaveBeenCalled();
  });

  it('Recipes button reveals the recipe panel and calls handleParseRecipe', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, { recipeInput: 'chicken biryani' });
    await user.click(screen.getByText('Recipes'));
    const addBtn = screen.getByText('Add ingredients');
    expect(addBtn).toBeInTheDocument();
    await user.click(addBtn);
    expect(ctx.handleParseRecipe).toHaveBeenCalledTimes(1);
  });

  it('reveals the "Scan pantry photo" capture input in the Recipes panel (#2 vision)', async () => {
    const user = userEvent.setup();
    renderWithApp(<ShoppingPage />, {});
    await user.click(screen.getByText('Recipes'));
    const input = screen.getByLabelText('Scan a fridge or receipt photo') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'image/*');
    expect(input).toHaveAttribute('capture', 'environment');
  });

  it('confirms detected new items before adding them to the pantry (#2 vision)', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, {
      pantryScan: { newItems: [{ text: 'Butter' }, { text: 'Yogurt' }], known: [{ text: 'Milk' }] },
    });
    await user.click(screen.getByText('Recipes'));
    expect(screen.getByText('Butter')).toBeInTheDocument();
    expect(screen.getByText(/1 already stocked/)).toBeInTheDocument();
    await user.click(screen.getByText('Add to pantry'));
    expect(ctx.confirmPantryScan).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state with no items', () => {
    renderWithApp(<ShoppingPage />, { shoppingList: [] });
    expect(screen.getByText(/Your shopping list is empty/i)).toBeInTheDocument();
  });

  it('per-store Clear is ALWAYS present and empties that store (checked + unchecked), keeping staples', async () => {
    const user = userEvent.setup();
    const list = [
      item({ id: 'c1', text: 'Paper towels', store: 'Costco', completed: true }),
      item({ id: 'c2', text: 'Rice', store: 'Costco', staple: true }),          // staple stays
      item({ id: 'c3', text: 'Batteries', store: 'Costco' }),                    // UNCHECKED — still cleared
      item({ id: 'g1', text: 'Bananas', store: 'Grocery Store' }),              // other store stays
    ];
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: list });
    await user.click(screen.getByLabelText('Clear the Costco list'));
    const updater = (ctx.setShoppingList as any).mock.calls.at(-1)[0];
    expect(updater(list).map((i: ShoppingItem) => i.id)).toEqual(['c2', 'g1']); // c1 + c3 gone; staple + other store stay
  });

  it('shows per-store Clear even with nothing checked off; hides it only in kid mode / all-staple groups', () => {
    // Each render is scoped with `within(container)` — multiple renders in one test share `screen`.
    // Unchecked-only group STILL shows Clear (the always-present requirement).
    const a = renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'c3', text: 'Batteries', store: 'Costco' })] });
    expect(within(a.container).getByLabelText('Clear the Costco list')).toBeInTheDocument();
    // Kid mode → hidden (destructive).
    const b = renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'c1', text: 'Paper towels', store: 'Costco' })], kidMode: true });
    expect(within(b.container).queryByLabelText('Clear the Costco list')).not.toBeInTheDocument();
    // A group of only staples → nothing to clear, so no button.
    const c = renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'c2', text: 'Rice', store: 'Costco', staple: true })] });
    expect(within(c.container).queryByLabelText('Clear the Costco list')).not.toBeInTheDocument();
  });

  it("master Check all marks ONLY that store's items done; flips to Uncheck all and reverses", async () => {
    const user = userEvent.setup();
    const list = [
      item({ id: 'c1', text: 'Paper towels', store: 'Costco', completed: true }),
      item({ id: 'c2', text: 'Batteries', store: 'Costco' }),                    // pending → "Check all" shows
      item({ id: 'g1', text: 'Bananas', store: 'Grocery Store' }),               // other store untouched
    ];
    const a = renderWithApp(<ShoppingPage />, { shoppingList: list });
    await user.click(within(a.container).getByLabelText('Check all Costco items'));
    const checkAll = (a.ctx.setShoppingList as any).mock.calls.at(-1)[0](list);
    expect(checkAll.find((i: ShoppingItem) => i.id === 'c2').completed).toBe(true);
    expect(checkAll.find((i: ShoppingItem) => i.id === 'g1').completed).toBeFalsy(); // only Costco toggled

    // All checked → the same button reads "Uncheck all" and brings everything back.
    const done = [item({ id: 'c1', text: 'Paper towels', store: 'Costco', completed: true })];
    const b = renderWithApp(<ShoppingPage />, { shoppingList: done });
    await user.click(within(b.container).getByLabelText('Uncheck all Costco items'));
    const uncheckAll = (b.ctx.setShoppingList as any).mock.calls.at(-1)[0](done);
    expect(uncheckAll[0].completed).toBe(false);

    // Kid mode → hidden (bulk action, same rule as Clear).
    const c = renderWithApp(<ShoppingPage />, { shoppingList: list, kidMode: true });
    expect(within(c.container).queryByLabelText('Check all Costco items')).not.toBeInTheDocument();
  });

  it('an unchecked box re-checks and a checked box UN-checks (toggle both ways)', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'g1', text: 'Milk', completed: true })] });
    await user.click(screen.getByLabelText(/Mark Milk not done/i)); // the checked item's box says "not done"
    const updater = (ctx.setShoppingList as any).mock.calls.at(-1)[0];
    expect(updater([item({ id: 'g1', text: 'Milk', completed: true })])[0].completed).toBe(false);
  });

  it('re-typing a checked-off item RE-ACTIVATES it instead of duplicating', async () => {
    const user = userEvent.setup();
    const list = [item({ id: 'g1', text: 'Milk', store: 'Grocery Store', completed: true })];
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: list, newShopText: 'milk', newShopStore: 'Grocery Store' });
    await user.click(screen.getByText('Add'));
    const next = (ctx.setShoppingList as any).mock.calls.at(-1)[0]; // addItem passes the NEW list directly
    expect(next).toHaveLength(1);            // NOT duplicated
    expect(next[0].id).toBe('g1');           // same row, re-activated
    expect(next[0].completed).toBe(false);
  });

  it('surfaces a checked-off match as a tappable suggestion while typing, and re-activates it on tap', async () => {
    const user = userEvent.setup();
    const list = [item({ id: 'g1', text: 'Milk', store: 'Grocery Store', completed: true })];
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: list, newShopText: 'mil' });
    // /\(done\)/ keeps this off the item-row checkbox ("Mark Milk not done").
    const chip = screen.getByRole('button', { name: /Milk.*\(done\)/i });
    expect(chip).toBeInTheDocument();
    await user.click(chip);
    const updater = (ctx.setShoppingList as any).mock.calls.at(-1)[0]; // pickSuggestion → reAddStaple updater
    expect(updater(list)[0].completed).toBe(false);
  });

  const QFC = { locationId: '70100658', name: 'Fred Meyer - Issaquah' };

  it('dish-ask auto-offer: sends the offered texts to the BOUND store and dismisses (step 5)', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, {
      krogerOffer: { texts: ['paneer', 'butter'], store: 'Grocery Store' },
      storeBindings: { 'Grocery Store': QFC },
    });
    expect(screen.getByText(/Send the 2 Grocery Store items you just added to your Fred Meyer - Issaquah cart/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to cart' }));
    expect(ctx.sendShoppingToKroger).toHaveBeenCalledWith(['paneer', 'butter'], QFC.locationId, QFC.name);
    expect(ctx.dismissKrogerOffer).toHaveBeenCalled();
  });

  it('dish-ask auto-offer stays hidden without a binding, on dismiss, and in kid mode', async () => {
    const user = userEvent.setup();
    // Offer for a list with NO binding → no banner.
    renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'], store: 'Indian Store' }, storeBindings: { 'Grocery Store': QFC } });
    expect(screen.queryByText(/Send the/)).not.toBeInTheDocument();
    // Kid mode → hidden.
    renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'], store: 'Grocery Store' }, storeBindings: { 'Grocery Store': QFC }, kidMode: true });
    expect(screen.queryByText(/Send the/)).not.toBeInTheDocument();
    // "Not now" → dismiss only, no send.
    const { ctx } = renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'], store: 'Grocery Store' }, storeBindings: { 'Grocery Store': QFC } });
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(ctx.dismissKrogerOffer).toHaveBeenCalled();
    expect(ctx.sendShoppingToKroger).not.toHaveBeenCalled();
  });

  it('a BOUND list gets its own header Send button targeting ITS store; unbound lists get none', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, {
      shoppingList: [
        item({ id: 'g1', text: 'Milk', store: 'Grocery Store' }),
        item({ id: 'g2', text: 'Done thing', store: 'Grocery Store', completed: true }), // completed → not sent
        item({ id: 'i1', text: 'Kasuri methi', store: 'Indian Store' }),
      ],
      storeBindings: { 'Grocery Store': QFC },
    });
    expect(screen.queryByLabelText(/Send the Indian Store list/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Send the Grocery Store list to Fred Meyer - Issaquah'));
    expect(ctx.sendShoppingToKroger).toHaveBeenCalledWith(['Milk'], QFC.locationId, QFC.name); // ONLY this list's pending items
  });

  it('manually adds an item via the inline form', async () => {
    const user = userEvent.setup();
    // newShopText is context-controlled; seed it so the add guard passes.
    const { ctx } = renderWithApp(<ShoppingPage />, { newShopText: 'Eggs', newShopStore: 'Costco' });
    await user.click(screen.getByText('Add'));
    expect(ctx.setShoppingList).toHaveBeenCalled();
  });
});
