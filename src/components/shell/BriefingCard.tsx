import { useState } from 'react';
import { useCalendar } from '../../CalendarContext';
import { useApp } from '../../AppContext';
import { apiFetch } from '../../supabase';
import { uuid } from '../../utils/uuid';
import type { Briefing } from '../../utils/briefing';
import { C, brutShadow } from './theme';

// On-demand "Preview today's briefing" (capstone §7a): the proactive Morning-Briefing agent's output,
// rendered in-app without waiting for 7am or sending an email — demoable in the anonymous demo + for a
// headless eval. Each nudge's 1-tap action stages a DRAFT (add-to-list), never a purchase.
export default function BriefingCard() {
  const { events } = useCalendar();
  const { choresList, setShoppingList, authorStamp } = useApp();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set()); // keyed by nudge INDEX — duplicate item texts must toggle independently

  const loadBriefing = async () => {
    setLoading(true); setError(null);
    try {
      const res = await apiFetch('/api/morning-briefing', {
        method: 'POST',
        body: JSON.stringify({ events, chores: choresList }),
      });
      if (!res.ok) throw new Error('briefing failed');
      setBriefing(await res.json());
    } catch {
      setError('Could not build the briefing. Try again.');
    } finally {
      setLoading(false);
    }
  };

  // 1-tap DRAFT: add the nudge's suggested item to the shopping list (never a checkout).
  const addToList = (item: string, idx: number) => {
    setShoppingList(prev => [{ id: 'shop-' + uuid(), text: item, store: 'Other', completed: false, ...authorStamp() }, ...prev]);
    setAdded(prev => new Set(prev).add(idx));
  };

  if (!briefing) {
    return (
      <button
        type="button"
        onClick={loadBriefing}
        disabled={loading}
        className="self-center rounded-[12px] px-4 py-2 text-[13px] font-extrabold"
        style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 4), background: `${C.indigo}12`, color: C.indigo, opacity: loading ? 0.6 : 1 }}
      >
        {loading ? 'Building…' : '☀️ Preview today’s briefing'}
      </button>
    );
  }

  return (
    <div className="rounded-[18px] p-4" style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigoShadow, 4), background: `${C.indigo}0a` }}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-[13px] font-extrabold" style={{ color: C.indigo }}>☀️ {briefing.title}</div>
        <button type="button" onClick={() => setBriefing(null)} className="text-[11px] font-bold" style={{ color: C.ink }}>Hide</button>
      </div>
      {error && <div className="mb-2 text-[12px] font-semibold" style={{ color: C.red }}>{error}</div>}
      {briefing.agentSummary ? (
        // ADK-concierge-authored narrative (the in-app preview is agent-generated, like the emailed digest).
        <div className="mb-2 whitespace-pre-wrap text-[13px] font-semibold" style={{ color: C.primary }}>{briefing.agentSummary}</div>
      ) : briefing.lines.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {briefing.lines.map((line, i) => (
            <div key={i} className="text-[13px] font-semibold" style={{ color: C.primary }}>{line}</div>
          ))}
        </div>
      )}
      {briefing.nudges.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {briefing.nudges.map((n, i) => (
            <div key={i} className="flex items-center gap-2 rounded-[10px] px-3 py-2" style={{ background: C.card, border: `2px solid ${C.elevated}` }}>
              <span className="min-w-0 flex-1 text-[13px] font-semibold" style={{ color: C.primary }}>{n.text}</span>
              {n.listItem && (
                <button
                  type="button"
                  onClick={() => addToList(n.listItem!, i)}
                  disabled={added.has(i)}
                  className="flex-shrink-0 rounded-[9px] px-2.5 py-1 text-[11px] font-extrabold"
                  style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo, opacity: added.has(i) ? 0.5 : 1 }}
                >
                  {added.has(i) ? 'Added' : '+ List'}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!briefing.agentSummary && briefing.lines.length === 0 && briefing.nudges.length === 0 && (
        <div className="text-[12px] font-semibold" style={{ color: C.muted }}>Nothing on the radar today — enjoy it.</div>
      )}
    </div>
  );
}
