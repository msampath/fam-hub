// @vitest-environment jsdom
// Kroger dish-ask auto-offer wiring (step 5): a successful recipe/meal ask that adds grocery-store
// items must surface a krogerOffer with EXACTLY the Kroger-carried texts (Costco/Indian Store items
// deliberately stay on their own lists), and a failed ask must not.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const apiFetch = vi.fn();
vi.mock('../supabase', () => ({ apiFetch: (...a: any[]) => apiFetch(...a) }));

import { useShopping } from '../hooks/useShopping';

const json = (body: any, ok = true) => Promise.resolve({ ok, json: () => Promise.resolve(body) });
// Bind ONLY the Grocery Store list (the owner's model: one store ↔ one list); Indian Store/Costco
// items must never be offered to it.
const setup = (boundLists: string[] = ['Grocery Store']) =>
  renderHook(() => useShopping({ authorStamp: () => ({}), boundLists }));

beforeEach(() => { localStorage.clear(); apiFetch.mockReset(); });

describe('useShopping — Kroger dish-ask auto-offer', () => {
  it('offers ONLY the bound list\'s texts after a successful recipe parse (default store counts)', async () => {
    apiFetch.mockImplementation(() => json({ items: [
      { text: 'paneer', store: 'Indian Store' },       // unbound list — NOT offered
      { text: 'butter', store: 'Grocery Store' },
      { text: 'tomatoes' },                            // no store → defaults to Grocery Store → offered
      { text: 'basmati rice 10lb', store: 'Costco' },  // unbound — NOT offered
    ] }));
    const { result } = setup();
    act(() => result.current.setRecipeInput('paneer butter masala'));
    await act(async () => { await result.current.handleParseRecipe(); });
    expect(result.current.krogerOffer).toEqual({ store: 'Grocery Store', texts: ['butter', 'tomatoes'] });
    expect(result.current.recipeInput).toBe(''); // the ask itself still completes normally
    act(() => result.current.dismissKrogerOffer());
    expect(result.current.krogerOffer).toBeNull();
  });

  it('NO offer at all when no list is bound', async () => {
    apiFetch.mockImplementation(() => json({ items: [{ text: 'butter', store: 'Grocery Store' }] }));
    const { result } = setup([]);
    act(() => result.current.setRecipeInput('toast'));
    await act(async () => { await result.current.handleParseRecipe(); });
    expect(result.current.krogerOffer).toBeNull();
  });

  it('no offer when the parse fails or adds nothing', async () => {
    apiFetch.mockImplementation(() => json({ error: 'nope' }, false));
    const { result } = setup();
    act(() => result.current.setRecipeInput('mystery dish'));
    await act(async () => { await result.current.handleParseRecipe(); });
    expect(result.current.krogerOffer).toBeNull();
    expect(result.current.shoppingAiError).toBeTruthy();
  });

  it('meal-plan path also raises the offer for its missing groceries', async () => {
    apiFetch.mockImplementation(() => json({ meals: ['Dal', 'Tacos', 'Pasta'], items: [{ text: 'lentils', store: 'Grocery Store' }] }));
    const { result } = setup();
    act(() => { result.current.setPantryList([{ id: 'p1', text: 'rice' }]); });
    await act(async () => { await result.current.handlePlanMeals(); });
    expect(result.current.krogerOffer).toEqual({ store: 'Grocery Store', texts: ['lentils'] });
    expect(result.current.mealPlan).toEqual(['Dal', 'Tacos', 'Pasta']);
  });
});
