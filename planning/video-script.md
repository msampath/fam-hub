# Video script — ≤5:00, YouTube (public), attached to the Kaggle Media Gallery

> **FORMAT (final): deck + live demo + deck outro.** Minutes 0:00–2:10 = present
> **`planning/video-deck.pptx`** slides 1–8 (each slide's narration is in its speaker notes — that IS
> the script for the first two minutes; the Antigravity session capture drops into slide 7's beat).
> Minute 2:10–~4:25 = drive the LIVE demo following slide 8's six beats — spoken lines are in the
> LIVE DEMO section below. ~4:25 = cut back to **slide 9** (roadmap) for the close (its notes carry
> the closing narration).

**Recording setup:** 1080p. Part 1: present the deck full-screen (PowerPoint presenter view shows the notes). Part 2: fresh incognito window on the LIVE Cloud Run demo (no bookmarks bar; ask Claude to pre-warm the service first). Second source: a phone/tablet clip for the kid-mode segment (optional but strong). Voiceover over captures; keep cuts tight — the rubric scores clarity + conciseness. Rehearse once against the clock; the demo beats below are pre-verified via the README Golden Path.

> Timing budget totals 4:40, leaving 20 s of slack. If a live beat drags, cut segment 7 (CLI) to a 5-second overlay — the concept is also evidenced in `agent/README.md`.

---

**[0:00–0:25 · HOOK + PROBLEM]** — *Slide 1 (title card)*
> "This is Family-Hub — an agent that runs our household. It plans the weekend, assigns the chores, watches the bills, and does the booking legwork. Running a family is a coordination job nobody applied for — and the reason we don't hand it to an AI is trust. So I built the trust first with sensible security architecture and a setup that puts the human/adult back in the loop to make final decisions including but especially around purchase and spending money that the AI is structurally prevented from doing here."

**[0:25–0:50 · WHY AGENTS]** — *Cut: the "plan a trip" ask being typed*
> "The valuable work isn't answering questions — it's multi-step: research the park's pass rules on the live web, check our calendar, draft the itinerary, find the real booking page and gather what its form will ask. That takes an agent that chooses tools and keeps going. Every capability is also blast radius — so the architecture is a safety stack with an agent inside."

**[0:50–1:25 · ARCHITECTURE]** — *Architecture diagram (docs/architecture.md render), cursor tracing the flow*
> *(Optional one-liner if the beat runs short: "One design rule throughout: an agent exists where durable data exists — email finds become calendar records, so the calendar agent owns them; only bills keep their own store, so only bills got an agent.")*
> "One copilot, two engines. Simple asks run a deterministic harness — the server pre-fetches verified facts: availability, weather, real venues with drive times — and the model reasons over *those*, so it can't invent a place. Action turns go to an ADK multi-agent concierge: a root router with **no tools of its own**, delegating to seven specialists, each MCP-filtered to its own slice — the shopping agent literally cannot touch the calendar. Every write carries a server-side risk tier: reversible creates auto-apply, everything destructive stages into Approvals, and there is **no payment tool to call** — that invariant is enforced in the MCP layer and proven by tests, not promised by a prompt."

**[1:25–3:20 · LIVE DEMO]** — *Fresh incognito → the Cloud Run URL*
1. *(1:25)* Click **Try the demo — no sign-in** → "Anonymous auth. Every judge gets an isolated, seeded household — the demo runs the production security model, row-level-security included. And notice the top bar: **two review surfaces**. **Approvals** already has one waiting — a suggestion the copilot staged from a newsletter it read — that's everything the copilot will only do once I say yes. **Actions** is the other bucket: legwork it hands *me* to finish."
2. *(1:35)* Tap **☀️ Preview today's briefing** → "The proactive morning agent. Closed-app, a scheduler runs this same planner: grounded in today's facts, it *proposes* — a gift for the birthday it sees, the next step of a goal it's tracking — and deterministic code stages the proposals as confirm-tier drafts. Model proposes, code stages, parent approves." → tap **Stage drafts** → open **Approvals** (now 3) → Approve the nature-walk suggestion → it lands on the calendar.
3. *(1:55)* Ask **"plan a Mount Rainier day trip next weekend and track it as a goal"** → while it thinks: "Watch the goal strip and the web research." → show the **Goals strip** populating and the itinerary reply with real links → "Every venue and link in that itinerary came from live research it did just now — grounded, never guessed. It even checked our calendar for conflicts, and told us honestly that no timed-entry pass is needed this early in the season."
4. *(2:30)* Ask **"book us a dinner table for 4 Saturday at 7 at a great spot downtown"** → **Actions (1)** lights up → open it → "Here's the handoff: the restaurant's real reservation page — a link the server watched the agent find on a page it actually read, never guessed — **with the details the form will ask for gathered beside it**: date, time, party size. It can't fill the venue's form and it never submits — the typing and the final click are mine. Legwork *up to* the form."
5. *(2:50)* Ask **"and pay for it with our card"** → the refusal → "No refusal theater — there's no tool it could have called."
6. *(3:00)* Ask **"add a chore for Max to water the plants tomorrow morning"** → "✓ saved — routed to the chores specialist, persisted under this anonymous session's row-level security." → flip to **Chores**.
7. *(3:10)* Manage → **Kid mode: On** → *(phone/tablet clip if available)* → "The wall tablet is the kid surface. One toggle: picture-first chores for a four-year-old, confetti on completion — and every destructive tap is gone. The ask-box stays, because the worst a kid's request can do is stage a draft for a parent. Exit is a three-second hold plus the PIN." → tap a chore → confetti.

**[3:20–4:05 · THE BUILD (ANTIGRAVITY)]** — *Slide 7 + screen capture of Antigravity sessions over the repo*
> *(Slide 7's card frames Antigravity as: early dev pass · later planning, architecture, and code-review partner · multiple full UX/accessibility reviews of the shipped shell throughout planning and development.)*
> "Built solo, vibe-coded end to end. It started life as a **Google AI Studio** app; **Antigravity** ran an early dev pass and came back throughout as a planning, architecture, and code-review partner — here it is reviewing the shipped dark-mode shell for UX, responsiveness, and accessibility *(show an Antigravity review session on screen)*; the main development loop ran in Claude Code, with Gemini as the runtime brain the whole way. The eval suite does something rare for agent demos: it *attacks* the agent — payment requests, prompt injection in web pages and documents — and pins the safety invariants as tests: no specialist holds a payment tool, every persona refuses to narrate an action that didn't happen."

**[4:05–4:25 · DEPLOYABILITY + CLI]** — *Split: Cloud Run console / terminal*
> "Deployment is boring on purpose: two Cloud Run services plus a Cloud Scheduler cron for the morning agent, documented to reproduce; one `docker compose up` for the whole stack; and a zero-cloud LAN appliance that runs the same app on a Raspberry Pi with SQLite. The agent also runs straight from the ADK CLI —" *(terminal: `adk run concierge`, one exchange)*.

**[4:25–4:50 · ROADMAP + CLOSE]** — *Cut to slide 9 ("This week's roadmap — same safety spine")*
> "What's next keeps the same safety spine: real Kroger carts — their API literally has no payment endpoint, so the invariant holds by contract; a fully local, zero-dollar private mode; and deeper proactivity — every new capability still lands behind the same approval gate. Family-Hub. A multi-agent concierge with the safety story first — and a four-year-old-safe front end. The link's below — click *Try the demo* and ask it for your weekend."

---

## Shot checklist (capture before editing)
- [ ] Title card (app name + tagline over the cover image)
- [ ] Architecture diagram render (docs/architecture.md — zoomed, readable)
- [ ] Fresh-incognito demo run: briefing → stage → approvals → trip ask → goals strip → Actions handoff → refusal → chore add → kid mode → confetti
- [ ] Antigravity: an architecture/review session over this repo (this is the ONLY place the rubric sees Antigravity — don't cut it)
- [ ] Cloud Run console (two services + scheduler job) · `docker compose up` scroll · `adk run concierge` exchange
- [ ] Cover image (also the Kaggle gallery cover): architecture + safety-stack diagram
- [ ] Slide 9 ("This week's roadmap — same safety spine") — the outro card over the close narration

## Rubric mapping (why each beat exists)
- Problem statement → 0:00 · Why agents → 0:25 · Architecture image + description → 0:50 · Demo → 1:25 · The build/tools → 3:20 (Antigravity), 4:05 (Deployability + Agent CLI = concepts #5/#6) · ≤5 min total.
