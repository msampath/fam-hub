import { useState, type Dispatch, type SetStateAction } from 'react';
import { uuid } from '../utils/uuid';
import { safeParseArray } from './usePersistedCollection';
import { apiFetch } from '../supabase';
import { normalizeShoppingItems } from '../utils/aiActions';
import { aiErrorMessage } from '../utils/aiErrors';
import { fileToScanPayload } from '../utils/imagePrep';
import { diffDetectedVsPantry, type PantryDiff } from '../utils/visionPantry';
import { SHOP_STORES } from '../constants';
import type { ShoppingItem, PantryItem, Authored } from '../types';

export type ShopStore = ShoppingItem['store'];

export interface UseShoppingDeps {
  authorStamp: () => Authored;
  // Household-defined store lists (Phase-5) — already sanitized by App (never empty). Falls back to
  // the SHOP_STORES defaults when omitted (tests / pre-settings render).
  storeList?: string[];
  // Which list maps to the Kroger cart (the dish-ask auto-offer filter). Default 'Grocery Store'.
  krogerListStore?: string;
}

export interface UseShopping {
  shoppingList: ShoppingItem[]; setShoppingList: Dispatch<SetStateAction<ShoppingItem[]>>;
  newShopText: string; setNewShopText: Dispatch<SetStateAction<string>>;
  newShopStore: ShopStore; setNewShopStore: Dispatch<SetStateAction<ShopStore>>;
  newShopQty: string; setNewShopQty: Dispatch<SetStateAction<string>>;
  newShopNotes: string; setNewShopNotes: Dispatch<SetStateAction<string>>;
  pantryList: PantryItem[]; setPantryList: Dispatch<SetStateAction<PantryItem[]>>;
  newPantryText: string; setNewPantryText: Dispatch<SetStateAction<string>>;
  recipeInput: string; setRecipeInput: Dispatch<SetStateAction<string>>;
  isParsingRecipe: boolean; setIsParsingRecipe: Dispatch<SetStateAction<boolean>>;
  isSuggestingRestock: boolean; setIsSuggestingRestock: Dispatch<SetStateAction<boolean>>;
  isPlanningMeals: boolean; setIsPlanningMeals: Dispatch<SetStateAction<boolean>>;
  mealPlan: string[]; setMealPlan: Dispatch<SetStateAction<string[]>>;
  isScanningPantry: boolean;
  pantryScan: PantryDiff | null;
  handleScanPantryPhoto: (file: File) => Promise<void>;
  confirmPantryScan: () => void;
  dismissPantryScan: () => void;
  shoppingAiError: string | null; setShoppingAiError: Dispatch<SetStateAction<string | null>>;
  // Kroger dish-ask auto-offer (step 5): after a recipe/meal-plan ask adds grocery items, offer a
  // one-tap "send to cart" — the offer only; the cart write still goes through the confirm Approval.
  krogerOffer: { texts: string[] } | null;
  dismissKrogerOffer: () => void;
  appendShoppingItems: (items: { text?: string; store?: string }[]) => number;
  handleAddPantryItem: () => void;
  handleDeletePantryItem: (id: string) => void;
  handleParseRecipe: () => Promise<void>;
  handleSuggestRestock: () => Promise<void>;
  handlePlanMeals: () => Promise<void>;
}

// Shopping + pantry domain: store list state, the manual add-item form fields, pantry inventory, and
// the AI helpers (recipe→list, pantry→restock). appendShoppingItems is exposed because the copilot /
// quick-add path in App also appends shopping items through it.
export function useShopping({ authorStamp, storeList, krogerListStore }: UseShoppingDeps): UseShopping {
  const VALID_STORES = (storeList && storeList.length ? storeList : SHOP_STORES) as readonly ShopStore[];
  const krogerStoreList = krogerListStore || 'Grocery Store';

  const [shoppingList, setShoppingList] = useState<ShoppingItem[]>(() => {
    const saved = localStorage.getItem('famplan_shopping');
    return safeParseArray(saved);
  });
  const [newShopText, setNewShopText] = useState('');
  const [newShopStore, setNewShopStore] = useState<ShopStore>('Costco');
  const [newShopQty, setNewShopQty] = useState('');
  const [newShopNotes, setNewShopNotes] = useState('');

  const [pantryList, setPantryList] = useState<PantryItem[]>(() => {
    const saved = localStorage.getItem('famplan_pantry');
    return safeParseArray(saved);
  });
  const [newPantryText, setNewPantryText] = useState('');
  const [recipeInput, setRecipeInput] = useState('');
  const [isParsingRecipe, setIsParsingRecipe] = useState(false);
  const [isSuggestingRestock, setIsSuggestingRestock] = useState(false);
  const [isPlanningMeals, setIsPlanningMeals] = useState(false);
  const [mealPlan, setMealPlan] = useState<string[]>([]); // the last planned dinner names (success banner)
  const [isScanningPantry, setIsScanningPantry] = useState(false);
  const [pantryScan, setPantryScan] = useState<PantryDiff | null>(null); // detected-vs-pantry diff awaiting confirm
  const [shoppingAiError, setShoppingAiError] = useState<string | null>(null);
  // Kroger dish-ask auto-offer (step 5): the grocery-store texts the last recipe/meal ask just added.
  const [krogerOffer, setKrogerOffer] = useState<{ texts: string[] } | null>(null);
  const dismissKrogerOffer = () => setKrogerOffer(null);

  // Kroger-carried items from an AI batch — the ones on the household's Kroger-mapped list
  // (settings.krogerListStore, default 'Grocery Store'). Items routed to OTHER lists (Costco,
  // Indian Store, custom) deliberately stay on their own lists (the acceptance contract).
  const groceryTexts = (items: { text?: string; store?: string }[]) =>
    normalizeShoppingItems(items, VALID_STORES).filter(i => i.store === krogerStoreList).map(i => i.text);

  const appendShoppingItems = (items: { text?: string; store?: string }[]) => {
    const stamp = authorStamp();
    const newItems = normalizeShoppingItems(items, VALID_STORES).map(i => ({ ...i, ...stamp }));
    if (newItems.length) setShoppingList(prev => [...newItems, ...prev]);
    return newItems.length;
  };

  const handleAddPantryItem = () => {
    const t = newPantryText.trim();
    if (!t) return;
    setPantryList(prev => [{ id: 'pantry-' + uuid(), text: t }, ...prev]);
    setNewPantryText('');
  };

  const handleDeletePantryItem = (id: string) => {
    setPantryList(prev => prev.filter(p => p.id !== id));
  };

  // Recipe / dish name → ingredients → shopping list (Gemini via server).
  const handleParseRecipe = async () => {
    if (!recipeInput.trim()) return;
    setIsParsingRecipe(true);
    setShoppingAiError(null);
    try {
      const res = await apiFetch('/api/parse-recipe', { method: 'POST', body: JSON.stringify({ text: recipeInput.trim(), stores: VALID_STORES }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(res.status, body, 'Could not extract ingredients from that recipe.', 'Add the items to your list manually for now.'));
      }
      const data = await res.json();
      const added = appendShoppingItems(data.items || []);
      if (added === 0) throw new Error('No ingredients found — try a more detailed recipe or a clearer dish name.');
      setRecipeInput('');
      const carried = groceryTexts(data.items || []);
      if (carried.length) setKrogerOffer({ texts: carried });
    } catch (err: any) {
      setShoppingAiError(err.message || 'Recipe parsing failed.');
    } finally {
      setIsParsingRecipe(false);
    }
  };

  // Pantry inventory → AI restock suggestions → shopping list.
  const handleSuggestRestock = async () => {
    if (!pantryList.length) {
      setShoppingAiError('Add a few pantry items first so the assistant knows what you have.');
      return;
    }
    setIsSuggestingRestock(true);
    setShoppingAiError(null);
    try {
      const res = await apiFetch('/api/pantry-restock', {
        method: 'POST',
        body: JSON.stringify({ pantry: pantryList.map(p => p.text), recipes: shoppingList.map(s => s.text), stores: VALID_STORES }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(res.status, body, 'Could not suggest a restock list.', 'Add items to your list manually for now.'));
      }
      const data = await res.json();
      const added = appendShoppingItems(data.items || []);
      if (added === 0) throw new Error('Nothing to restock — your pantry looks well stocked.');
    } catch (err: any) {
      setShoppingAiError(err.message || 'Restock suggestion failed.');
    } finally {
      setIsSuggestingRestock(false);
    }
  };

  // Pantry → meal plan (A8): propose 3 dinners from the pantry, then stage only the missing groceries.
  const handlePlanMeals = async () => {
    if (!pantryList.length) {
      setShoppingAiError('Add a few pantry items first so the assistant can plan around them.');
      return;
    }
    setIsPlanningMeals(true);
    setShoppingAiError(null);
    setMealPlan([]);
    try {
      const res = await apiFetch('/api/meal-plan', { method: 'POST', body: JSON.stringify({ pantry: pantryList.map(p => p.text), stores: VALID_STORES }) });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(res.status, body, 'Could not plan meals from your pantry.', 'Add items to your list manually for now.'));
      }
      const data = await res.json();
      const added = appendShoppingItems(data.items || []);
      setMealPlan(Array.isArray(data.meals) ? data.meals.slice(0, 3) : []);
      const carried = added > 0 ? groceryTexts(data.items || []) : [];
      if (carried.length) setKrogerOffer({ texts: carried });
    } catch (err: any) {
      setShoppingAiError(err.message || 'Meal planning failed.');
    } finally {
      setIsPlanningMeals(false);
    }
  };

  // Vision intake (#2): a fridge/receipt photo → detected groceries → diff vs pantry → confirm → pantry.
  const handleScanPantryPhoto = async (file: File) => {
    setIsScanningPantry(true);
    setShoppingAiError(null);
    setPantryScan(null);
    try {
      const payload = await fileToScanPayload(file);
      const res = await apiFetch('/api/vision-scan-pantry', {
        method: 'POST',
        body: JSON.stringify({ ...payload, pantry: pantryList.map(p => p.text), stores: VALID_STORES }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(aiErrorMessage(res.status, body, 'Could not read that photo.', 'Try a clearer, closer shot.'));
      }
      const data = await res.json();
      const diff = diffDetectedVsPantry(data.detected || [], pantryList);
      if (!diff.newItems.length && !diff.known.length) throw new Error('No grocery items spotted — try a clearer photo.');
      setPantryScan(diff);
    } catch (err: any) {
      setShoppingAiError(err.message || 'Photo scan failed.');
    } finally {
      setIsScanningPantry(false);
    }
  };
  const confirmPantryScan = () => {
    if (!pantryScan?.newItems.length) { setPantryScan(null); return; }
    const additions: PantryItem[] = pantryScan.newItems.map(i => ({ id: 'pantry-' + uuid(), text: i.text }));
    setPantryList(prev => [...additions, ...prev]);
    setPantryScan(null);
  };
  const dismissPantryScan = () => setPantryScan(null);

  return {
    shoppingList, setShoppingList,
    newShopText, setNewShopText,
    newShopStore, setNewShopStore,
    newShopQty, setNewShopQty,
    newShopNotes, setNewShopNotes,
    pantryList, setPantryList,
    newPantryText, setNewPantryText,
    recipeInput, setRecipeInput,
    isParsingRecipe, setIsParsingRecipe,
    isSuggestingRestock, setIsSuggestingRestock,
    isPlanningMeals, setIsPlanningMeals,
    mealPlan, setMealPlan,
    isScanningPantry, pantryScan, handleScanPantryPhoto, confirmPantryScan, dismissPantryScan,
    shoppingAiError, setShoppingAiError,
    krogerOffer, dismissKrogerOffer,
    appendShoppingItems,
    handleAddPantryItem,
    handleDeletePantryItem,
    handleParseRecipe,
    handleSuggestRestock,
    handlePlanMeals,
  };
}
