// Manage → Groceries: the TWO-LEVEL retailer model (Phase-0 Lists-bug redesign).
//   Level 1 — CONNECTIONS: the Kroger API is connected once; the physical store location is a
//   property of the CONNECTION (the "Shop at" step-2 picker) — never of a list.
//   Level 2 — LINKED LISTS: each household list links to a connection (many lists → one connection
//   is fine). The dropdown offers CONNECTIONS, never raw store locations — the bug this replaces
//   showed Fred Meyer stores under the Costco list.
// The refresh token stays per-device in localStorage (krogerClient); connection + links are
// household settings. Store labels use the API `name` only (no chain-code prefix).
import { useEffect, useState } from 'react';
import { useApp } from '../../AppContext';
import { connectKroger, disconnectKroger, isKrogerConnected, fetchKrogerStores } from '../../utils/krogerClient';
import type { KrogerStore } from '../../utils/krogerApi';
import { C } from './theme';

export default function KrogerPanel() {
  const { krogerConnection, setKrogerConnection, setListLink, storeBindings, storeList, homeLat, homeLng } = useApp();
  const [connected, setConnected] = useState(isKrogerConnected());
  const [stores, setStores] = useState<KrogerStore[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Once connected + a home location exists, load nearby locations for the connection's step-2 picker.
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
  // Disconnect drops this DEVICE's token and the household's connection + links (sends need both).
  const onDisconnect = () => {
    disconnectKroger(); setConnected(false); setStores([]);
    setKrogerConnection(null);
  };

  const linkedLists = new Set(Object.keys(storeBindings)); // the resolved view's keys = linked lists

  return (
    <div className="rounded-[12px] p-3.5" style={{ border: `2px solid ${C.elevated}`, background: C.card }}>
      {/* ── Level 1: the connection ── */}
      <div className="mb-1 text-sm font-extrabold" style={{ color: C.primary }}>🛒 Connections</div>
      <div className="mb-2.5 text-xs" style={{ color: C.muted }}>
        Connect a retailer once, pick which store it shops at, then link lists to it below. You always
        approve before anything is added to a cart, and checkout stays in the retailer's own app.
      </div>

      {!connected ? (
        <button type="button" onClick={onConnect} disabled={busy}
          className="rounded-[9px] px-3 py-1.5 text-[13px] font-bold disabled:opacity-50"
          style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}1a`, color: C.indigo }}>
          {busy ? 'Connecting…' : 'Connect Kroger account'}
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          <div className="rounded-[10px] p-2.5" style={{ border: `2px solid ${C.elevated}`, background: C.app }}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[13px] font-extrabold" style={{ color: C.primary }}>Kroger <span className="font-semibold" style={{ color: C.emerald }}>· connected</span></span>
              <button type="button" onClick={onDisconnect}
                className="rounded-[8px] px-2.5 py-1 text-xs font-bold"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.red }}>
                Disconnect
              </button>
            </div>
            {homeLat == null && <div className="mb-1 text-xs" style={{ color: C.amber }}>Set your home location above to pick a store.</div>}
            <label className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>Shop at</span>
              <select
                value={krogerConnection?.locationId || ''}
                onChange={e => {
                  if (!e.target.value) return; // blank placeholder — no-op; only "Disconnect" clears the connection
                  const s = stores.find(x => x.locationId === e.target.value);
                  if (s) setKrogerConnection({ locationId: s.locationId, name: s.name });
                }}
                aria-label="Kroger store location for this connection"
                className="min-w-0 flex-1 max-w-[62%] rounded-[8px] px-2 py-1.5 text-sm"
                style={{ border: `2px solid ${C.elevated}`, background: C.card, color: krogerConnection ? C.primary : C.muted }}>
                <option value="">{krogerConnection && !stores.length ? krogerConnection.name : 'Select a store…'}</option>
                {stores.map(s => <option key={s.locationId} value={s.locationId}>{s.name}</option>)}
              </select>
            </label>
          </div>

          {/* ── Level 2: linked lists — dropdowns offer CONNECTIONS, never store locations ── */}
          <div className="mt-1 text-[11px] font-extrabold uppercase tracking-[0.12em]" style={{ color: C.muted }}>Linked lists</div>
          {storeList.map(list => (
            <label key={list} className="flex items-center justify-between gap-3 text-sm font-semibold" style={{ color: C.primary }}>
              <span>{list}</span>
              <select
                value={linkedLists.has(list) ? 'kroger' : ''}
                onChange={e => setListLink(list, e.target.value === 'kroger' ? 'kroger' : null)}
                aria-label={`Connection for the ${list} list`}
                disabled={!krogerConnection}
                className="min-w-0 flex-1 max-w-[62%] rounded-[8px] px-2 py-1.5 text-sm disabled:opacity-50"
                style={{ border: `2px solid ${C.elevated}`, background: C.app, color: linkedLists.has(list) ? C.primary : C.muted }}>
                <option value="">Not linked</option>
                <option value="kroger">Kroger{krogerConnection ? ` (${krogerConnection.name})` : ''}</option>
              </select>
            </label>
          ))}
          {!krogerConnection && <div className="text-xs" style={{ color: C.muted }}>Pick the connection's store above, then link lists.</div>}
        </div>
      )}
      {error && <div className="mt-2 text-xs" style={{ color: C.red }}>{error}</div>}
    </div>
  );
}
