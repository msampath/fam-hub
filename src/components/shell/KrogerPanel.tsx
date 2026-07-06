// Manage → Kroger card: connect (OAuth popup) once, then BIND stores to lists — each Kroger store
// ties to exactly ONE shopping list (the owner's real-life model), and each bound list gets its own
// per-list "Send to <store>" on the Shopping page. The refresh token lives per-device in localStorage
// (krogerClient); the bindings are household settings. Store labels use the API `name` only — the
// separate `chain` code ("FRED") is not part of the display name.
import { useEffect, useState } from 'react';
import { useApp } from '../../AppContext';
import { connectKroger, disconnectKroger, isKrogerConnected, fetchKrogerStores } from '../../utils/krogerClient';
import type { KrogerStore } from '../../utils/krogerApi';
import { C } from './theme';

export default function KrogerPanel() {
  const { storeBindings, setStoreBinding, storeList, homeLat, homeLng } = useApp();
  const [connected, setConnected] = useState(isKrogerConnected());
  const [stores, setStores] = useState<KrogerStore[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once connected + a home location exists, load nearby stores for the per-list pickers.
  useEffect(() => {
    if (!connected || homeLat == null || homeLng == null) return;
    let live = true;
    fetchKrogerStores(homeLat, homeLng).then(s => { if (live) setStores(s); }).catch(() => { if (live) setError('Could not load nearby stores.'); });
    return () => { live = false; };
  }, [connected, homeLat, homeLng]);

  const onConnect = async () => {
    setBusy(true); setError(null);
    try { await connectKroger(); setConnected(true); }
    catch (e: any) { setError(e?.message || 'Kroger connect failed.'); }
    finally { setBusy(false); }
  };
  // Disconnect drops this DEVICE's token and the household's bindings (sends are meaningless without them).
  const onDisconnect = () => {
    disconnectKroger(); setConnected(false); setStores([]);
    for (const list of Object.keys(storeBindings)) setStoreBinding(list, null);
  };

  return (
    <div className="rounded-[12px] p-3.5" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
      <div className="mb-1 text-sm font-extrabold" style={{ color: C.primary }}>🛒 Kroger cart</div>
      <div className="mb-2.5 text-xs" style={{ color: C.muted }}>
        Link a Kroger / QFC / Fred Meyer store to a shopping list — that list gets its own "Send to cart"
        button. You always approve before anything is added, and checkout stays in the Kroger app.
      </div>

      {!connected ? (
        <button type="button" onClick={onConnect} disabled={busy}
          className="rounded-[9px] px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
          style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo }}>
          {busy ? 'Connecting…' : 'Connect Kroger account'}
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {homeLat == null && <div className="text-xs" style={{ color: C.amber }}>Set your home location above to pick stores.</div>}
          {/* One binding row per household list: list → its Kroger store (or not linked). */}
          {storeList.map(list => {
            const bound = storeBindings[list];
            return (
              <label key={list} className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
                <span>{list}</span>
                <select
                  value={bound?.locationId || ''}
                  onChange={e => {
                    const s = stores.find(x => x.locationId === e.target.value);
                    setStoreBinding(list, s ? { locationId: s.locationId, name: s.name } : null);
                  }}
                  aria-label={`Kroger store for the ${list} list`}
                  className="min-w-0 flex-1 max-w-[62%] rounded-[8px] px-2 py-1.5 text-sm"
                  style={{ border: `2px solid ${C.elevated}`, background: C.app, color: bound ? C.primary : C.muted }}>
                  <option value="">{bound && !stores.length ? bound.name : 'Not linked'}</option>
                  {stores.map(s => <option key={s.locationId} value={s.locationId}>{s.name}</option>)}
                </select>
              </label>
            );
          })}
          <button type="button" onClick={onDisconnect}
            className="w-fit rounded-[8px] px-2.5 py-1 text-xs font-bold"
            style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.red }}>
            Disconnect
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs" style={{ color: C.red }}>{error}</div>}
    </div>
  );
}
