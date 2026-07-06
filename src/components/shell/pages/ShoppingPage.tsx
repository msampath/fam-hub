import { useState, type FormEvent } from 'react';
import { ChefHat, Plus, Trash2, Star } from 'lucide-react';
import { useApp } from '../../../AppContext';
import { uuid } from '../../../utils/uuid';
import { exampleDish } from '../../../utils/shoppingHints';
import type { ShoppingItem } from '../../../types';
import { mergeShoppingItem } from '../../../utils/shoppingMerge';
import { C, brutShadow } from '../theme';

// Icons for the well-known default stores; any household-defined store falls back to 📦. The store
// SET itself is household-defined (settings.storeList via useApp().storeList) since Phase-5.
const STORE_ICON: Record<string, string> = { 'Costco': '🛒', 'Grocery Store': '🥦', 'Indian Store': '🌶️', 'Other': '📦' };

export default function ShoppingPage() {
  const {
    shoppingList, setShoppingList,
    newShopText, setNewShopText, newShopStore, setNewShopStore, newShopQty, setNewShopQty,
    authorStamp,
    pantryList, newPantryText, setNewPantryText, handleAddPantryItem, handleDeletePantryItem,
    recipeInput, setRecipeInput, handleParseRecipe, isParsingRecipe,
    handleSuggestRestock, isSuggestingRestock, shoppingAiError, familyMembers,
    handlePlanMeals, isPlanningMeals, mealPlan,
    handleScanPantryPhoto, isScanningPantry, pantryScan, confirmPantryScan, dismissPantryScan,
    sendShoppingToKroger, krogerBusy,
    storeBindings,
    krogerOffer, dismissKrogerOffer,
    storeList,
    kidMode,
  } = useApp();
  const [showRecipes, setShowRecipes] = useState(false);
  // Household store lists + any ORPHAN stores still on items (a list was removed in Manage while
  // items remained) — orphans render after the configured lists so nothing silently disappears.
  const STORES: { id: string; icon: string }[] = [
    ...storeList,
    ...Array.from(new Set(shoppingList.map(i => i.store).filter(s => s && !storeList.includes(s)))),
  ].map(id => ({ id, icon: STORE_ICON[id] ?? '📦' }));

  const [addNote, setAddNote] = useState<string | null>(null); // transient feedback under the add form

  const toggle = (id: string) =>
    setShoppingList(prev => prev.map(i => (i.id === id ? { ...i, completed: !i.completed } : i)));
  const deleteItem = (id: string) => setShoppingList(prev => prev.filter(i => i.id !== id));
  const toggleStaple = (id: string) => setShoppingList(prev => prev.map(i => (i.id === id ? { ...i, staple: !i.staple } : i)));
  // Clear completed items across all stores, but KEEP staples (they're recurring).
  const clearCompleted = () => setShoppingList(prev => prev.filter(i => !i.completed || i.staple));
  // Per-store Clear (always visible): empty this store's list — checked AND unchecked — but KEEP staples
  // (the recurring "don't lose these" items). Single tap, no confirm (matches the per-item delete); kid
  // mode hides it (destructive), like the other destructive taps.
  const clearStore = (store: string) =>
    setShoppingList(prev => prev.filter(i => i.store !== store || i.staple));
  // Re-add a checked-off staple = UNCHECK it in place (never a duplicate row): it becomes active again
  // and stays a starred staple. (Was a fresh-copy prepend; the merge contract makes uncheck-in-place right.)
  const reAddStaple = (item: ShoppingItem) =>
    setShoppingList(prev => prev.map(i => (i.id === item.id ? { ...i, completed: false } : i)));

  // Manual quick-add — routed through the merge contract so it NEVER duplicates: a checked-off match is
  // re-activated (unchecked), an already-active match is a no-op, else it's added.
  const addItem = (e: FormEvent) => {
    e.preventDefault();
    const text = newShopText.trim();
    if (!text) return;
    const store = storeList.includes(newShopStore) ? newShopStore : storeList[0]; // clamp a stale selection
    const incoming: ShoppingItem = {
      id: 'shop-' + uuid(), text, completed: false, store,
      quantity: newShopQty.trim() || undefined, ...authorStamp(),
    };
    const { list, outcome } = mergeShoppingItem(shoppingList, incoming);
    setShoppingList(list);
    setAddNote(outcome === 'reactivated' ? `Re-added "${text}" — it was checked off.`
      : outcome === 'exists' ? `"${text}" is already on your ${store} list.`
      : null);
    setNewShopText('');
    setNewShopQty('');
  };

  // Live suggestions: as the user types, surface EXISTING matches (checked-off first) so they re-activate
  // one instead of typing a duplicate — the "show up as a suggestion" behavior. Capped, query ≥ 2 chars.
  const q = newShopText.trim().toLowerCase();
  const suggestions = q.length >= 2
    ? [...shoppingList].sort((a, b) => Number(b.completed) - Number(a.completed))
        .filter(i => i.text.toLowerCase().includes(q)).slice(0, 3)
    : [];
  const pickSuggestion = (item: ShoppingItem) => {
    if (item.completed) { reAddStaple(item); setAddNote(`Re-added "${item.text}".`); }
    setNewShopText('');
    setNewShopQty('');
  };

  const left = shoppingList.filter(i => !i.completed).length;
  const hasCompletedNonStaple = shoppingList.some(i => i.completed && !i.staple);
  const reAddableStaples = shoppingList.filter(i => i.staple && i.completed);
  const groups = STORES
    .map(s => ({ ...s, items: shoppingList.filter(i => i.store === s.id) }))
    .filter(g => g.items.length > 0);

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-16 md:py-7">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-5">

        <div className="flex items-center justify-between gap-3">
          <div className="text-2xl font-extrabold md:text-[28px]" style={{ color: C.primary }}>Shopping</div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowRecipes(s => !s)}
              className="flex items-center gap-1.5 rounded-[10px] px-3.5 py-1.5 text-sm font-extrabold"
              style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 3), background: `${C.indigo}14`, color: C.indigo }}
            >
              <ChefHat size={15} /> Recipes
            </button>
            {/* Sends live on each BOUND list's header now (one list ↔ one store) — no global send. */}
            {!kidMode && hasCompletedNonStaple && (
              <button
                type="button"
                onClick={clearCompleted}
                className="rounded-[10px] px-3.5 py-1.5 text-sm font-bold"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
              >
                Clear done
              </button>
            )}
            <div className="rounded-[10px] px-3.5 py-1.5 text-sm font-bold" style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.muted }}>
              {left} item{left === 1 ? '' : 's'} left
            </div>
          </div>
        </div>

        {/* Kroger dish-ask auto-offer (step 5): a recipe/meal ask just added items to a BOUND list —
            offer the one-tap send to THAT list's store. The write still stages ONE confirm Approval. */}
        {!kidMode && krogerOffer && krogerOffer.texts.length > 0 && storeBindings[krogerOffer.store] && (
          <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-[14px] p-3" style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}0a` }}>
            <span className="text-[13px] font-bold" style={{ color: C.primary }}>
              🛒 Send the {krogerOffer.texts.length} {krogerOffer.store} item{krogerOffer.texts.length === 1 ? '' : 's'} you just added to your {storeBindings[krogerOffer.store].name} cart? You approve the exact cart first.
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={krogerBusy}
                onClick={() => { const b = storeBindings[krogerOffer.store]; sendShoppingToKroger(krogerOffer.texts, b.locationId, b.name); dismissKrogerOffer(); }}
                className="rounded-[10px] px-3.5 py-1.5 text-[13px] font-extrabold disabled:opacity-50"
                style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald }}
              >
                {krogerBusy ? 'Matching…' : 'Send to cart'}
              </button>
              <button
                type="button"
                onClick={dismissKrogerOffer}
                className="rounded-[10px] px-3 py-1.5 text-[13px] font-bold"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
              >
                Not now
              </button>
            </div>
          </div>
        )}

        {/* Recipe → list AI (reuses the existing recipe/restock endpoints) */}
        {showRecipes && (
          <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}0a` }}>
            <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.indigo }}>Add ingredients from a recipe</div>
            <textarea
              value={recipeInput}
              onChange={e => setRecipeInput(e.target.value)}
              placeholder={`Paste a recipe or list a dish (e.g. “${exampleDish(familyMembers)}”) — the copilot extracts the shopping items.`}
              rows={3}
              className="w-full resize-none rounded-[10px] px-3 py-2 text-sm outline-none"
              style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleParseRecipe}
                disabled={isParsingRecipe || !recipeInput.trim()}
                className="rounded-[10px] px-4 py-2 text-sm font-extrabold"
                style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo, opacity: isParsingRecipe || !recipeInput.trim() ? 0.5 : 1 }}
              >
                {isParsingRecipe ? 'Reading…' : 'Add ingredients'}
              </button>
              <button
                type="button"
                onClick={handleSuggestRestock}
                disabled={isSuggestingRestock}
                className="rounded-[10px] px-4 py-2 text-sm font-bold"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
              >
                {isSuggestingRestock ? 'Checking…' : 'Suggest restock from pantry'}
              </button>
              <button
                type="button"
                onClick={handlePlanMeals}
                disabled={isPlanningMeals}
                className="rounded-[10px] px-4 py-2 text-sm font-bold"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}
              >
                {isPlanningMeals ? 'Planning…' : '🍽 Plan meals from pantry'}
              </button>
              <label
                className={`rounded-[10px] px-4 py-2 text-sm font-bold ${isScanningPantry ? 'cursor-wait' : 'cursor-pointer'}`}
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted, opacity: isScanningPantry ? 0.6 : 1 }}
              >
                {isScanningPantry ? 'Reading photo…' : '📸 Scan pantry photo'}
                <input
                  type="file" accept="image/*" capture="environment" disabled={isScanningPantry}
                  aria-label="Scan a fridge or receipt photo"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void handleScanPantryPhoto(f); e.target.value = ''; }}
                  className="hidden"
                />
              </label>
            </div>
            {mealPlan.length > 0 && (
              <div className="mt-2 text-xs font-semibold" style={{ color: C.indigo }}>
                🍽 Planned: {mealPlan.join(', ')} — added the missing groceries to your list.
              </div>
            )}
            {/* Vision intake (#2): confirm before adding — never silent. */}
            {pantryScan && (
              <div className="mt-2.5 rounded-[12px] p-3" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}0a` }}>
                {pantryScan.newItems.length > 0 ? (
                  <>
                    <div className="mb-2 text-[12px] font-extrabold" style={{ color: C.indigo }}>
                      📸 Spotted {pantryScan.newItems.length} new item{pantryScan.newItems.length === 1 ? '' : 's'}
                      {pantryScan.known.length > 0 && <span className="font-semibold" style={{ color: C.muted }}> · {pantryScan.known.length} already stocked</span>}
                    </div>
                    <div className="mb-2.5 flex flex-wrap gap-1.5">
                      {pantryScan.newItems.map((it, i) => (
                        <span key={i} className="rounded-full px-2.5 py-1 text-[12px] font-semibold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.primary }}>{it.text}</span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <button type="button" onClick={confirmPantryScan} className="rounded-[10px] px-3.5 py-2 text-[13px] font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>Add to pantry</button>
                      <button type="button" onClick={dismissPantryScan} className="rounded-[10px] px-3.5 py-2 text-[13px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold" style={{ color: C.muted }}>📸 Everything spotted is already in your pantry.</span>
                    <button type="button" onClick={dismissPantryScan} className="rounded-[10px] px-3 py-1.5 text-[12px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}>OK</button>
                  </div>
                )}
              </div>
            )}
            {shoppingAiError && <div className="mt-2 text-xs font-semibold" style={{ color: C.red }}>{shoppingAiError}</div>}

            {/* Pantry inventory — what you keep stocked; feeds the restock suggester */}
            <div className="mt-3 pt-3" style={{ borderTop: `2px solid ${C.elevated}` }}>
              <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.muted }}>Pantry</div>
              <form onSubmit={e => { e.preventDefault(); handleAddPantryItem(); }} className="mb-2 flex gap-2">
                <input value={newPantryText} onChange={e => setNewPantryText(e.target.value)} placeholder="Add a pantry staple…" aria-label="Add pantry item" className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm outline-none" style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }} />
                <button type="submit" className="rounded-[10px] px-3 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>Add</button>
              </form>
              {pantryList.length === 0 ? (
                <div className="text-[12px] font-semibold" style={{ color: C.ink }}>No pantry items yet.</div>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {pantryList.map(p => (
                    <span key={p.id} className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold" style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}>
                      {p.text}
                      {!kidMode && <button type="button" onClick={() => handleDeletePantryItem(p.id)} aria-label={`Remove ${p.text}`} style={{ color: C.ink }}><Trash2 size={12} /></button>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Staples — one-tap re-add of checked-off recurring items */}
        {reAddableStaples.length > 0 && (
          <div className="rounded-[14px] p-3" style={{ border: `2px solid ${C.amber}40`, background: `${C.amber}0a` }}>
            <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.amber }}>Staples — one-tap re-add</div>
            <div className="flex flex-wrap gap-1.5">
              {reAddableStaples.map(item => (
                <button key={item.id} type="button" onClick={() => reAddStaple(item)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-bold" style={{ border: `2px solid ${C.amber}`, background: `${C.amber}14`, color: C.amber }}>
                  <Plus size={12} /> {item.text}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Manual quick-add (alongside the copilot) */}
        <div className="flex flex-col gap-2">
          <form onSubmit={addItem} className="flex flex-wrap items-center gap-2">
            <input
              value={newShopText}
              onChange={e => { setNewShopText(e.target.value); if (addNote) setAddNote(null); }}
              placeholder="Add an item…"
              aria-label="Add shopping item"
              className="min-w-0 flex-1 rounded-[12px] px-3.5 py-2.5 text-base font-semibold outline-none"
              style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
            />
            <input
              value={newShopQty}
              onChange={e => setNewShopQty(e.target.value)}
              placeholder="Qty"
              aria-label="Quantity"
              className="w-20 rounded-[12px] px-3 py-2.5 text-base font-semibold outline-none"
              style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
            />
            <select
              value={newShopStore}
              onChange={e => setNewShopStore(e.target.value as typeof newShopStore)}
              aria-label="Store"
              className="rounded-[12px] px-3 py-2.5 text-sm font-semibold outline-none"
              style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
            >
              {STORES.map(s => <option key={s.id} value={s.id} style={{ background: C.card }}>{s.icon} {s.id}</option>)}
            </select>
            <button type="submit" className="flex items-center gap-1.5 rounded-[12px] px-4 py-2.5 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 3), background: `${C.indigo}14`, color: C.indigo }}>
              <Plus size={16} /> Add
            </button>
          </form>
          {/* Live suggestions from what's already on the list (checked-off first) — tap to re-activate
              instead of adding a duplicate. This is what keeps a re-typed item from doubling. */}
          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => pickSuggestion(item)}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold"
                  style={{ border: `2px solid ${item.completed ? C.amber : C.elevated}`, background: item.completed ? `${C.amber}14` : C.card, color: item.completed ? C.amber : C.muted }}
                  title={item.completed ? 'Checked off — tap to re-add' : `Already on your ${item.store} list`}
                >
                  {item.completed ? '↩︎ ' : '✓ '}{item.text} · {item.store}{item.completed ? ' (done)' : ''}
                </button>
              ))}
            </div>
          )}
          {addNote && <div className="text-[12px] font-semibold" style={{ color: C.muted }}>{addNote}</div>}
        </div>

        {groups.length === 0 ? (
          <div className="rounded-[20px] px-4 py-12 text-center text-sm font-semibold" style={{ border: `2px solid ${C.elevated}`, color: C.ink }}>
            Your shopping list is empty — add an item above, or ask the copilot.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {groups.map(group => (
              <div key={group.id} className="rounded-[20px] p-5" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
                <div className="mb-3.5 flex items-center gap-2.5 pb-3 text-sm font-extrabold uppercase tracking-[0.08em]" style={{ color: C.primary, borderBottom: `2px solid ${C.elevated}` }}>
                  <span>{group.icon}</span>{group.id}
                  {/* Per-list SEND (the binding model): this list's pending items → ITS bound store. */}
                  {!kidMode && storeBindings[group.id] && group.items.some(i => !i.completed) && (
                    <button
                      type="button"
                      disabled={krogerBusy}
                      onClick={() => sendShoppingToKroger(group.items.filter(i => !i.completed).map(i => i.text), storeBindings[group.id].locationId, storeBindings[group.id].name)}
                      aria-label={`Send the ${group.id} list to ${storeBindings[group.id].name}`}
                      title={`Match this list to products at ${storeBindings[group.id].name} and stage a cart for approval`}
                      className="ml-auto rounded-[8px] px-2.5 py-1 text-[11px] font-extrabold normal-case tracking-normal disabled:opacity-50"
                      style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald }}
                    >
                      🛒 {krogerBusy ? 'Matching…' : `Send to ${storeBindings[group.id].name}`}
                    </button>
                  )}
                  {/* Per-store Clear — ALWAYS present (empties this store's list; staples stay). Kid mode hides it. */}
                  {!kidMode && group.items.some(i => !i.staple) && (
                    <button
                      type="button"
                      onClick={() => clearStore(group.id)}
                      aria-label={`Clear the ${group.id} list`}
                      className="ml-auto rounded-[8px] px-2.5 py-1 text-[11px] font-bold normal-case tracking-normal"
                      style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.muted }}
                    >
                      Clear
                    </button>
                  )}
                </div>
                {group.items.map(item => (
                  <div key={item.id} className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid #141929' }}>
                    <button
                      type="button"
                      onClick={() => toggle(item.id)}
                      aria-label={item.completed ? `Mark ${item.text} not done` : `Mark ${item.text} done`}
                      className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[7px] text-sm font-black transition-colors"
                      style={{
                        border: `2px solid ${item.completed ? C.emerald : C.elevated}`,
                        background: item.completed ? C.emerald : 'transparent',
                        color: C.app,
                      }}
                    >
                      {item.completed ? '✓' : ''}
                    </button>
                    <span
                      className="flex-1 text-sm font-semibold transition-colors"
                      style={{ color: item.completed ? C.muted : C.primary, textDecoration: item.completed ? 'line-through' : 'none' }}
                    >
                      {item.text}{item.quantity ? ` · ${item.quantity}` : ''}
                    </span>
                    <button type="button" onClick={() => toggleStaple(item.id)} title="Staple (recurring)" aria-label={item.staple ? `Unstar ${item.text}` : `Mark ${item.text} a staple`} className="flex-shrink-0">
                      <Star size={15} fill={item.staple ? C.amber : 'none'} style={{ color: item.staple ? C.amber : C.muted }} />
                    </button>
                    {/* Kid mode hides destructive taps here too (checking items off stays). */}
                    {!kidMode && <button type="button" onClick={() => deleteItem(item.id)} aria-label={`Delete ${item.text}`} className="flex-shrink-0" style={{ color: C.ink }}>
                      <Trash2 size={15} />
                    </button>}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
