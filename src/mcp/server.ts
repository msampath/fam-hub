#!/usr/bin/env node
// KAGGLE_EVAL: MCP Server (stdio transport) — a thin adapter that exposes the concierge toolbelt
// (conciergeTools.ts) to an MCP client. In the capstone demo the Python ADK agent spawns THIS as a
// stdio child process, making MCP the agent's primary toolbelt. All validation, the no-payment
// invariant, and the risk tiers live in conciergeTools.ts (pure + unit-tested); this file only wires
// the protocol. Run: `npm run mcp` (tsx). stdout is the MCP channel — logs go to stderr.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOLS, getTool, buildToolCtx, type McpToolResult } from './conciergeTools';
import { makePersistence, persistResult } from './persistence';
import { findPlaces } from '../utils/placesFetch';
import { buildHandoffDraft, normHandoffUrl, isLinkObserved } from '../utils/handoff';
import { READ_TOOL_DEFS, shapeEvents, shapeUpcoming, shapeChores, shapeBills, shapeKnowledgeAsync } from './readTools';
import { resolveDoc, normalizeFolder } from '../utils/docActions';
import { sanitizeStoreList } from '../constants';
import { searchWeb, fetchPage, trustedBookingLinks } from '../utils/webResearch';
import { cachedFraming } from '../utils/webCache';
import { sanitizeForPrompt } from '../utils/promptSafety';

// Library doc management (move = auto/reversible; delete = confirm/destructive). Custom handlers (they
// rewrite the documents collection under the visitor JWT), so they live here in the I/O layer.
const DOC_TOOL_DEFS = [
  {
    name: 'move_document',
    description: "Recategorize a saved Library document into a different folder (reversible). Identify the "
      + 'document by name (as returned by search_local_knowledge) and give the destination folder; a new '
      + 'folder name is fine.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: "The document's name." },
        folder: { type: 'string', description: 'Destination folder (created if new).' },
      },
    },
  },
  {
    name: 'delete_document',
    description: 'Delete saved Library document(s) (destructive — STAGED for the parent to confirm). Identify '
      + 'ONE document by "name", OR clear an entire folder by passing "folder" (e.g. clear the Newsletters '
      + 'folder) — the whole folder is staged as a single approval. Use only when the parent explicitly asks '
      + 'to delete/remove document(s).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: "The document's name (for a single delete)." },
        folder: { type: 'string', description: 'Delete EVERY document in this folder (for a folder-clear).' },
      },
    },
  },
];

// find_places is a READ/DISCOVERY tool (async HTTP + needs the home location), so it lives here in the I/O
// layer rather than in the pure conciergeTools. It gives the agent the SAME real-venue grounding the
// copilot has — so it recommends/reserves a REAL place with a real URL instead of improvising one.
// Web-research tools (agentic A1): real grounding via a provider chain + a page reader. Async HTTP behind
// an SSRF guard (webResearch.ts), so — like find_places — they live in the I/O layer, not the pure registry.
const WEB_TOOL_DEFS = [
  {
    name: 'web_search',
    description: 'Search the live web for facts the family data does not contain (e.g. whether a park needs a '
      + 'timed-entry pass, event dates, opening hours, ticket info). Returns the top results, each with a '
      + 'title, URL and snippet. Use this BEFORE recommending or planning anything that depends on real-world '
      + 'logistics — never guess. Follow up with fetch_page on a promising URL for the details.',
    inputSchema: {
      type: 'object' as const,
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: 'Fetch a web page (by URL, usually one returned by web_search) and return its readable text, '
      + 'so you can extract specifics like a booking URL, prices, dates, or pass requirements.',
    inputSchema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'The http(s) URL to read.' } },
      required: ['url'],
    },
  },
];

const FIND_PLACES_TOOL = {
  name: 'find_places',
  description: 'Find REAL venues (zoos, museums, parks, restaurants, lodging, etc.), each with a real URL '
    + '(official website or a Google Maps link) and an approximate drive time from home. By default '
    + 'searches near the family home; for a FAR getaway pass `destination` (e.g. "Mount Rainier National '
    + 'Park") to search AROUND that place instead (drive time is still measured from home). ALWAYS call '
    + 'this before recommending a specific place or staging a reserve — never invent a venue or a link.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: { type: 'string', description: 'What to look for, e.g. "zoo", "lodge hotel", "restaurants". Omit for marquee family venues.' },
      destination: { type: 'string', description: 'A far destination to search AROUND (e.g. "Mount Rainier National Park", "Leavenworth WA"). Omit to search near home.' },
    },
  },
};

// The client's civil date, threaded from agentClient→api.py→env so MCP tool validators use the
// family's local date (not the container's UTC clock, which drifts a day at evening local time).
const _envToday = process.env.CLIENT_TODAY;
const clientToday = (_envToday && /^\d{4}-\d{2}-\d{2}$/.test(_envToday)) ? _envToday : '';

const server = new Server(
  { name: 'family-hub-concierge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// Supabase persistence under the visitor's JWT (SUPABASE_ACCESS_TOKEN), or null → validate-only.
const persistence = makePersistence();

// Advertise the toolbelt (name + description + JSON-Schema input) to the client — the mutating tools plus
// the find_places discovery tool.
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...MCP_TOOLS, FIND_PLACES_TOOL, ...WEB_TOOL_DEFS, ...READ_TOOL_DEFS, ...DOC_TOOL_DEFS].map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));

// Library doc tools: resolve the doc by name/id, then move (persist now) or stage a delete for confirmation.
const DOC_TOOL_NAMES = new Set(DOC_TOOL_DEFS.map(t => t.name));
async function handleDocTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (!persistence) {
    return { ok: false, tool: name, tier: 'auto', status: 'rejected', message: 'No household is connected.' };
  }
  const docs = await persistence.loadCollection('documents').catch(() => []);
  // Folder-clear: stage EVERY doc in the named folder as one confirm row (no per-doc loop → the action cap
  // can't truncate a 25-file folder). The client removes them all on approval.
  if (name === 'delete_document' && args.folder && !args.name && !args.id) {
    // A whitespace-only folder must NOT silently normalize to "Uncategorized" and sweep every un-filed
    // document — require a real folder name.
    const rawFolder = String(args.folder).trim();
    if (!rawFolder) {
      return { ok: false, tool: name, tier: 'auto', status: 'rejected', message: 'Name the folder to clear.' };
    }
    const fold = normalizeFolder(rawFolder);
    const inFolder = (docs as any[]).filter(d => normalizeFolder(d.folder) === fold);
    if (!inFolder.length) {
      return { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `No documents are in the "${fold}" folder.` };
    }
    // The Uncategorized bucket IS every un-filed doc — say so, so the parent understands the real scope.
    const label = fold === 'Uncategorized' ? 'Uncategorized (all un-filed documents)' : `"${fold}"`;
    return { ok: true, tool: 'delete_document', tier: 'confirm', status: 'requires_confirmation', artifact: { ids: inFolder.map(d => d.id), folder: fold, count: inFolder.length }, message: `Delete all ${inFolder.length} documents in ${label}? Confirm in Approvals.` };
  }
  // Destructive delete resolves strictly (exact id/name); reversible move allows the substring convenience.
  const target = resolveDoc(docs as any, { id: args.id as string, name: args.name as string }, name === 'move_document');
  if (!target) {
    return { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `No document exactly matches "${args.name || args.id || ''}".` };
  }
  if (name === 'move_document') {
    const folder = normalizeFolder(args.folder as string);
    await persistence.mutate('documents', cur => (cur as any[]).map(d => (d.id === target.id ? { ...d, folder } : d)));
    return { ok: true, tool: name, tier: 'auto', status: 'applied', artifact: { id: target.id, name: target.name, folder }, message: `Moved "${target.name}" to ${folder}.` };
  }
  // delete_document — confirm tier: do NOT delete here; the client stages it in Approvals and removes it on
  // approval (the documents collection is client-owned + RLS-synced).
  return { ok: true, tool: 'delete_document', tier: 'confirm', status: 'requires_confirmation', artifact: { id: target.id, name: target.name }, message: `Delete "${target.name}"? Confirm in Approvals.` };
}

// READ tools (get_events / get_chores / get_upcoming): gather the visitor's household data under their JWT.
// Read-only — no tier/no-payment surface. Without persistence (contract slice) they honestly report no data.
const READ_TOOL_NAMES = new Set(READ_TOOL_DEFS.map(t => t.name));
async function handleReadTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (!persistence) {
    return { ok: false, tool: name, tier: 'auto', status: 'rejected',
      message: 'No household is connected, so there is nothing to read yet.' };
  }
  const today = clientToday || new Date().toISOString().slice(0, 10);
  if (name === 'get_chores') {
    const chores = await persistence.loadCollection('chores').catch(() => []);
    const items = shapeChores(chores as any, args.all === true);
    return { ok: true, tool: name, tier: 'auto', status: 'validated', artifact: items, message: `${items.length} chore(s).` };
  }
  if (name === 'get_bills') {
    const bills = await persistence.loadCollection('bills').catch(() => []);
    const items = shapeBills(bills as any, today, args.upcomingOnly === true);
    return { ok: true, tool: name, tier: 'auto', status: 'validated', artifact: items, message: `${items.length} bill(s).` };
  }
  if (name === 'search_local_knowledge') {
    const docs = await persistence.loadCollection('documents').catch(() => []);
    const items = await shapeKnowledgeAsync(docs as any, typeof args.query === 'string' ? args.query : '');
    return { ok: true, tool: name, tier: 'auto', status: 'validated', artifact: items,
      message: items.length ? `${items.length} relevant document(s).` : 'No matching documents found.' };
  }
  const events = await persistence.loadCollection('events').catch(() => []);
  const items = name === 'get_upcoming'
    ? shapeUpcoming(events as any, today, typeof args.days === 'number' ? args.days : 7)
    : shapeEvents(events as any, typeof args.limit === 'number' ? args.limit : 30, {
        from: typeof args.from === 'string' ? args.from : undefined,
        to: typeof args.to === 'string' ? args.to : undefined,
      });
  return { ok: true, tool: name, tier: 'auto', status: 'validated', artifact: items, message: `${items.length} event(s).` };
}

// Discovery handler: resolve the visitor's home from settings, then fetch real venues. Needs persistence
// (the home location lives in the household's settings) — without it, say so honestly rather than guess.
async function handleFindPlaces(args: Record<string, unknown>): Promise<McpToolResult> {
  const query = typeof args.query === 'string' ? args.query : '';
  const destination = typeof args.destination === 'string' ? args.destination.trim() : '';
  if (!persistence) {
    return { ok: false, tool: 'find_places', tier: 'auto', status: 'rejected',
      message: 'No household is connected, so I can’t look up your home location to search nearby.' };
  }
  const settings = await persistence.loadCollection('settings').catch(() => []);
  const home = (settings as any[])[0] || {};
  const lat = Number(home.homeLat), lng = Number(home.homeLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, tool: 'find_places', tier: 'auto', status: 'rejected',
      message: 'No home location is set. Ask the parent to set their home town so I can find real nearby places.' };
  }
  const { places, destinationResolved, keylessNameMiss } = await findPlaces(lat, lng, query, 6, destination || undefined);
  const homeLabel = home.homeLabel || 'home';
  // Only claim "around <destination>" when the destination actually GEOCODED. On a geocode miss we fell back
  // to a HOME-area search, so say so plainly (and the agent won't present home venues as the far getaway).
  const missedDestination = !!destination && !destinationResolved;
  const where = missedDestination
    ? `near ${homeLabel} (I couldn't pin "${destination}" on the map)`
    : destinationResolved && destination ? `around ${destination}` : `near ${homeLabel}`;
  return {
    ok: true, tool: 'find_places', tier: 'auto', status: 'validated',
    artifact: places.map(p => ({
      name: p.name, category: p.category, url: p.url, rating: p.rating, driveMinutes: p.driveMinutes,
    })),
    message: places.length
      ? `Found ${places.length} real places ${where}.`
      // Keyless name-ask miss: say WHY honestly (category-only fallback) instead of a bare miss —
      // and never the pre-fix behavior of six arbitrary cafés presented as the venue.
      : keylessNameMiss
      ? `I couldn't look up "${query}" by name — precise name lookup needs a Google Maps key (the keyless fallback only searches by category). Tell the family the lookup is unavailable, or try a category like "thai restaurants".`
      : `No matching places found ${where}.`,
  };
}

// Web-research handler (no persistence needed — pure web grounding). web_search runs the provider chain;
// fetch_page reads one URL (SSRF-guarded). Both return the SAME structured McpToolResult shape.
const WEB_TOOL_NAMES = new Set(WEB_TOOL_DEFS.map(t => t.name));

// Provenance for the handoff gate: URLs the agent actually SAW this run — web_search results, fetched page
// URLs, and a fetched page's SAME-DOMAIN / known-booking-provider links (NOT arbitrary cross-domain hrefs).
// A booking handoff is only staged for a URL the web/venue actually PUBLISHED — never one the model invented,
// nor a phishing link a malicious page merely linked to. Module-level Set in the per-request MCP child.
const observedUrls = new Set<string>();
// Bound the provenance set so a LONG-LIVED MCP child (if the ADK reuses it across turns rather than spawning
// per-request) can't grow it unbounded. Sets keep insertion order, so deleting the first entry evicts the
// oldest. (Cross-turn provenance is low-risk — it only gates confirm-tier, no-payment handoff drafts.)
const OBSERVED_URL_CAP = 500;
function recordObserved(urls: (string | undefined)[]): void {
  for (const u of urls) {
    const n = u ? normHandoffUrl(u) : null;
    if (!n) continue;
    observedUrls.add(n);
    if (observedUrls.size > OBSERVED_URL_CAP) observedUrls.delete(observedUrls.values().next().value as string); // evict oldest
  }
}

async function handleWebTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (name === 'web_search') {
    const query = typeof args.query === 'string' ? args.query : '';
    const { provider, results } = await searchWeb(query);
    recordObserved(results.map(r => r.url));
    // Web text is UNTRUSTED (attacker-influenceable) — run title/snippet through the SAME sanitizer the doc
    // path uses (strips control chars / hidden-instruction tricks; the OUTINGS prompt guard is the primary
    // injection defense). URLs stay raw (validated by the provenance gate / SSRF guard).
    const safeResults = (Array.isArray(results) ? results : []).map(r => ({
      title: sanitizeForPrompt(r.title, 200), url: r.url, snippet: sanitizeForPrompt(r.snippet, 500),
    }));
    return {
      ok: true, tool: name, tier: 'auto', status: 'validated', artifact: safeResults,
      message: results.length ? `${results.length} web result(s) via ${provider}.` : 'No web results found.',
    };
  }
  // fetch_page — return the page's TEXT and its LINKS so the agent can use the venue's published Reserve link.
  const url = typeof args.url === 'string' ? args.url : '';
  // Web cache (roadmap "Web cache"): a FRESH cached copy skips the network. The persistence layer enforces
  // the 7-day TTL on read and is FAIL-SOFT (table not migrated yet / no household / any error = miss), so
  // the cache can only ever save a fetch, never break one. Cached links still feed the handoff provenance
  // gate below, and the message carries the honest dated framing so the agent can't present a week-old
  // page as live.
  const cached = persistence?.webCacheGet ? await persistence.webCacheGet(url) : null;
  if (cached) {
    recordObserved([url, ...trustedBookingLinks(url, cached.page.links.map(l => l.href))]);
    const cachedText = sanitizeForPrompt(cached.page.text, 20000);
    const cachedLinks = cached.page.links.map(l => ({ text: sanitizeForPrompt(l.text, 120), href: l.href }));
    return {
      ok: true, tool: name, tier: 'auto', status: 'validated',
      artifact: { url, text: cachedText, links: cachedLinks, cached: true, fetchedAt: cached.fetchedAt },
      message: `Read ${cachedText.length} chars and ${cachedLinks.length} link(s) from the cached copy — ${cachedFraming(cached.fetchedAt)}.`,
    };
  }
  const { text, links } = await fetchPage(url);
  // Cache the RAW extracted page for next time (best-effort, never throws). Sanitization runs on READ in
  // both the live and cached paths, so a sanitizer improvement applies to old rows too.
  if (persistence?.webCachePut) await persistence.webCachePut(url, { text, links });
  // Record the page itself + only its same-domain / known-booking-provider links (NOT every href, which
  // would let a planted cross-domain link pass the handoff provenance gate).
  recordObserved([url, ...trustedBookingLinks(url, links.map(l => l.href))]);
  // Sanitize the untrusted page text + link labels (same defense as web_search / the doc path); hrefs stay raw.
  const safeText = sanitizeForPrompt(text, 20000);
  const safeLinks = links.map(l => ({ text: sanitizeForPrompt(l.text, 120), href: l.href }));
  return { ok: true, tool: name, tier: 'auto', status: 'validated', artifact: { url, text: safeText, links: safeLinks },
    message: `Read ${safeText.length} chars and ${safeLinks.length} link(s) from the page.` };
}

function safeErrorMsg(err: any): string {
  const raw = String(err?.message || err || 'unknown error');
  const first = raw.split('\n')[0].slice(0, 200);
  return first.replace(/[A-Z]:\\[^\s"',)]+|\/(?:home|usr|app|tmp|var|src|node_modules)\/[^\s"',)]+/g, '<path>');
}

// Run one async (HTTP/Supabase) tool handler and shape its result as the MCP text response, with a UNIFORM
// honest catch (a failed McpToolResult) so a thrown handler never escapes as a transport error. Shared by the
// find_places / web / read / doc branches below (they differ only in which handler they call).
type ToolResponse = { content: { type: 'text'; text: string }[]; isError: boolean };
async function dispatchIO(name: string, run: () => Promise<McpToolResult>): Promise<ToolResponse> {
  try {
    const r = await run();
    return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok };
  } catch (err: any) {
    const failed: McpToolResult = { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `${name} failed: ${safeErrorMsg(err)}` };
    return { content: [{ type: 'text', text: JSON.stringify(failed) }], isError: true };
  }
}

// Dispatch a tool call to the pure handler. This slice uses a persistence-free context (server-local
// date, empty roster/events — the roster/events come from Supabase once persistence is wired); the
// result is the validated, tier-gated artifact returned as JSON text.
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  const today = clientToday || new Date().toISOString().slice(0, 10);
  // The async (HTTP / Supabase) tools are handled here, not via the pure registry dispatch below — each
  // through dispatchIO for one uniform error shape: find_places (discovery), web-research (SSRF-guarded),
  // READ tools (visitor-JWT reads), and Library doc move/delete.
  if (name === 'find_places') return dispatchIO(name, () => handleFindPlaces(args));
  if (WEB_TOOL_NAMES.has(name)) return dispatchIO(name, () => handleWebTool(name, args));
  if (READ_TOOL_NAMES.has(name)) return dispatchIO(name, () => handleReadTool(name, args));
  if (DOC_TOOL_NAMES.has(name)) return dispatchIO(name, () => handleDocTool(name, args));
  // prepare_handoff: server-enforced PROVENANCE gate. buildHandoffDraft already rejects non-http(s) + search-engine
  // links; here we additionally require the URL to have appeared in a web_search/fetch_page result THIS run
  // (the observedUrls check below — NOT a re-fetch) — so a bare/invented/"search for it" link can never become a
  // staged draft. This is the difference between an order-taker and a verified handoff.
  if (name === 'prepare_handoff') {
    const reject = (message: string): McpToolResult => ({ ok: false, tool: 'prepare_handoff', tier: 'confirm', status: 'rejected', message });
    try {
      const draft = buildHandoffDraft(args as any);
      if (!draft) {
        const r = reject('A handoff needs a REAL booking/registration URL (not a search link). Use web_search/fetch_page to find the venue’s actual reservation page first — or, if it takes no reservations, tell the parent it’s walk-in and stage nothing.');
        return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: true };
      }
      // PROVENANCE gate (not a re-fetch): only stage a URL the web/venue actually PUBLISHED this run — one that
      // came back in a web_search result or a fetch_page link. Rejects an invented URL (the model guessing
      // opentable.com/r/<name>) while accepting a real published one (a Yelp reserve link) WITHOUT re-fetching —
      // so bot-protected booking pages (Yelp/OpenTable) don't false-reject, and a "loads but invalid" page can't
      // false-accept. "The venue itself links to it" is a stronger proof than "it loads".
      if (!isLinkObserved(draft.link, observedUrls)) {
        const r = reject(`I won’t stage "${draft.link}" — I didn’t see that link published on any page I read, so it may be guessed. Use fetch_page on the venue’s official site and stage the exact Reserve/Book link it lists.`);
        return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: true };
      }
      const ok: McpToolResult = { ok: true, tool: 'prepare_handoff', tier: 'confirm', status: 'requires_confirmation', artifact: draft, message: `Action staged: ${draft.summary}` };
      return { content: [{ type: 'text', text: JSON.stringify(ok) }], isError: false };
    } catch (err: any) {
      const r = reject(`prepare_handoff failed: ${safeErrorMsg(err)}`);
      return { content: [{ type: 'text', text: JSON.stringify(r) }], isError: true };
    }
  }
  const tool = getTool(name);
  if (!tool || !tool.run) {
    // !tool.run is unreachable in practice: the only runless tool (prepare_handoff) is intercepted above.
    const miss: McpToolResult = { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `Unknown tool: ${name}` };
    return { content: [{ type: 'text', text: JSON.stringify(miss) }], isError: true };
  }
  // A persistence load/write can throw (RLS/network/no-household). Catch it and return the SAME honest
  // structured result the rest of the layer guarantees, rather than rejecting the request.
  try {
    // When persisting, validate against the visitor's REAL roster + events (so a chore for "Ava"
    // resolves and update_event can find its target); otherwise the persistence-free contract ctx.
    let ctx = buildToolCtx(today);
    if (persistence) {
      const [familyMembers, events, settings] = await Promise.all([
        persistence.loadCollection('members').catch(() => []),
        persistence.loadCollection('events').catch(() => []),
        persistence.loadCollection('settings').catch(() => []),
      ]);
      // Household-defined store lists (Phase-5): validate add_shopping_item stores against THEIR lists.
      const validStores = sanitizeStoreList((settings as any[])[0]?.storeList);
      ctx = buildToolCtx(today, { familyMembers: familyMembers as any, events: events as any, validStores });
    }
    const result = await persistResult(tool.run(args, ctx), persistence);
    return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !result.ok };
  } catch (err: any) {
    const failed: McpToolResult = { ok: false, tool: name, tier: 'auto', status: 'rejected', message: `Tool failed: ${safeErrorMsg(err)}` };
    return { content: [{ type: 'text', text: JSON.stringify(failed) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[family-hub-mcp] concierge MCP server ready — ${MCP_TOOLS.length + 1 + WEB_TOOL_DEFS.length + READ_TOOL_DEFS.length + DOC_TOOL_DEFS.length} tools over stdio.`); // +1 find_places; WEB_TOOL_DEFS was previously omitted (undercount)
}

main().catch((err) => {
  console.error('[family-hub-mcp] fatal:', err);
  process.exit(1);
});
