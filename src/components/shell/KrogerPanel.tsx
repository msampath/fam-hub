// Manage → Kroger connect card. Connect (OAuth popup), pick a nearby store, disconnect. Pattern
// mirrors the Google sync panel; the refresh token lives per-device in localStorage (krogerClient),
// the chosen store in household settings. Rendered only when the server has Kroger configured — the
// connect call surfaces a clear message otherwise.
import { useEffect, useState } from 'react';
import { useApp } from '../../AppContext';
import { connectKroger, disconnectKroger, isKrogerConnected, fetchKrogerStores } from '../../utils/krogerClient';
import type { KrogerStore } from '../../utils/krogerApi';
import { C } from './theme';

export default function KrogerPanel() {
  const { krogerStoreId, krogerStoreName, setKrogerStore, homeLat, homeLng } = useApp();
  const [connected, setConnected] = useState(isKrogerConnected());
  const [stores, setStores] = useState<KrogerStore[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once connected + a home location exists, load nearby stores for the picker.
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
  const onDisconnect = () => { disconnectKroger(); setConnected(false); setKrogerStore(null, null); setStores([]); };

  return (
    <div className="rounded-[12px] p-3.5" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
      <div className="mb-1 text-sm font-extrabold" style={{ color: C.primary }}>🛒 Kroger cart</div>
      <div className="mb-2.5 text-xs" style={{ color: C.muted }}>
        Send your shopping list straight to a real Kroger, QFC, or Fred Meyer cart — you always approve before it's added, and checkout stays in the Kroger app.
      </div>

      {!connected ? (
        <button type="button" onClick={onConnect} disabled={busy}
          className="rounded-[9px] px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
          style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo }}>
          {busy ? 'Connecting…' : 'Connect Kroger account'}
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {homeLat == null && <div className="text-xs" style={{ color: C.amber }}>Set your home location above to pick a store.</div>}
          <label className="flex items-center justify-between gap-3 text-sm font-semibold">
            <span>Store</span>
            <select
              value={krogerStoreId || ''}
              onChange={e => { const s = stores.find(x => x.locationId === e.target.value); setKrogerStore(s?.locationId || null, s ? `${s.chain} ${s.name}` : null); }}
              className="min-w-0 flex-1 max-w-[62%] rounded-[8px] px-2 py-1.5 text-sm"
              style={{ border: `2px solid ${C.elevated}`, background: C.app, color: C.primary }}>
              <option value="">{krogerStoreName || 'Select a store…'}</option>
              {stores.map(s => <option key={s.locationId} value={s.locationId}>{s.chain} — {s.name}</option>)}
            </select>
          </label>
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
