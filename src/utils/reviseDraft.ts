// HITL "Modify" on a staged draft (Pattern #4): instead of a binary approve/dismiss, the parent steers a
// pending Approvals draft in plain language ("make it vegetarian", "Tuesday instead", "a cheaper option").
// The server re-prompts the model with the draft + the feedback; this module is the PURE prompt-builder +
// result-shaper, so it's unit-tested and the no-payment invariant is enforced here (a revision stays a DRAFT
// — it never returns a "paid"/"booked" anything; it only re-describes/refines the same staged action).

export interface DraftContext {
  summary?: string;
  before?: unknown;   // update_event: the pre-change subset
  changes?: unknown;  // update_event: the staged partial
  payload?: unknown;  // reserve/cart/handoff: the draft data
  link?: string;      // reserve/cart/handoff: the deep link
}

// Only these event fields may be revised into `changes` (whitelist — the model can't smuggle arbitrary keys
// like an id or a member-cascade field into a calendar update). `freeBusy` lets a Modify mark an event
// free/busy (e.g. "make it free") instead of the current change.
const EVENT_FIELDS = ['title', 'start', 'end', 'startTime', 'endTime', 'category', 'description', 'freeBusy'] as const;
const safeLink = (u: unknown): string | undefined => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : undefined);

// Build the revise prompt. Tool-agnostic: it shows whatever the draft carries and asks for a same-kind revision.
export function buildRevisePrompt(tool: string, draft: DraftContext, feedback: string): string {
  const parts = [`Current draft: ${draft.summary || tool}`];
  if (draft.changes) parts.push(`Proposed changes: ${JSON.stringify(draft.changes)}`);
  if (draft.payload) parts.push(`Draft details: ${JSON.stringify(draft.payload)}`);
  if (draft.link) parts.push(`Link: ${draft.link}`);
  // A delete draft is the ONE case a Modify may change the action KIND — but only in the safe (less destructive)
  // direction: keep the event and mark it free/busy instead of deleting it.
  const deleteHint = tool === 'delete_event'
    ? `\n\nThis draft would DELETE the event. If the parent wants to KEEP it instead (e.g. "make it free", `
      + `"don't delete", "keep it", "just mark it free"), return \`changes: { "freeBusy": "free" }\` (or "busy") — `
      + `that converts the deletion into a free/busy change so the event stays. Only do this when they clearly want to keep it.`
    : '';
  return `You are revising a STAGED DRAFT (a "${tool}" action that is NOT yet applied) based on the family's feedback.
Keep it the SAME kind of action. You NEVER book, buy, or pay — the result is still a DRAFT the parent approves.

${parts.join('\n')}${deleteHint}

The parent's requested change: "${feedback}"

Return JSON:
- "summary": a new one-line description reflecting the revision (always).
- "changes": for a calendar change, an object with ONLY the fields that change — title, start (YYYY-MM-DD),
  end (YYYY-MM-DD), startTime/endTime ("HH:MM" 24h), category, description, freeBusy ("free"|"busy"). Omit it for non-calendar drafts.
- "link": optionally a refreshed http(s) link (e.g. a different venue/booking page). Omit if unchanged.
- "text": optionally a refreshed item text (for a cart/shopping draft). Omit if unchanged.
Include only the fields you actually change.`;
}

export interface RevisedDraft {
  summary: string;
  changes?: Record<string, string>;
  link?: string;
  text?: string;
}

// Shape + sanitize the model's raw JSON into the fields the ledger can safely merge. Falls back to the
// original summary if the model returned nothing usable. `changes` is whitelisted to event fields and applied
// only for update_event; `link` must be http(s); everything is string-coerced + trimmed.
export function shapeRevisedDraft(tool: string, raw: any, original: DraftContext): RevisedDraft {
  const out: RevisedDraft = { summary: String(raw?.summary || '').trim() || String(original.summary || '').trim() || tool };
  if (raw?.changes && typeof raw.changes === 'object') {
    // update_event: any whitelisted event field. delete_event: ONLY freeBusy — the "keep the event, mark it
    // free/busy instead of deleting" conversion (the caller then swaps the tool to update_event).
    const allowed: readonly string[] = tool === 'update_event' ? EVENT_FIELDS : tool === 'delete_event' ? ['freeBusy'] : [];
    const changes: Record<string, string> = {};
    for (const k of allowed) {
      const v = raw.changes[k];
      if (typeof v === 'string' && v.trim()) changes[k] = v.trim();
    }
    // freeBusy must be exactly 'free'|'busy' (the model can't smuggle an arbitrary availability string).
    if (changes.freeBusy) { const fb = changes.freeBusy.toLowerCase(); if (fb === 'free' || fb === 'busy') changes.freeBusy = fb; else delete changes.freeBusy; }
    if (Object.keys(changes).length) out.changes = changes;
  }
  const link = safeLink(raw?.link);
  if (link) out.link = link;
  if (typeof raw?.text === 'string' && raw.text.trim()) out.text = raw.text.trim().slice(0, 200);
  return out;
}
