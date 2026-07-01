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

  it('manually adds an item via the inline form', async () => {
    const user = userEvent.setup();
    // newShopText is context-controlled; seed it so the add guard passes.
    const { ctx } = renderWithApp(<ShoppingPage />, { newShopText: 'Eggs', newShopStore: 'Costco' });
    await user.click(screen.getByText('Add'));
    expect(ctx.setShoppingList).toHaveBeenCalled();
  });
});
