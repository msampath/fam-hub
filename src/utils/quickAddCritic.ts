// Quick-add critic (weak-model hardening, Phase 3). /api/parse-quickadd used to return the model's
// parse RAW — a near-miss (unknown member, past date, empty title, invalid store) was silently wrong
// and the client dropped it with no recovery. This mirrors copilotCritic.ts: a PURE validator collects
// concrete issues, the server re-prompts once with the issue list (bounded, lower temperature), and
// whatever remains fixably wrong is coerced/clamped deterministically. Pure → unit-tested.

export interface QuickAddParse {
  kind?: string;
  event?: { title?: string; start?: string; end?: string; startTime?: string; endTime?: string; category?: string; members?: string[] };
  items?: { text?: string; store?: string }[];
  chore?: { title?: string; assignedTo?: string; points?: number; timesPerDay?: number; repeatType?: string; scheduleTimeOfDay?: string };
}

export interface QuickAddCtx {
  members: string[];       // known member names
  stores: string[];        // valid store list
  today: string;           // YYYY-MM-DD
}

const KINDS = new Set(['event', 'shopping', 'chore']);
const CATEGORIES = new Set(['School', 'Camp', 'Sports', 'Arts', 'Holiday', 'Other']);
const SLOTS = new Set(['Morning', 'Afternoon', 'Evening', 'Anytime']);
const MULTI_KID_RE = /^(both kids|all kids|everyone|all children)$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function isRealDate(iso: string): boolean {
  if (!ISO_RE.test(iso)) return false;
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

// Collect everything wrong with a parse, in the model-facing phrasing the critic note reuses.
export function verifyQuickAdd(p: QuickAddParse | null | undefined, ctx: QuickAddCtx): string[] {
  const issues: string[] = [];
  if (!p || typeof p !== 'object' || !p.kind || !KINDS.has(String(p.kind))) {
    return ['"kind" must be exactly one of: event, shopping, chore'];
  }
  const known = new Set(ctx.members.map(m => m.toLowerCase()));
  if (p.kind === 'event') {
    const e = p.event;
    if (!e || !String(e.title || '').trim()) issues.push('event.title is required and must not be empty');
    const start = String(e?.start || '');
    if (!isRealDate(start)) issues.push(`event.start must be a REAL calendar date in YYYY-MM-DD (got "${start || 'nothing'}")`);
    else if (start < ctx.today) issues.push(`event.start ${start} is in the past — resolve relative dates against today (${ctx.today})`);
    for (const [f, v] of [['startTime', e?.startTime], ['endTime', e?.endTime]] as const) {
      if (v && !TIME_RE.test(String(v))) issues.push(`event.${f} must be 24h HH:MM (got "${v}")`);
    }
    for (const m of e?.members || []) {
      if (m && m !== 'Everyone' && !known.has(String(m).toLowerCase())) {
        issues.push(`event.members contains "${m}" — not a known family member (known: ${ctx.members.join(', ') || 'none'}; or use ["Everyone"])`);
      }
    }
  } else if (p.kind === 'shopping') {
    const items = Array.isArray(p.items) ? p.items : [];
    if (!items.length || !items.some(i => String(i?.text || '').trim())) issues.push('shopping requires at least one item with non-empty text');
    const validStores = new Set(ctx.stores.map(s => s.toLowerCase()));
    for (const i of items) {
      if (i?.store && !validStores.has(String(i.store).toLowerCase())) {
        issues.push(`item "${i?.text}" has store "${i.store}" — must be one of: ${ctx.stores.join(', ')}`);
      }
    }
  } else if (p.kind === 'chore') {
    const c = p.chore;
    if (!c || !String(c.title || '').trim()) issues.push('chore.title is required and must not be empty');
    const who = String(c?.assignedTo || '');
    if (!who) issues.push('chore.assignedTo is required');
    else if (!known.has(who.toLowerCase()) && !MULTI_KID_RE.test(who)) {
      issues.push(`chore.assignedTo "${who}" is not a known family member (known: ${ctx.members.join(', ') || 'none'}) and not a multi-kid phrase ("both kids"/"everyone")`);
    }
  }
  return issues;
}

// The corrective note appended to the re-prompt — same voice as copilotCritic.buildCriticNote.
export function buildQuickAddCriticNote(issues: string[]): string {
  return `Your previous parse had these problems — fix EVERY one and return the corrected JSON only:\n- ${issues.join('\n- ')}`;
}

// Last-resort deterministic repair for what a retry still got wrong: coerce fixable fields, drop
// broken optional ones. NEVER invents content — an unfixable required field stays broken so the
// caller can surface an honest failure instead of a fabricated one.
export function coerceQuickAdd(p: QuickAddParse, ctx: QuickAddCtx): QuickAddParse {
  const out: QuickAddParse = JSON.parse(JSON.stringify(p || {}));
  if (out.kind === 'event' && out.event) {
    const e = out.event;
    if (e.category && !CATEGORIES.has(e.category)) e.category = 'Other';
    if (e.startTime && !TIME_RE.test(e.startTime)) delete e.startTime;
    if (e.endTime && !TIME_RE.test(e.endTime)) delete e.endTime;
    if (e.end && !isRealDate(String(e.end))) delete e.end;
    const known = new Set(ctx.members.map(m => m.toLowerCase()));
    const members = (e.members || []).filter(m => m === 'Everyone' || known.has(String(m).toLowerCase()));
    e.members = members.length ? members : ['Everyone'];
  } else if (out.kind === 'shopping') {
    const validStores = new Set(ctx.stores.map(s => s.toLowerCase()));
    out.items = (Array.isArray(out.items) ? out.items : [])
      .filter(i => String(i?.text || '').trim())
      .map(i => ({
        text: String(i.text).trim().slice(0, 80),
        store: i.store && validStores.has(String(i.store).toLowerCase())
          ? ctx.stores.find(s => s.toLowerCase() === String(i.store).toLowerCase())!
          : (ctx.stores.includes('Grocery Store') ? 'Grocery Store' : ctx.stores[0]),
      }));
  } else if (out.kind === 'chore' && out.chore) {
    const c = out.chore;
    c.points = Number.isFinite(Number(c.points)) && Number(c.points) > 0 ? Math.min(100, Math.round(Number(c.points))) : 10;
    c.timesPerDay = Number.isFinite(Number(c.timesPerDay)) && Number(c.timesPerDay) >= 1 ? Math.min(10, Math.round(Number(c.timesPerDay))) : 1;
    if (c.repeatType !== 'weekly') c.repeatType = 'daily';
    if (c.scheduleTimeOfDay && !SLOTS.has(c.scheduleTimeOfDay)) delete c.scheduleTimeOfDay;
  }
  return out;
}
