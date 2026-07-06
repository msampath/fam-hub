// Household store lists (Phase-5 stores decoupling): the family edits the store lists their shopping
// page, quick-add, copilot and agent all route to (settings.storeList — synced household-wide).
// Guardrails: sanitizeStoreList on save (trim/dedupe/cap 8), at least ONE list always remains, and
// removing a list never deletes items — they stay visible as an "orphan" group on Shopping.
import { useState, type FormEvent } from 'react';
import { Plus, X } from 'lucide-react';
import { useApp } from '../../AppContext';
import { SHOP_STORES } from '../../constants';
import { C } from './theme';

export default function StoreListEditor() {
  const { storeList, setStoreList } = useApp();
  const [newStore, setNewStore] = useState('');

  const addStore = (e: FormEvent) => {
    e.preventDefault();
    const name = newStore.replace(/\s+/g, ' ').trim();
    if (!name) return;
    if (storeList.some(s => s.toLowerCase() === name.toLowerCase())) { setNewStore(''); return; }
    setStoreList([...storeList, name]);
    setNewStore('');
  };
  const removeStore = (name: string) => {
    if (storeList.length <= 1) return; // always keep at least one list
    setStoreList(storeList.filter(s => s !== name));
  };
  const isDefault = storeList.length === SHOP_STORES.length && storeList.every((s, i) => s === SHOP_STORES[i]);

  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold" style={{ color: C.primary }}>Store lists</span>
        {!isDefault && (
          <button type="button" onClick={() => setStoreList([...SHOP_STORES])} className="text-[11px] font-bold" style={{ color: C.muted }}>
            Reset to defaults
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {storeList.map(s => (
          <span key={s} className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold" style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}>
            {s}
            {storeList.length > 1 && (
              <button type="button" onClick={() => removeStore(s)} aria-label={`Remove the ${s} list`} style={{ color: C.ink }}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
      </div>
      <form onSubmit={addStore} className="flex gap-2">
        <input
          value={newStore}
          onChange={e => setNewStore(e.target.value)}
          placeholder="Add a store list… (e.g. Trader Joe's)"
          aria-label="Add a store list"
          maxLength={24}
          className="min-w-0 flex-1 rounded-[10px] px-3 py-2 text-sm outline-none"
          style={{ background: C.card, border: `2px solid ${C.elevated}`, color: C.primary }}
        />
        <button type="submit" className="flex items-center gap-1 rounded-[10px] px-3 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo }}>
          <Plus size={14} /> Add
        </button>
      </form>
      <div className="text-[11px] font-semibold" style={{ color: C.ink }}>
        Shopping, quick-add, and the copilot route items to these lists. Removing a list keeps its items visible until you move or clear them.
      </div>
    </div>
  );
}
