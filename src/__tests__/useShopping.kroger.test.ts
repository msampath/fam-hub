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
const setup = () => renderHook(() => useShopping({ authorStamp: () => ({}) }));

beforeEach(() => { localStorage.clear(); apiFetch.mockReset(); });

describe('useShopping — Kroger dish-ask auto-offer', () => {
  it('offers ONLY the grocery-store texts after a successful recipe parse (default store counts)', async () => {
    apiFetch.mockImplementation(() => json({ items: [
      { text: 'paneer', store: 'Indian Store' },       // stays on its list — NOT offered
      { text: 'butter', store: 'Grocery Store' },
      { text: 'tomatoes' },                            // no store → defaults to Grocery Store → offered
      { text: 'basmati rice 10lb', store: 'Costco' },  // NOT offered
    ] }));
    const { result } = setup();
    act(() => result.current.setRecipeInput('paneer butter masala'));
    await act(async () => { await result.current.handleParseRecipe(); });
    expect(result.current.krogerOffer?.texts).toEqual(['butter', 'tomatoes']);
    expect(result.current.recipeInput).toBe(''); // the ask itself still completes normally
    act(() => result.current.dismissKrogerOffer());
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
    expect(result.current.krogerOffer?.texts).toEqual(['lentils']);
    expect(result.current.mealPlan).toEqual(['Dal', 'Tacos', 'Pasta']);
  });
});
