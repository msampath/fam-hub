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

// ── Unbacked-claim check (weak-model hardening, Phase 3) ─────────────────────────────────────────
// Found live via the eval harness — on gemini-2.5-flash the quick path answers an explicit command
// with "I've added milk to your shopping list." while emitting actions: []. Nothing is saved and the
// reply is a lie. The agent path has detectUnbackedClaims (agentActions.ts); this is the quick-path
// equivalent, phrased as critic ISSUES so the existing corrective-re-prompt loop can recover the
// action instead of merely censoring the claim. Targets COMPLETED claims only — "I can add…" /
// "Want me to add…?" must not trip it. Pure → unit-tested.
// A completion claim comes in two safe-to-match shapes (futures/offers like "I'll put…" or
// "I can schedule…" must NOT trip this):
//   A. perfect tense with any self-reference — "I've added…", "I have scheduled…", and the
//      third-person voice found live: "Okay, the family's copilot has added milk…"
//   B. simple past IMMEDIATELY after "I" — "I added milk…" (no room for a modal in between)
const claim = (verbs: string, obj: string) => new RegExp(
  `(?:(?:i'?ve|i have|(?:the |your )?(?:family'?s )?copilot has|assistant has)[^.!?]{0,50}\\b(?:${verbs})` +
  `|\\bi (?:just )?(?:${verbs}))\\b[^.!?]{0,70}\\b(?:${obj})\\b`, 'i');
const CLAIM_FAMILIES: { re: RegExp; action: string; label: string }[] = [
  { re: claim('added|put', 'shopping|list'), action: 'add_shopping_item', label: 'adding a shopping item' },
  { re: claim('added|created|assigned|set up', 'chores?'), action: 'add_chore', label: 'adding a chore' },
  { re: claim('added|created|scheduled|put|booked', 'calendar|appointments?|events?'), action: 'create_event', label: 'creating a calendar event' },
  { re: claim('scheduled|booked', 'for|at|on'), action: 'create_event', label: 'scheduling something' },
];

// Returns critic issues for every completed-action claim the reply makes that actions[] doesn't back.
export function verifyActionClaims(reply: string, actions: { type?: string }[]): ActionIssue[] {
  const text = String(reply || '');
  const have = new Set((Array.isArray(actions) ? actions : []).map(a => a?.type));
  const issues: ActionIssue[] = [];
  for (const fam of CLAIM_FAMILIES) {
    if (fam.re.test(text) && !have.has(fam.action)) {
      issues.push({
        index: -1, type: fam.action,
        // No "or just soften the wording" escape hatch: given the choice, 2.5-flash rewrote the reply
        // into an offer and STILL emitted no action (seen live). The parent gave an explicit command —
        // demand the action; the honesty backstop handles a model that still won't comply.
        reason: `the reply CLAIMS ${fam.label} was completed, but "actions" does not contain ${fam.action}. `
          + `The parent gave an explicit command — you MUST include the matching ${fam.action} action in "actions" this time`,
      });
      break; // one claim issue per pass is enough signal for the retry
    }
  }
  return issues;
}

// Final backstop when the critic loop couldn't recover the action: refuse to let the false claim
// stand (same convention as the agent path's detectUnbackedClaims — append an honest correction).
export function unbackedClaimCorrection(reply: string, actions: { type?: string }[]): string | null {
  return verifyActionClaims(reply, actions).length
    ? '⚠️ Correction: that isn\'t saved yet — nothing was actually added this turn. Say it as a command again and I\'ll stage it for real.'
    : null;
}
