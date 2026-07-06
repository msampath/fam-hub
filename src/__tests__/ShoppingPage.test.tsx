// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
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

  it('per-store Clear removes only that store\'s completed non-staples (staples + other stores stay)', async () => {
    const user = userEvent.setup();
    const list = [
      item({ id: 'c1', text: 'Paper towels', store: 'Costco', completed: true }),
      item({ id: 'c2', text: 'Rice', store: 'Costco', completed: true, staple: true }),
      item({ id: 'c3', text: 'Batteries', store: 'Costco' }),
      item({ id: 'g1', text: 'Bananas', store: 'Grocery Store', completed: true }),
    ];
    const { ctx } = renderWithApp(<ShoppingPage />, { shoppingList: list });
    // Only groups WITH completed non-staples offer Clear: Costco (c1) and Grocery Store (g1).
    await user.click(screen.getByLabelText('Clear done items in Costco'));
    const updater = (ctx.setShoppingList as any).mock.calls.at(-1)[0];
    expect(updater(list).map((i: ShoppingItem) => i.id)).toEqual(['c2', 'c3', 'g1']); // c1 gone; staple + pending + other store stay
  });

  it('hides per-store Clear when the group has no completed non-staples (and in kid mode)', () => {
    renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'c3', text: 'Batteries', store: 'Costco' })] });
    expect(screen.queryByLabelText('Clear done items in Costco')).not.toBeInTheDocument();
    renderWithApp(<ShoppingPage />, { shoppingList: [item({ id: 'c1', text: 'Paper towels', store: 'Costco', completed: true })], kidMode: true });
    expect(screen.queryByLabelText('Clear done items in Costco')).not.toBeInTheDocument();
  });

  it('dish-ask auto-offer: sends the offered texts to Kroger and dismisses (step 5)', async () => {
    const user = userEvent.setup();
    const { ctx } = renderWithApp(<ShoppingPage />, {
      krogerOffer: { texts: ['paneer', 'butter'] }, krogerStoreName: 'QFC',
    });
    expect(screen.getByText(/Send the 2 grocery items you just added to your QFC cart/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send to cart' }));
    expect(ctx.sendShoppingToKroger).toHaveBeenCalledWith(['paneer', 'butter']);
    expect(ctx.dismissKrogerOffer).toHaveBeenCalled();
  });

  it('dish-ask auto-offer stays hidden without a connected store, on dismiss, and in kid mode', async () => {
    const user = userEvent.setup();
    // No connected store → no banner even with an offer pending.
    renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'] }, krogerStoreName: null });
    expect(screen.queryByText(/Send the/)).not.toBeInTheDocument();
    // Kid mode → hidden.
    renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'] }, krogerStoreName: 'QFC', kidMode: true });
    expect(screen.queryByText(/Send the/)).not.toBeInTheDocument();
    // "Not now" → dismiss only, no send.
    const { ctx } = renderWithApp(<ShoppingPage />, { krogerOffer: { texts: ['paneer'] }, krogerStoreName: 'QFC' });
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(ctx.dismissKrogerOffer).toHaveBeenCalled();
    expect(ctx.sendShoppingToKroger).not.toHaveBeenCalled();
  });

  it('manually adds an item via the inline form', async () => {
    const user = userEvent.setup();
    // newShopText is context-controlled; seed it so the add guard passes.
    const { ctx } = renderWithApp(<ShoppingPage />, { newShopText: 'Eggs', newShopStore: 'Costco' });
    await user.click(screen.getByText('Add'));
    expect(ctx.setShoppingList).toHaveBeenCalled();
  });
});
