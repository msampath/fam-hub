# Family-Hub: the safe household concierge

*An agent that runs your family's week.*

> **Draft for the Kaggle Writeup editor** (AI Agents: Intensive Vibe Coding Capstone · **Track: Concierge Agents**). Paste into the Writeup; attach the cover image + video; set the project links. Word target ≤2,500 (this draft ≈2,300).
>
> Links to fill at submission: https://family-hub-web-420776046740.us-central1.run.app (Cloud Run) · video: https://youtu.be/4S2k9VOpdBc · repo: https://github.com/msampath/fam-hub

---

## The problem

Running a family is a coordination job nobody applied for. Two parents juggle a shared calendar, school emails, chore charts, shopping lists, bills, and the endless research tax of "can we actually do this Saturday?" — does the park need a timed-entry pass, does the restaurant take reservations, will it rain during soccer? Every existing tool holds *one* sliver (a calendar app, a list app, a chore chart) and none of them *does the legwork*.

The obvious answer is an AI agent. The obvious problem is trust. A household agent touches the most personal data a family has — kids' schedules, home location, email-derived bills — and the last thing parents want is an autonomous system that can delete the calendar, leak the kids' whereabouts, or buy things. Most agent demos are impressive precisely because they're unsafe: full autonomy, no gates, credentials everywhere.

**Family-Hub's thesis: the interesting engineering problem isn't making a household agent act — it's making one a family can safely leave running.** This is the Concierge track's own framing ("safe and secure agents can free time for things that really matter"), taken literally as an architecture.

## Why agents (and not just an app)

The valuable work is multi-step and open-ended: *"plan a Mount Rainier day trip next weekend"* means researching pass requirements on the live web, checking the family calendar for conflicts, checking weather, drafting the itinerary, and finding the venue's real booking page with every detail the form will ask for. A form-based app can't do that; a single LLM call can't either — it has to **choose tools, observe results, and keep going**. That's an agent. But each capability the agent gains is also blast radius, which is why the safety architecture below is the core of the submission, not an afterthought.

## Architecture

```
"Try the demo" → Supabase anonymous auth (per-visitor, RLS-isolated, auto-seeded household)
React shell ─▶ Express (server.ts) ──▶ quick path: deterministic FACTS harness + one model call
                    │  /api/agent/chat (same-origin proxy, CSP-safe)
                    ▼
        FastAPI + ADK root Concierge ─ LLM delegation ▶ 7 tool-scoped specialists
                    │  MCP over stdio (Node child process, per-request)
                    ▼
        MCP toolbelt (Tool Registry) ─▶ Supabase Postgres (writes under the VISITOR's JWT)
        no-payment invariant + risk tiers enforced SERVER-SIDE

Cloud Scheduler ─▶ morning agent: digest email + grounded planner → confirm-tier drafts in Approvals
Gmail (opt-in, fields only) ─▶ inbox scans: bills → collection · packages/kids' events → one-tap adds
```

**Two engines, one copilot.** Simple asks run a *quick path*: the server pre-fetches verified FACTS blocks (dates, per-person availability, weather + AQI + pollen, real nearby venues with drive times, real ticketed events, the household's document corpus) and makes **one** grounded model call. This is a deliberate reliability pattern — the model reasons over server-verified data instead of tool-calling for reads, so a small model can't hallucinate a venue. Action and planning turns route to the **ADK multi-agent concierge**: a root router that holds *no tools* and delegates to seven specialists (calendar / chores / shopping / outings / briefing / bills / files), each connected to the MCP toolbelt through a per-specialist `tool_filter` — a specialist *cannot call a tool outside its slice*. The split buys tool-scoping and small-model routing reliability; `outings_agent` is the deep loop (research → plan → execute → handoff), and the others are honest thin adapters.

**Capabilities ≠ specialists — agents exist where durable data exists.** One taxonomy note the design enforces: inbox intelligence surfaces three kinds of finds from email (bills, package tracking, kids' events — parsed fields only, bodies never stored), yet only *bills* grew a specialist. That's deliberate: bills persist as their own queryable collection, so there's real state for an agent to answer from (`get_bills`, read-only). Package and event finds are one-tap suggestions that become *calendar* records the moment you accept them — from then on the calendar capability owns them. We add an agent where a durable store exists, not one per feature; that keeps every specialist honest about what it can actually know.

**MCP as the enforcement layer.** The Node MCP server (stdio child of the Python service) wraps the app's working Tool Registry. Every mutating tool carries a server-assigned **risk tier**: auto (reversible creates apply immediately), **confirm** (updates, deletes, cart drafts, booking handoffs — staged into an Approvals queue the parent resolves), **step-up** (a server-side scrypt PIN). The tiers live in the tool layer, never in the prompt — a jailbroken model still can't skip a gate.

**Per-visitor isolation.** Each `/chat` request rebuilds the agent graph with the caller's Supabase JWT; the MCP child persists under that JWT, so Postgres row-level security scopes every write to that visitor's household. The public demo uses Supabase *anonymous* auth: one click, no account, and each judge gets their own seeded, isolated household — the demo reuses the production security model instead of bypassing it.

## The safety thesis (what makes this a *concierge*)

1. **The no-payment invariant — structural, not policy.** No pay/checkout/transfer tool *exists* anywhere in the registry, and `agent/tests/test_eval.py` proves it: tests assert no specialist's allowlist contains a payment-shaped tool, and that every persona carries the no-money rule. "Add to cart" and reservations produce **drafts you complete yourself**. Worst-case prompt injection ≈ a wrong calendar draft — all reversible, and the app stays out of PCI scope entirely.
2. **Provenance-gated handoffs.** An LLM will happily guess `opentable.com/r/<restaurant>`. Family-Hub's `prepare_handoff` is gated by the MCP server: it stages a booking URL **only if that exact URL was observed in this run's `web_search`/`fetch_page` results** — a link the venue actually publishes. Guessed links are rejected server-side, with the rejection surfaced honestly. And a handoff is exactly that: the parent gets the venue's real page in a new tab plus the *details to enter* (date, party size, pass type) listed beside it — a plain link **cannot fill the venue's form**, and the agent never submits, books, or pays.
3. **Grounded, never fabricated.** Venue and event suggestions must reference server-verified facts (real Places results with real links, real ticketed events); the server drops anything it can't verify. Web page text is sanitized and treated as *data* — every persona that reads external content (web, email-derived bills, uploaded docs) carries an explicit injection guard, exercised by a live eval suite.
4. **Honest capability reporting.** The IoT tool returns `unavailable` (no fake success); every persona forbids narrating an action whose tool call didn't succeed *this turn*; the briefing agent is read-only. When a claim can't be made safely, the agent says so. Both engines also carry a **uniform scope guard**: off-domain asks (code, homework, general math) get one polite decline and a redirect back to household work — the same answer every time, from "the family's copilot", never from a model persona.
5. **Kid mode (new for this submission).** The wall tablet is the kid surface, so one toggle locks the device to an age-4-safe view: picture-first chore cards (a pure title→emoji map), confetti on completion, and **every destructive tap hidden** across chores, shopping, docs, events, and goals. The copilot input deliberately *stays*: because destructive tools are confirm-tier by construction, the worst a child's request can do is stage a draft a parent later reviews. Exit is a 3-second hold plus the step-up PIN when set. Safety here isn't a mode — it's the same server-side tiering doing double duty.
6. **Auditability.** Every agent action lands in an append-only ledger (tool, tier, payload snapshot, who approved); copilot turns are logged structured. The email pipeline stores parsed fields, never bodies.

## The flagship: a proactive morning agent

Most submissions are reactive chatbots. Family-Hub's scheduler runs a **closed-app morning planner**: for each opted-in household, one grounded model call reads the day's verified FACTS — agenda, weather, open chores, the shopping list, *tracked goals*, and what's already pending — and proposes up to three concrete next actions ("Rain 80% during soccer — umbrella?", "Grandma's birthday Friday — gift?", "Next step for the Rainier trip — park pass"). **The model proposes; deterministic code stages; the parent approves.** The validator hard-codes confirm-tier and pending status, clamps dates to a 14-day horizon, allowlists goal ids, and dedupes against the live list — structurally, nothing the model emits can auto-apply. Proposals that serve an open goal carry its `goalId`, so approving one *advances the goal* — the multi-step loop keeps moving while the app is closed. The concierge authors the email narrative from the same facts, and the identical planner powers the in-app "Preview today's briefing" card (judges don't wait for a 7 a.m. cron; its proposals stage client-side under the visitor's own RLS identity).

Elsewhere in the loop: the quick path runs a **bounded critic** (invalid actions trigger up to two corrective re-prompts, each adopted only if it strictly reduces verified issues); staged drafts support **human-in-the-loop "Modify"** ("make it vegetarian" recalculates just that draft, still pending); and the outings loop tracks its work as a **goal** with visible steps.

## Course concepts demonstrated (6 of 6)

| Concept | Evidence |
| --- | --- |
| **Multi-agent (ADK)** | `agent/concierge/agent.py` — root + 7 tool-filtered specialists, LLM delegation; structure pinned by offline pytest |
| **MCP server** | `src/mcp/server.ts`, `conciergeTools.ts` — stdio toolbelt; tiers + no-payment + provenance enforced here |
| **Security** | Everything above + helmet/CSP, SSRF guard with per-hop IP pinning, scrypt step-up PIN, RLS isolation, kid mode |
| **Deployability** | Cloud Run (two services + Cloud Scheduler) with a reproduce-the-deploy doc; one-command `docker compose up`; a zero-cloud LAN appliance (SQLite) with prebuilt GHCR images |
| **Agent skills / CLI** | `adk run concierge` / `adk web` (shown in the video) |
| **Antigravity** | Used throughout the build for architecture + review loops — shown in the video's build segment |

`KAGGLE_EVAL:` comment anchors sit at each concept's implementation for machine-legible review.

## Try it

- **Live demo (no login):** https://family-hub-web-420776046740.us-central1.run.app → *Try the demo* → follow the README's 7-step **Golden Path** (grounded ask → agent write → multi-step trip with goal + verified handoff → **the payment refusal** → morning planner → kid mode).
- **Repo:** https://github.com/msampath/fam-hub — machine-first README (Concept→Evidence table, Mermaid architecture), 925 Vitest tests + offline agent-structure pytest + a live refusal/injection eval, `docker compose up --build` for the full stack.

## Honest limitations

The demo agent service runs `--allow-unauthenticated` with per-visitor RLS as the real boundary (fine for a demo; a private deployment would add IAM). Agent sessions are in-memory per instance (`InMemorySessionService`) — goals re-inject as grounded text each turn, which also survives model fallback. The scheduled digest runs on a live Cloud Scheduler cron (verified in production); email *delivery* beyond the account owner waits on a verified sender domain (Resend's sandbox restriction — send failures are logged, never silent). The cron endpoint is gated by a ≥32-char shared secret (hash-then-`timingSafeEqual`) rather than IAM ingress. Email scanning is disabled in the public demo. Free-tier Gemini capacity 503s are absorbed by a model-fallback chain with bounded retries — and when every model is down, the AI degrades to a non-blocking notice while calendar/chores/shopping keep working.

## Roadmap: the $0 local concierge

The deliberate next arc is **cloud → local**: the quick path already ships an Ollama integration behind a flag (`LOCAL_LLM_ENABLED`, schema-converted structured output, think-mode support, Gemini fallback), benchmarked on `gpt-oss:20b` (16 GB VRAM). Post-capstone: an eval harness replaying the app's golden prompts across engines (action validity, critic pass-rate, grounding adherence), the ADK concierge on a local model via LiteLLM, and the per-turn Escalate control re-enabled as the local↔cloud bridge — a household concierge whose data and inference never leave the house. Also queued: routine mining from the append-only logs (learned staples and rhythms as reviewable suggestions), durable agent jobs, and Home Assistant integration behind the existing step-up tier. The next rung of the authority ladder is deliberate too: **browser-assisted form-fill** (an agent-driven browser types the gathered details into the venue's form and stops before submit) is designed for the step-up PIN tier — but it stays roadmap until the pre-submit side effects (inventory holds), bot-defense/ToS reality, and the PII-injection surface of auto-typing into fetched pages each have an answer. Today the human types; that's a feature. Where a retailer offers a *sanctioned* path, the ladder climbs sooner: Kroger's public Cart API (Fred Meyer/QFC) can turn the existing `add_to_cart` draft into a real cart write — recipe → pantry-diffed missing items → product-matched at the family's own store → approved into the cart — while checkout remains structurally impossible for the agent (the public API simply has no payment endpoint).

## The build

Built solo, vibe-coded end to end — across the toolchain this course is about. The project **started as a Google AI Studio app** (which generated the first working UI); **Google Antigravity** ran an early dev pass and later a detailed **code review of the shipped dark-mode shell** (UI/UX, responsive design, accessibility); the main development loop ran in **Claude Code**; and **Gemini** is the runtime brain throughout. The safety posture came from adversarial self-review — a security pass (CSO-style findings, several fixed pre-submission), a FinOps pass that caught a worst-case cost cascade, and an eval suite that tries to make the agent pay for things. The most useful lesson: **the reliable way to make a small model agentic is to move truth out of the model** — pre-fetch the facts, verify the outputs, gate the writes, and let the LLM do the one thing it's uniquely good at: deciding what's worth doing.
