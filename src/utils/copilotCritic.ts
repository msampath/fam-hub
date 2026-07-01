// Critic / Verifier (agentic A7) for the local copilot's action JSON.
// sanitizeCopilotActions (server.ts) silently DROPS malformed actions, so a near-miss (a chore for a kid
// whose name was mistyped, a past/garbled date) becomes a silent no-op. This verifier instead NAMES what's
// wrong so the server can do ONE corrective re-prompt ("fix these and re-emit") — recovering the action
// rather than losing it. Pure → unit-tested; the server wires it into /api/copilot.

export interface ActionIssue { index: number; type: string; reason: string }

const GROUP_RE = /\b(both|all|every|everyone|kids|family)\b/i; // "both kids", "all kids", "everyone" — valid chore targets
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateIssue(label: string, value: unknown, today: string): string | null {
  if (value == null || value === '') return null; // optional dates are fine
  const s = String(value);
  if (!ISO_DATE.test(s)) return `${label} "${s}" is not a valid YYYY-MM-DD date`;
  // Date.parse ROLLS OVER invalid days (2026-02-30 → Mar 2), so NaN alone misses them — round-trip the
  // parsed date back to YYYY-MM-DD and require it to equal the input to reject impossible calendar dates.
  const parsed = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== s) return `${label} "${s}" is not a real calendar date`;
  if (s < today) return `${label} "${s}" is in the past (today is ${today})`;
  return null;
}

// Inspect each action; return the concrete problems (empty array = all good). Roster check is
// case-insensitive and lets group phrases through; date checks apply to create/update events.
export function verifyActions(
  actions: any[],
  ctx: { memberNames: string[]; today: string },
): ActionIssue[] {
  if (!Array.isArray(actions)) return [];
  const roster = new Set((ctx.memberNames || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
  const issues: ActionIssue[] = [];
  actions.forEach((a, index) => {
    if (!a || typeof a.type !== 'string') { issues.push({ index, type: 'unknown', reason: 'action has no type' }); return; }
    const p = a.payload || {};
    if (a.type === 'add_chore') {
      const who = String(p.assignedTo || '').trim();
      if (!who) issues.push({ index, type: a.type, reason: 'chore has no assignedTo' });
      else if (!roster.has(who.toLowerCase()) && !GROUP_RE.test(who)) {
        issues.push({ index, type: a.type, reason: `"${who}" is not a family member (roster: ${ctx.memberNames.join(', ') || 'none'})` });
      }
    }
    if (a.type === 'create_event' || a.type === 'update_event') {
      if (a.type === 'create_event' && !String(p.title || '').trim()) issues.push({ index, type: a.type, reason: 'event has no title' });
      for (const [label, key] of [['start', 'start'], ['end', 'end']] as const) {
        const r = dateIssue(label, p[key], ctx.today);
        if (r) issues.push({ index, type: a.type, reason: r });
      }
    }
  });
  return issues;
}

// Build the corrective note appended to the re-prompt. Lists the issues so the model can fix exactly those.
export function buildCriticNote(issues: ActionIssue[]): string {
  const lines = issues.map(i => `- action #${i.index + 1} (${i.type}): ${i.reason}`);
  return `Your previous "actions" JSON had problems:\n${lines.join('\n')}\n`
    + `Re-emit the SAME reply, fixing ONLY these actions — use a real family member name for chores, valid `
    + `YYYY-MM-DD dates today or later, and drop any action you cannot fix. Return the corrected JSON.`;
}
