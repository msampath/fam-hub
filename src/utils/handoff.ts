// prepare_handoff (agentic A3): the loop-closer. After the agent researches a real booking/permit/registration
// URL (via web_search/fetch_page) and gathers the household details, it stages a HANDOFF draft — the exact
// official URL plus the details the parent will need to ENTER there. A plain link cannot fill the venue's
// form, and the agent NEVER fills, submits, or pays (no-payment invariant): a handoff is a confirm-tier DRAFT;
// the typing and the final click belong to the human. Pure builder → unit-tested; the MCP tool + client ledger reuse it.

export interface HandoffField { label: string; value: string }
export interface HandoffDraft { summary: string; link: string; fields: HandoffField[]; title: string }

// Build a handoff draft, or null if it lacks a REAL http(s) URL (so the agent can't stage a handoff to a
// made-up/again-search link — the whole point is a real form the parent opens).
export function buildHandoffDraft(args: { title?: string; url?: string; fields?: HandoffField[] }): HandoffDraft | null {
  const title = String(args?.title || '').trim().slice(0, 120);
  const url = String(args?.url || '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  // A handoff must point at a REAL booking/registration page the agent actually found — never a
  // "search for it yourself" link (the lazy escape hatch). Reject search-engine result URLs.
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const isSearchLink =
      /(^|\.)(bing|duckduckgo|yahoo|baidu|yandex|ecosia|ask)\.[a-z.]+$/.test(host) ||
      (/(^|\.)google\.[a-z.]+$/.test(host) && /^\/search\b/.test(u.pathname));
    if (isSearchLink) return null;
  } catch { return null; }
  const fields = (Array.isArray(args?.fields) ? args.fields : [])
    .map(f => ({ label: String(f?.label || '').trim().slice(0, 60), value: String(f?.value || '').trim().slice(0, 200) }))
    .filter(f => f.label && f.value)
    .slice(0, 12);
  // Honest framing: the agent gathered these values, but a plain link CAN'T inject them into the venue's
  // form — so it's "details to enter", not "pre-filled". (The user opens the page and types them.)
  const filled = fields.length ? ` — details to enter: ${fields.map(f => `${f.label}: ${f.value}`).join('; ')}` : '';
  return { summary: `${title}${filled}`.slice(0, 600), link: url, fields, title };
}

// PROVENANCE for the handoff gate. A booking handoff may only be staged for a URL the web/venue actually
// PUBLISHED this run (a web_search result, a fetched page URL, or a fetched page's same-domain/known-booking
// link) — never one the model invented, nor a phishing link a malicious page merely pointed at. Normalize to
// host+path (www-stripped, trailing-slash-stripped, lowercased) so the published link and the staged link
// match regardless of cosmetic differences. Pure → unit-tested (the real safety control the dead MCP_TOOLS
// copy used to bypass).
export function normHandoffUrl(u: string): string | null {
  try { const x = new URL(u); return (`${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`).toLowerCase() || null; }
  catch { return null; }
}

// True when the handoff link was actually observed (published) among the URLs the agent read this run.
export function isLinkObserved(link: string, observed: Set<string>): boolean {
  const n = normHandoffUrl(link);
  return !!n && observed.has(n);
}
