# Video script — ≤5:00, YouTube (public), attached to the Kaggle Media Gallery

**Recording setup:** 1080p screen capture of the LIVE Cloud Run demo in a fresh incognito window (no bookmarks bar). Second source: a phone/tablet clip for the kid-mode segment (optional but strong). Voiceover over captures; keep cuts tight — the rubric scores clarity + conciseness. Rehearse once against the clock; the demo beats below are pre-verified via the README Golden Path.

> Timing budget totals 4:40, leaving 20 s of slack. If a live beat drags, cut segment 7 (CLI) to a 5-second overlay — the concept is also evidenced in `agent/README.md`.

---

**[0:00–0:25 · HOOK + PROBLEM]** — *Title card → app on screen*
> "This is Family-Hub — an agent that runs our household. It plans the weekend, assigns the chores, watches the bills, and does the booking legwork. And here's the headline: it **provably cannot spend our money**. Running a family is a coordination job nobody applied for — and the reason we don't hand it to an AI is trust. So I built the trust first."

**[0:25–0:50 · WHY AGENTS]** — *Cut: the "plan a trip" ask being typed*
> "The valuable work isn't answering questions — it's multi-step: research the park's pass rules on the live web, check our calendar, draft the itinerary, find the real booking page and gather what its form will ask. That takes an agent that chooses tools and keeps going. Every capability is also blast radius — so the architecture is a safety stack with an agent inside."

**[0:50–1:25 · ARCHITECTURE]** — *Architecture diagram (docs/architecture.md render), cursor tracing the flow*
> "One copilot, two engines. Simple asks run a deterministic harness — the server pre-fetches verified facts: availability, weather, real venues with drive times — and the model reasons over *those*, so it can't invent a place. Action turns go to an ADK multi-agent concierge: a root router with **no tools of its own**, delegating to seven specialists, each MCP-filtered to its own slice — the shopping agent literally cannot touch the calendar. Every write carries a server-side risk tier: reversible creates auto-apply, everything destructive stages into Approvals, and there is **no payment tool to call** — that invariant is enforced in the MCP layer and proven by tests, not promised by a prompt."

**[1:25–3:20 · LIVE DEMO]** — *Fresh incognito → the Cloud Run URL*
1. *(1:25)* Click **Try the demo — no sign-in** → "Anonymous auth. Every judge gets an isolated, seeded household — the demo runs the production security model, row-level-security included."
2. *(1:35)* Tap **☀️ Preview today's briefing** → "The proactive morning agent. Closed-app, a scheduler runs this same planner: grounded in today's facts, it *proposes* — a gift for the birthday it sees, an umbrella for the rain it sees — and deterministic code stages the proposals as confirm-tier drafts. Model proposes, code stages, parent approves." → tap **Stage drafts** → open **Approvals**.
3. *(1:55)* Ask **"plan a Mount Rainier day trip next weekend and track it as a goal"** → while it thinks: "Watch three things: the goal strip, the web research, and the handoff." → show the **Goals strip** populating, the itinerary reply with real links, and **Actions** holding the pass handoff → "That booking URL isn't guessed — the server stages a handoff **only** for a link it watched the agent find on the venue's own page. And notice what a handoff IS: the real page opens in a new tab, with the details I'll need listed beside it. It can't fill the venue's form and it never submits — the typing and the final click are mine. Legwork *up to* the form."
4. *(2:40)* Ask **"buy the tickets and pay with our card"** → the refusal → "No refusal theater — there's no tool it could have called."
5. *(2:55)* Ask **"add a chore for Max to water the plants tomorrow morning"** → "✓ saved — routed to the chores specialist, persisted under this anonymous session's row-level security." → flip to **Chores**.
6. *(3:05)* Manage → **Kid mode: On** → *(phone/tablet clip if available)* → "The wall tablet is the kid surface. One toggle: picture-first chores for a four-year-old, confetti on completion — and every destructive tap is gone. The ask-box stays, because the worst a kid's request can do is stage a draft for a parent. Exit is a three-second hold plus the PIN." → tap a chore → confetti.

**[3:20–4:05 · THE BUILD (ANTIGRAVITY)]** — *Screen capture of Antigravity sessions over the repo*
> "Built solo, with an AI loop. **Google Antigravity** drove the architecture and review passes — here it is rendering the UI direction that shipped, and here running a multi-model code review that caught real findings before submission. The eval suite it helped shape does something rare for agent demos: it *attacks* the agent — payment requests, prompt injection in web pages and documents — and pins the safety invariants as tests: no specialist holds a payment tool, every persona refuses to narrate an action that didn't happen."

**[4:05–4:25 · DEPLOYABILITY + CLI]** — *Split: Cloud Run console / terminal*
> "Deployment is boring on purpose: two Cloud Run services plus a Cloud Scheduler cron for the morning agent, documented to reproduce; one `docker compose up` for the whole stack; and a zero-cloud LAN appliance that runs the same app on a Raspberry Pi with SQLite. The agent also runs straight from the ADK CLI —" *(terminal: `adk run concierge`, one exchange)*.

**[4:25–4:40 · CLOSE]** — *App on the Today page, goals strip visible*
> "Family-Hub. A multi-agent concierge with the safety story first: no-payment by construction, server-side tiers, provenance-verified handoffs, per-visitor isolation — and a four-year-old-safe front end. The link's below — click *Try the demo* and ask it for your weekend."

---

## Shot checklist (capture before editing)
- [ ] Title card (app name + tagline over the cover image)
- [ ] Architecture diagram render (docs/architecture.md — zoomed, readable)
- [ ] Fresh-incognito demo run: briefing → stage → approvals → trip ask → goals strip → Actions handoff → refusal → chore add → kid mode → confetti
- [ ] Antigravity: an architecture/review session over this repo (this is the ONLY place the rubric sees Antigravity — don't cut it)
- [ ] Cloud Run console (two services + scheduler job) · `docker compose up` scroll · `adk run concierge` exchange
- [ ] Cover image (also the Kaggle gallery cover): architecture + safety-stack diagram

## Rubric mapping (why each beat exists)
- Problem statement → 0:00 · Why agents → 0:25 · Architecture image + description → 0:50 · Demo → 1:25 · The build/tools → 3:20 (Antigravity), 4:05 (Deployability + Agent CLI = concepts #5/#6) · ≤5 min total.
