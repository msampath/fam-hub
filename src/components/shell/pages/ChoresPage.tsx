import { useState, useEffect, type CSSProperties, type FormEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useApp } from '../../../AppContext';
import { choreEmoji, earnedXp, lifetimeEarnedXp } from '../../../utils/chores';
import { uuid } from '../../../utils/uuid';
import type { Chore } from '../../../types';
import { C, brutShadow, memberHex } from '../theme';
import { useRollingXp } from '../useRollingXp';

const SLOTS: { key: string; label: string; emoji: string }[] = [
  { key: 'Morning', label: 'Morning', emoji: '☀️' },
  { key: 'Afternoon', label: 'Afternoon', emoji: '⛅' },
  { key: 'Evening', label: 'Evening', emoji: '🌙' },
  { key: 'Anytime', label: 'Anytime', emoji: '⭐' },
];

// Which time-of-day bucket a chore belongs to (exactly one — for the break-out sections).
function bucketOf(c: Chore): string {
  const s = (c.scheduleTimeOfDay || '').toLowerCase();
  if (s.includes('morning')) return 'Morning';
  if (s.includes('afternoon')) return 'Afternoon';
  if (s.includes('evening')) return 'Evening';
  return 'Anytime';
}

export default function ChoresPage() {
  const {
    choresList, setChoresList, familyMembers, authorStamp,
    xpBankList, kidMode,
    setIsGeneratingChoresOpen,
  } = useApp();

  const kids = familyMembers.filter(m => m.role === 'Kid');
  const [activeKid, setActiveKid] = useState(0);
  const [newChoreTitle, setNewChoreTitle] = useState('');
  const [newChoreAssigned, setNewChoreAssigned] = useState(kids[0]?.name ?? '');
  const [newChorePoints, setNewChorePoints] = useState(10);
  const [newChoreTimesPerDay, setNewChoreTimesPerDay] = useState(1);
  const [newChoreRepeatType, setNewChoreRepeatType] = useState<'daily' | 'weekly'>('daily');
  const [newChoreScheduleTime, setNewChoreScheduleTime] = useState('Morning');
  const [justChecked, setJustChecked] = useState<string | null>(null);
  // Chore id whose LAST slot was just checked — drives the confetti celebration burst on that card.
  const [justCompleted, setJustCompleted] = useState<string | null>(null);
  const [showAddChore, setShowAddChore] = useState(false);
  const [addMsg, setAddMsg] = useState<string | null>(null);

  useEffect(() => {
    const kidNames = kids.map(m => m.name);
    if (kidNames.length > 0 && !kidNames.includes(newChoreAssigned)) setNewChoreAssigned(kidNames[0]);
  }, [familyMembers, newChoreAssigned]);

  const openAddChore = (kidName: string) => { setNewChoreAssigned(kidName); setShowAddChore(true); setAddMsg(null); };
  const handleAddChore = (e: FormEvent) => {
    e.preventDefault();
    const title = newChoreTitle.trim();
    if (!title || !newChoreAssigned) return;
    // No duplicate chores (#1): same title for the same kid, regardless of time-of-day slot.
    const dup = choresList.some(c => c.assignedTo === newChoreAssigned && c.title.trim().toLowerCase() === title.toLowerCase());
    if (dup) { setAddMsg(`"${title}" is already on ${newChoreAssigned}'s list.`); return; }
    setAddMsg(null);
    const chore: Chore = {
      id: 'chore-' + uuid(), title, assignedTo: newChoreAssigned,
      points: newChorePoints, completed: false, completedCount: 0,
      timesPerDay: newChoreTimesPerDay, repeatType: newChoreRepeatType,
      scheduleTimeOfDay: newChoreScheduleTime, ...authorStamp(),
    };
    setChoresList(prev => [...prev, chore]);
    // Full reset so a reopened form doesn't inherit the prior chore's values.
    setNewChoreTitle('');
    setNewChorePoints(10);
    setNewChoreTimesPerDay(1);
    setNewChoreRepeatType('daily');
    setNewChoreScheduleTime('Morning');
    setShowAddChore(false);
  };

  const display = useRollingXp(Object.fromEntries(kids.map(k => [k.name, earnedXp(choresList, k.name)])));

  // Deleting is destructive and irreversible — confirm first (small fingers tap fast; same guard
  // pattern as handleRedeemReward in useChores).
  const deleteChore = (id: string) => {
    const chore = choresList.find(c => c.id === id);
    if (!window.confirm(`Delete "${chore?.title ?? 'this chore'}"?`)) return;
    setChoresList(prev => prev.filter(c => c.id !== id));
  };

  const toggleSlot = (choreId: string, slotIdx: number) => {
    // Read completion off the CURRENT list (not inside the updater — updaters must stay pure):
    // checking the last open slot completes the chore → fire the celebration burst on that card.
    const cur = choresList.find(c => c.id === choreId);
    const wasComplete = !!cur && (cur.completedCount ?? 0) >= (cur.timesPerDay || 1);
    const completesNow = !!cur && !wasComplete && slotIdx >= (cur.completedCount ?? 0) && slotIdx + 1 >= (cur.timesPerDay || 1);
    setChoresList(prev => prev.map(c => {
      if (c.id !== choreId) return c;
      const isSlotCompleted = slotIdx < (c.completedCount ?? 0);
      const newCount = isSlotCompleted ? slotIdx : slotIdx + 1;
      return { ...c, completedCount: newCount, completed: newCount >= (c.timesPerDay ?? 1) };
    }));
    const tag = `${choreId}_${slotIdx}`;
    setJustChecked(tag);
    setTimeout(() => setJustChecked(j => (j === tag ? null : j)), 650);
    if (completesNow) {
      setJustCompleted(choreId);
      setTimeout(() => setJustCompleted(j => (j === choreId ? null : j)), 900);
    }
  };

  // Confetti burst pieces (celebration on completing a chore's last slot). Scatter vectors + colors
  // are inline per piece; the shared shape/animation is `.confetti-piece` in index.css (and hidden
  // entirely under prefers-reduced-motion there).
  const CONFETTI_COLORS = [C.emerald, C.amber, C.indigo, '#f472b6'];
  const confettiBurst = (
    <div aria-hidden data-testid="confetti-burst">
      {Array.from({ length: 8 }).map((_, i) => {
        const angle = (i / 8) * Math.PI * 2;
        const dist = 46 + (i % 3) * 16;
        return (
          <span
            key={i}
            className="confetti-piece"
            style={{
              '--dx': `${Math.round(Math.cos(angle) * dist)}px`,
              '--dy': `${Math.round(Math.sin(angle) * dist - 24)}px`,
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${(i % 4) * 40}ms`,
            } as CSSProperties}
          />
        );
      })}
    </div>
  );

  if (kids.length === 0) {
    return (
      <div className="h-full overflow-y-auto px-4 py-6 md:px-16 md:py-6">
        <div className="mx-auto max-w-[1120px] rounded-[18px] px-4 py-10 text-center text-sm font-semibold" style={{ border: `2px solid ${C.elevated}`, color: C.ink }}>
          Add a family member with the “Kid” role (in Manage) to start tracking chores.
        </div>
      </div>
    );
  }

  const idx = Math.min(activeKid, kids.length - 1);
  const kid = kids[idx];
  const accent = memberHex(kid.color);

  const all = choresList.filter(c => c.assignedTo === kid.name);
  const total = all.reduce((a, c) => a + (c.points || 0), 0);
  const earned = earnedXp(choresList, kid.name);
  const totalXp = lifetimeEarnedXp(xpBankList, choresList, kid.name);
  const doneCount = all.filter(c => (c.completedCount ?? 0) >= (c.timesPerDay || 1)).length;
  const pct = total > 0 ? Math.round((earned / total) * 100) : 0;
  const todayXp = display[kid.name] ?? earned;
  const sections = SLOTS.map(s => ({ ...s, chores: all.filter(c => bucketOf(c) === s.key) })).filter(s => s.chores.length > 0);

  const choreCard = (chore: Chore) => {
    const isComplete = (chore.completedCount ?? 0) >= (chore.timesPerDay || 1);
    return (
      <div
        key={chore.id}
        className="relative rounded-[18px] px-4 py-3.5"
        style={isComplete
          ? { border: `2px solid ${C.emerald}`, background: 'rgba(52,211,153,0.05)' }
          : { border: `2px solid ${accent}`, boxShadow: brutShadow(accent, 5), background: C.card }}
      >
        {justCompleted === chore.id && confettiBurst}
        <div className="mb-3 flex items-start justify-between">
          <div
            className="flex flex-1 items-center gap-2.5 pr-2.5 text-lg font-extrabold leading-tight"
            style={{ color: isComplete ? C.muted : C.primary, textDecoration: isComplete ? 'line-through' : 'none', opacity: isComplete ? 0.55 : 1 }}
          >
            {/* Picture-first for pre-readers (kid mode targets age 4+) — pure title→emoji map. */}
            <span aria-hidden className="text-2xl leading-none">{choreEmoji(chore.title)}</span>
            <span>{chore.title}</span>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <div className="whitespace-nowrap rounded-[9px] px-2.5 py-1 text-xs font-extrabold" style={{ color: C.amber, background: `${C.amber}1a`, border: `1.5px solid ${C.amber}38` }}>
              +{chore.points} XP
            </div>
            {/* Hidden in kid mode; 44px target + confirm otherwise (deleting is the one irreversible tap here). */}
            {!kidMode && (
              <button type="button" onClick={() => deleteChore(chore.id)} aria-label={`Delete ${chore.title}`} className="flex h-11 w-11 flex-shrink-0 items-center justify-center" style={{ color: C.ink }}><Trash2 size={16} /></button>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {Array.from({ length: chore.timesPerDay || 1 }).map((_, i) => {
            const done = i < (chore.completedCount ?? 0);
            const popping = justChecked === `${chore.id}_${i}`;
            return (
              <button
                key={i}
                type="button"
                role="checkbox"
                aria-checked={done}
                aria-label={`${chore.title}${chore.timesPerDay > 1 ? ` (${i + 1})` : ''}`}
                onClick={() => toggleSlot(chore.id, i)}
                className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl px-1.5 py-2 text-xs font-bold transition-colors"
                style={{
                  border: `2px solid ${done ? C.emerald : C.elevated}`,
                  background: done ? 'rgba(52,211,153,0.18)' : 'transparent',
                  color: done ? C.emerald : C.muted,
                  animation: popping ? 'checkPop 0.38s ease forwards' : 'none',
                }}
              >
                <span className="text-sm">{done ? '✓' : '○'}</span>
                <span>{done ? 'Done' : (chore.timesPerDay > 1 ? `#${i + 1}` : 'Mark')}</span>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 md:px-16 md:py-6">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-4">

        {/* Member pills (person + level) */}
        <div className="flex flex-wrap justify-center gap-2.5">
          {kids.map((k, i) => {
            const on = idx === i;
            const a = memberHex(k.color);
            const level = Math.floor(lifetimeEarnedXp(xpBankList, choresList, k.name) / 100) + 1;
            return (
              <button
                key={k.name}
                type="button"
                onClick={() => setActiveKid(i)}
                className="flex items-center gap-2 rounded-full px-5 py-2 text-xs font-extrabold uppercase tracking-wide"
                style={on
                  ? { border: `2px solid ${a}`, boxShadow: brutShadow(a, 4), background: `${a}1a`, color: a }
                  : { border: `2px solid ${C.elevated}`, background: 'transparent', color: C.ink }}
              >
                {k.name}
                <span className="rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: on ? `${a}26` : C.elevated, color: on ? a : C.muted }}>Lv {level}</span>
              </button>
            );
          })}
        </div>

        {/* Add chore (manual, alongside the copilot) — assignee = the selected kid.
            Hidden in kid mode: the board is check-off-only for kids; parents add/edit. */}
        {!kidMode && <div className="flex justify-center">
          {showAddChore ? (
            <form onSubmit={handleAddChore} className="w-full max-w-[560px] rounded-[16px] p-4" style={{ border: `2px solid ${accent}`, background: C.card }}>
              <div className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.1em]" style={{ color: accent }}>New chore for {kid.name}</div>
              <input value={newChoreTitle} onChange={e => setNewChoreTitle(e.target.value)} autoFocus placeholder="Chore title (e.g. Make bed)" className="mb-2 w-full rounded-[10px] px-3 py-2 text-base font-semibold outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }} />
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: C.muted }}>Points
                  <input type="number" min={1} value={newChorePoints} onChange={e => setNewChorePoints(Number(e.target.value) || 0)} className="w-16 rounded-[8px] px-2 py-1.5 text-sm outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }} />
                </label>
                <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: C.muted }}>×/day
                  <input type="number" min={1} max={6} value={newChoreTimesPerDay} onChange={e => setNewChoreTimesPerDay(Math.max(1, Number(e.target.value) || 1))} className="w-14 rounded-[8px] px-2 py-1.5 text-sm outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }} />
                </label>
                <select value={newChoreScheduleTime} onChange={e => setNewChoreScheduleTime(e.target.value)} className="rounded-[8px] px-2 py-1.5 text-sm font-semibold outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }}>
                  {SLOTS.map(s => <option key={s.key} value={s.key} style={{ background: C.card }}>{s.emoji} {s.label}</option>)}
                </select>
                <select value={newChoreRepeatType} onChange={e => setNewChoreRepeatType(e.target.value as 'daily' | 'weekly')} className="rounded-[8px] px-2 py-1.5 text-sm font-semibold outline-none" style={{ background: C.app, border: `2px solid ${C.elevated}`, color: C.primary }}>
                  <option value="daily" style={{ background: C.card }}>Daily</option>
                  <option value="weekly" style={{ background: C.card }}>Weekly</option>
                </select>
              </div>
              {addMsg && <div className="mt-2 text-[12px] font-semibold" style={{ color: C.red }}>{addMsg}</div>}
              <div className="mt-2 flex gap-2">
                <button type="submit" className="rounded-[9px] px-4 py-1.5 text-[12px] font-extrabold" style={{ border: `2px solid ${accent}`, background: `${accent}1a`, color: accent }}>Add chore</button>
                <button type="button" onClick={() => { setShowAddChore(false); setAddMsg(null); }} className="rounded-[9px] px-4 py-1.5 text-[12px] font-bold" style={{ border: `2px solid ${C.elevated}`, background: 'transparent', color: C.ink }}>Cancel</button>
              </div>
            </form>
          ) : (
            <button type="button" onClick={() => openAddChore(kid.name)} className="flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-extrabold" style={{ border: `2px solid ${C.elevated}`, background: C.card, color: C.muted }}>
              <Plus size={14} /> Add chore for {kid.name}
            </button>
          )}
        </div>}

        {/* XP scorecard */}
        <div className="mx-auto w-full max-w-[560px] rounded-[20px] p-5" style={{ border: `2px solid ${accent}`, boxShadow: brutShadow(accent, 5), background: C.card }}>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: C.muted }}>Today XP</div>
              <div className="text-4xl font-extrabold leading-none" style={{ color: C.amber }}>
                {todayXp}<span className="text-[15px] font-semibold" style={{ color: C.ink }}> / {total}</span>
              </div>
            </div>
            <div className="text-right">
              <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.1em]" style={{ color: C.muted }}>💎 Total XP</div>
              <div className="text-3xl font-extrabold leading-none" style={{ color: accent }}>{totalXp}</div>
            </div>
          </div>
          <div className="h-3.5 overflow-hidden rounded-[7px]" style={{ background: C.elevated, border: '2px solid #252c44' }}>
            <div className="h-full rounded-[6px] transition-[width] duration-500" style={{ width: `${pct}%`, background: accent }} />
          </div>
          <div className="mt-1.5 text-center text-[11px] font-semibold" style={{ color: C.muted }}>
            {all.length > 0 && doneCount === all.length ? '🎉 All done!' : `${doneCount} of ${all.length} chores complete`}
          </div>
        </div>

        {/* Time-of-day breakout */}
        {sections.length === 0 ? (
          <div className="rounded-[18px] px-4 py-8 text-center text-[13px] font-semibold" style={{ border: `2px solid ${C.elevated}`, color: C.ink }}>
            No chores yet for {kid.name}. Ask the copilot to add some.
            {/* AI starter plan (docs/ai-chore-plan-generator.md): offered only on the GLOBAL empty state
                (deliberate "starter" UX — the button retires once the first chore exists) and never in
                kid mode (parents review the plan). */}
            {!kidMode && choresList.length === 0 && (
              <div className="mt-4">
                <button
                  id="generate-chore-plan-btn"
                  type="button"
                  onClick={() => setIsGeneratingChoresOpen(true)}
                  className="rounded-full px-5 py-2.5 text-xs font-extrabold"
                  style={{ border: `2px solid ${C.indigo}`, boxShadow: brutShadow(C.indigo, 4), background: `${C.indigo}14`, color: C.indigo }}
                >
                  ✨ Generate a starter chore plan
                </button>
              </div>
            )}
          </div>
        ) : sections.map(section => (
          <div key={section.key}>
            <div className="mb-2 flex items-center gap-2 text-sm font-extrabold uppercase tracking-[0.08em]" style={{ color: accent }}>
              <span>{section.emoji}</span>{section.label}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {section.chores.map(choreCard)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
