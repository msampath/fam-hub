import { useState, type FormEvent } from 'react';
import { useApp } from '../AppContext';
import Modal from './shell/Modal';
import { C } from './shell/theme';
import { groupGeneratedByKid, type GeneratedChore } from '../utils/chorePlan';

// AI starter chore plan (docs/ai-chore-plan-generator.md): two-phase modal off the Chores empty state.
// FORM — per kid: age (required, 1–18) + interests/gender (optional; the server prompt forbids gender-
// gating chores). PREVIEW — the sanitized plan grouped per kid, every row a checkbox (default on);
// "Add selected" bulk-adds via addGeneratedChores (one shared dedupe Set) and reports added/skipped.
// A generation failure shows choreGenError inline on the form — no fabricated preview.

const field = { background: C.app, border: `2px solid ${C.elevated}`, color: C.primary } as const;

interface KidForm { name: string; age: string; interests: string; gender: string }

export default function GenerateChoresModal() {
  const {
    familyMembers, setIsGeneratingChoresOpen, isGeneratingChores, choreGenError,
    handleGenerateChores, addGeneratedChores,
  } = useApp();
  const kids = familyMembers.filter(m => m.role === 'Kid');
  const [forms, setForms] = useState<KidForm[]>(() => kids.map(k => ({
    name: k.name,
    age: Number.isFinite(k.age) && (k.age as number) > 0 ? String(k.age) : '', // prefill when the roster knows it
    interests: k.interests || '',
    gender: 'unspecified',
  })));
  const [plan, setPlan] = useState<GeneratedChore[] | null>(null); // null = form phase
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [summary, setSummary] = useState<string | null>(null);

  const close = () => setIsGeneratingChoresOpen(false);
  const patch = (i: number, p: Partial<KidForm>) => setForms(prev => prev.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const validAge = (a: string) => { const n = Number(a); return Number.isFinite(n) && n >= 1 && n <= 18; };
  const allValid = forms.length > 0 && forms.every(f => validAge(f.age));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!allValid || isGeneratingChores) return;
    const result = await handleGenerateChores(forms.map(f => ({
      name: f.name, age: Number(f.age),
      ...(f.interests.trim() ? { interests: f.interests.trim() } : {}),
      ...(f.gender !== 'unspecified' ? { gender: f.gender } : {}),
    })));
    if (result) {
      setPlan(result);
      setChecked(new Set(result.map((_, i) => i))); // default: everything selected
      setSummary(null);
    } // null → choreGenError renders inline; stay on the form
  };

  const toggle = (i: number) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const addSelected = () => {
    if (!plan) return;
    const { added, duplicates } = addGeneratedChores(plan.filter((_, i) => checked.has(i)));
    setSummary(`Added ${added}${duplicates ? ` · skipped ${duplicates} duplicate${duplicates === 1 ? '' : 's'}` : ''}.`);
  };

  const groups = plan ? groupGeneratedByKid(plan, familyMembers) : [];
  const indexOfChore = (c: GeneratedChore) => (plan ? plan.indexOf(c) : -1);

  return (
    <Modal label="Generate a starter chore plan" accent={C.indigo} onClose={close}>
      <div className="mb-3 flex items-center justify-between">
        <div className="text-sm font-extrabold" style={{ color: C.indigo }}>✨ Starter chore plan</div>
        <button type="button" onClick={close} className="text-[11px] font-bold uppercase" style={{ color: C.ink }}>Close</button>
      </div>

      {plan === null ? (
        <form onSubmit={submit}>
          <div className="mb-3 text-[13px] font-semibold" style={{ color: C.muted }}>
            Tell me each kid's age (interests optional) and I'll draft an age-appropriate plan — you review it before anything is added.
          </div>
          <div className="flex flex-col gap-3">
            {forms.map((f, i) => (
              <div key={i} className="rounded-[14px] p-3" style={{ border: `2px solid ${C.elevated}` }}>
                <div className="mb-2 text-[12px] font-extrabold" style={{ color: C.primary }}>{f.name}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: C.muted }}>Age
                    <input id={`gen-chore-age-${f.name}`} type="number" min={1} max={18} required value={f.age}
                      onChange={e => patch(i, { age: e.target.value })}
                      className="w-16 rounded-[8px] px-2 py-1.5 text-sm outline-none" style={field} />
                  </label>
                  <input value={f.interests} onChange={e => patch(i, { interests: e.target.value })}
                    placeholder="Interests (optional)" className="min-w-0 flex-1 rounded-[8px] px-2 py-1.5 text-sm outline-none" style={field} />
                  <select value={f.gender} onChange={e => patch(i, { gender: e.target.value })}
                    className="rounded-[8px] px-2 py-1.5 text-sm font-semibold outline-none" style={field}>
                    <option value="unspecified" style={{ background: C.card }}>Gender (optional)</option>
                    <option value="girl" style={{ background: C.card }}>Girl</option>
                    <option value="boy" style={{ background: C.card }}>Boy</option>
                    <option value="other" style={{ background: C.card }}>Other</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
          {choreGenError && <div className="mt-3 text-[12px] font-semibold" style={{ color: C.red }}>{choreGenError}</div>}
          <div className="mt-3 flex gap-2">
            <button id="gen-chore-submit" type="submit" disabled={!allValid || isGeneratingChores}
              className="rounded-[10px] px-4 py-2 text-sm font-extrabold"
              style={{ border: `2px solid ${C.indigo}`, background: `${C.indigo}14`, color: C.indigo, opacity: !allValid || isGeneratingChores ? 0.5 : 1 }}>
              {isGeneratingChores ? 'Generating…' : 'Generate plan'}
            </button>
            <button type="button" onClick={close} className="rounded-[10px] px-4 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, color: C.muted }}>Cancel</button>
          </div>
        </form>
      ) : (
        <div>
          <div className="mb-2 text-[13px] font-semibold" style={{ color: C.muted }}>
            Review the plan — untick anything you don't want, then add the rest.
          </div>
          {groups.length === 0 && (
            <div className="rounded-[12px] px-3 py-4 text-[13px] font-semibold" style={{ border: `2px solid ${C.elevated}`, color: C.ink }}>
              The model returned nothing usable — go back and try again.
            </div>
          )}
          <div className="flex max-h-[50vh] flex-col gap-3 overflow-y-auto">
            {groups.map((g, gi) => (
              <div key={gi}>
                <div className="mb-1.5 text-[11px] font-extrabold uppercase tracking-[0.1em]" style={{ color: C.indigo }}>{g.kid}</div>
                <div className="flex flex-col gap-1.5">
                  {g.chores.map(c => {
                    const i = indexOfChore(c);
                    return (
                      <label key={`${g.kid}-${i}`} id={`gen-chore-row-${g.kid}-${i}`} className="flex cursor-pointer items-start gap-2 rounded-[10px] px-2.5 py-2" style={{ border: `2px solid ${checked.has(i) ? C.indigo : C.elevated}`, background: checked.has(i) ? `${C.indigo}0d` : 'transparent' }}>
                        <input type="checkbox" checked={checked.has(i)} onChange={() => toggle(i)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-extrabold" style={{ color: C.primary }}>
                            {c.title}
                            <span className="ml-2 rounded-full px-1.5 py-0.5 text-[10px] font-bold" style={{ background: C.elevated, color: C.muted }}>
                              {c.repeatType === 'weekly' ? 'weekly' : 'daily'}{c.scheduleTimeOfDay ? ` · ${c.scheduleTimeOfDay}` : ''} · {c.points ?? 10} XP
                            </span>
                          </span>
                          {c.notes && <span className="block text-[12px] font-medium" style={{ color: C.muted }}>{c.notes}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          {summary && <div className="mt-3 text-[13px] font-extrabold" style={{ color: C.emerald }}>{summary}</div>}
          <div className="mt-3 flex flex-wrap gap-2">
            {summary ? (
              <button type="button" onClick={close} className="rounded-[10px] px-4 py-2 text-sm font-extrabold" style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald }}>Done</button>
            ) : (
              <>
                <button id="gen-chore-add" type="button" onClick={addSelected} disabled={checked.size === 0}
                  className="rounded-[10px] px-4 py-2 text-sm font-extrabold"
                  style={{ border: `2px solid ${C.emerald}`, background: `${C.emerald}14`, color: C.emerald, opacity: checked.size === 0 ? 0.5 : 1 }}>
                  Add selected ({checked.size})
                </button>
                <button type="button" onClick={() => { setPlan(null); setSummary(null); }} className="rounded-[10px] px-4 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, color: C.muted }}>Back</button>
                <button type="button" onClick={close} className="rounded-[10px] px-4 py-2 text-sm font-bold" style={{ border: `2px solid ${C.elevated}`, color: C.muted }}>Cancel</button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
