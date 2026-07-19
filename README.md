# Family-Hub — Family Manager

An AI-powered family coordination app for managing schedules, chores, and shopping. Built with React 19 + Express, backed by Supabase for real-time cross-device sync, and powered by Google Gemini for calendar extraction, natural-language quick-add, and an agentic planning copilot.

> Project meta: [`CHANGELOG.md`](./CHANGELOG.md) · [`CONTRIBUTING.md`](./CONTRIBUTING.md) · [`SECURITY.md`](./SECURITY.md)

## Three ways to run it

1. **LAN appliance — SQLite, the recommended self-host path.** One compose command on any always-on
   Docker box; no accounts beyond a free [Gemini key](https://aistudio.google.com/apikey), data in a
   local SQLite file. Install guide: [`docs/INSTALL.md`](./docs/INSTALL.md) · architecture + security
   model: [`docs/lan-appliance.md`](./docs/lan-appliance.md).
2. **Local dev.** `npm install`, copy `.env.example` → `.env` (a Gemini key is enough — storage
   defaults to SQLite), then `npm run dev` at `http://localhost:4894`. Add Supabase for cloud sync.
   Details: the [Setup](#setup) section below.
3. **Cloud — Supabase + Cloud Run.** Google OAuth + Postgres/RLS via Supabase, two Cloud Run
   services (web + agent), Cloud Scheduler for the morning agent. Walkthrough:
   [`docs/cloud-run-deploy.md`](./docs/cloud-run-deploy.md).

> Self-hosters bring their **own** credentials: register your own Google OAuth client (sign-in +
> Calendar sync, cloud mode) and — optionally — your own Kroger developer app for send-to-cart.
> Every knob is documented in [`.env.example`](./.env.example).

---

## 🏠 Run it on your own LAN (zero-cloud self-host appliance)

Want the whole thing — calendar, chores, shopping, and the AI copilot — on a box on your **home network**,
with **no accounts and no cloud bills**? The **LAN appliance** keeps your data in a local SQLite file and runs
the AI on *your* free [Google AI Studio key](https://aistudio.google.com/apikey). One family per box.

```bash
# on any always-on Docker host (mini-PC, NAS, an old laptop, a Pi 4/5):
curl -fsSL https://raw.githubusercontent.com/msampath/fam-hub/initial-push/scripts/install.sh | sh
```

Then open `http://<box-LAN-ip>:4894` → set a household passphrase. Full guide (prebuilt images, manual,
build-from-source, **local-model option**, backup, security posture): **[`docs/INSTALL.md`](./docs/INSTALL.md)**.

> The `docker compose up --build` mentioned below is the **cloud/demo** stack (needs Supabase). For the
> zero-cloud box, use the appliance install above.

---

## 🛎️ The safe AI household concierge (Kaggle capstone — Concierge track)

*(In the app UI this assistant is the **Copilot**; "Concierge" is its internal engine + Kaggle-track name.)* Beyond the app, Family-Hub's headline is **an agent that runs the household**: a root **Concierge** engine that delegates to specialist sub-agents to create events, assign chores, draft shopping/carts, **find real nearby venues**, **research real-world logistics on the live web** (does the park need a timed-entry pass?), and **close the loop** by handing you the venue's real booking/permit page with every detail you'll need gathered beside it — all behind hard safety gates. It does the legwork **up to** the form: it researches → plans → executes the steps it can → hands you the real page + the details to enter (a plain link can't fill the venue's form, and the agent never submits). Under the hood it's a **router + tool-scoped specialists**: most specialists are thin (they turn a request into one safe CRUD call), and the split exists for **tool-scoping** (a specialist can't call a tool outside its slice) and **small-model routing reliability** — not per-agent autonomy. `outings` is the one that runs the full research → plan → handoff loop. The thesis is **safety**:

- **🚫 No-payment invariant** — the agent never holds payment credentials or completes a purchase/transfer. "Add to cart" and reservation **handoffs** produce *draft links* you complete yourself, so even a worst-case prompt injection can't move money (and the app stays out of PCI scope).
- **Server-authoritative gates** — the risk tiers (auto / confirm / step-up-PIN) and the no-payment rule are enforced in the MCP tool layer, never trusted to the model.
- **Grounded, not hallucinated** — the copilot names only real, server-verified venues/events (by id, with real links); with no location data it offers generic ideas instead of inventing a place.

**Try it with no sign-in** — the "Try the demo" button uses Supabase anonymous auth → a seeded, per-visitor-isolated sample household. Or bring up the whole stack in one command: `docker compose up --build`.

**🔗 Live demo: https://family-hub-web-420776046740.us-central1.run.app**

**Golden path (3 minutes, no account)** — every step below is live at that URL:
1. Click **Try the demo — no sign-in** → a seeded household (You, Ava, Max) loads with events, chores, bills, and a home location.
2. Ask the copilot **"what does our week look like?"** → a grounded, day-accurate answer from the deterministic FACTS harness.
3. Say **"add a chore for Max to water the plants tomorrow morning"** → the ADK concierge routes to `chores_agent` → MCP `add_chore` persists under *your* anonymous session's RLS scope → "✓ 1 change saved".
4. Say **"I want to make paneer butter masala"** → the shopping specialist derives the recipe *itself* (you never list ingredients) and adds ~15 family-scaled items routed by store — paneer & garam masala to **Indian Store**, cream & tomatoes to **Grocery Store** — then tells you how to remove any.
5. Say **"plan a Mount Rainier day trip for the family next weekend and track it as a goal"** → the `outings` loop researches real logistics on the live web, tracks a goal (watch the Today **Goals** strip), and stages a **provenance-verified** booking handoff in **Actions**.
6. Say **"buy the tickets and pay with our card"** → the refusal: *"My tools don't handle money"* — the no-payment invariant, live.
7. Tap **☀️ Preview today's briefing** → the morning planner proposes next actions (grounded in the seeded facts); stage them into **Approvals** with one tap.
8. Manage → **Kid mode: On** → the device locks to the age-4-safe surface (picture chores, no destructive taps); hold the 🔒 3 s to exit.

```
"Try the demo" → Supabase anonymous auth (per-visitor, RLS-isolated, auto-seeded household)
React surface ─▶ ADK Concierge agent ─delegates▶ specialist sub-agents
                       │  MCP over stdio (Node MCP server spawned as a child process)
                       ▼
                Tool Registry tools ─▶ Supabase  (writes under the visitor's JWT)
                no-payment invariant + risk tiers enforced SERVER-SIDE; IoT honestly "unavailable"

Cloud Scheduler ─▶ morning agent: digest email + a grounded planner pass that STAGES
                confirm-tier drafts (shopping · events · a goal's next step) into Approvals
```

### Concepts → evidence

| Concept | Where | What |
| --- | --- | --- |
| **Agent / Multi-agent (ADK)** | [`agent/concierge/agent.py`](./agent/concierge/agent.py) | Root Concierge + **8 tool-scoped specialists** (calendar / chores / shopping / meal-planner / outings / briefing / bills / files); LLM-driven delegation. The split buys tool-scoping + routing reliability over per-agent autonomy; chores now do full CRUD (add/edit/delete), shopping adds add/delete + pantry, the **meal-planner** plans the week AND derives one consolidated shopping list, and **`outings`** runs a full multi-step loop (research → plan → handoff) and tracks the work as a **goal** |
| **MCP server** | [`src/mcp/server.ts`](./src/mcp/server.ts) · [`conciergeTools.ts`](./src/mcp/conciergeTools.ts) | Stdio MCP server wrapping the working Tool Registry — the agent's toolbelt: mutating tools (create_event / **update_event** / **delete_event** / add_chore / **delete_chore** / **clear_chores** / **update_chore** / add_shopping_item / **delete_shopping_item** / **add_pantry_item** / **delete_pantry_item** / **set_goal** / **delete_goal** / **set_meal_plan** / **delete_meal_plan** / **add_to_cart** / **prepare_handoff**; `reserve` is defined but **not granted** to any specialist — superseded by the provenance-gated `prepare_handoff`), read tools (get_events / get_chores / get_upcoming / get_bills / search_local_knowledge), discovery (find_places), web research (**web_search / fetch_page**), and doc CRUD (move_document / delete_document). Destructive ops (delete/clear/update) are **confirm-tier** — staged in Approvals, applied on approval |
| **React ↔ agent + isolation** | [`agent/api.py`](./agent/api.py) · [`server.ts`](./server.ts) · [`src/utils/agentClient.ts`](./src/utils/agentClient.ts) | React → same-origin `/api/agent/chat` (Express proxy, CSP-safe) → FastAPI `POST /chat`; the visitor's JWT is forwarded so the MCP child's writes are RLS-scoped to that visitor |
| **Proactive agency** | [`src/utils/morningAgent.ts`](./src/utils/morningAgent.ts) · [`server.ts`](./server.ts) (`runDailyDigest`) | The closed-app **morning planner**: one grounded model call per household proposes next actions (incl. an open goal's next step); pure validation stages them **confirm-tier** — the model proposes, the code stages, the parent approves. Same planner behind the in-app briefing preview |
| **Security** | [`src/mcp/conciergeTools.ts`](./src/mcp/conciergeTools.ts) · [`server.ts`](./server.ts) | No-payment invariant + risk tiers in the tool layer; helmet/CSP; step-up PIN (scrypt, server-side); **kid mode** device lock (destructive taps hidden; the ask-input stays because destructive tools are confirm-tier by construction) |
| **Deployability** | [`Dockerfile`](./Dockerfile) · [`docker-compose.yml`](./docker-compose.yml) | One image (Python ADK + Node MCP child) → Cloud Run; `docker compose up` for the full stack |
| **Agent CLI** | [`agent/README.md`](./agent/README.md) | `adk run concierge` / `adk web` |
| **Antigravity** | (build loop) | Ran an **early dev pass**, then a detailed **code review of the shipped dark-mode shell** (UI/UX · responsive design · accessibility) — the project started as a Google AI Studio app; the main dev loop later ran in Claude Code; shown in the demo video |

> **More docs:** illustrated user guide (every feature, with screenshots) → [`docs/user-guide.md`](./docs/user-guide.md) · architecture diagrams → [`docs/architecture.md`](./docs/architecture.md).

---

## Features

- **Google sign-in + header account menu** — the app opens to a sign-in screen; a header avatar chip shows your account and signs you out. All data is tied to your account and synced to the cloud
- **Idle screensaver (always-on display friendly)** — after a configurable idle window (Off / 5 / 15 / 30 / 60 min, set in the account menu) the screen blanks to a near-black, power-saving view with a dim drifting clock (no OLED burn-in); any tap wakes it and **refreshes data from the cloud before showing content** (and rolls the weekly chore reset if a new week started). A header **Refresh** button does the same on demand. Optional **security auto-sign-out** after a longer idle ("Sign out after", default Off)
- **Unified Calendar** — Monthly/weekly view with color-coded members and categories; events can be **all-day or timed** (optional start/end times, shown on cards and synced to/from Google), and each event can be marked **free / busy** ("Counts as") to correct how the copilot reads availability
- **Today / Tomorrow digest** — an at-a-glance agenda strip at the top of the calendar (today's & tomorrow's events + chores still due today)
- **Installable PWA + reminders** — install to a phone/tablet home screen (manifest + service worker); opt into a configurable **daily reminder** (today's events + still-due chores) **and per-event "X min before" alerts** for timed events (account menu). Local/on-device (fires while the app is open — great for an always-on display); no server push
- **Natural-language quick-add** — one box turns "Swim Tue 4pm Leo" into an event, "milk x2 costco" into a shopping item, or "Leo brush teeth nightly" into a chore (Gemini-classified)
- **Universal upload (paperclip → Files / Web URL / Paste text)** — drop a **.pdf / .docx / .xlsx / .txt / .md** file, paste text, or point at a web page; by default it's saved to the **Docs Library** (the copilot's readable memory) under a folder you choose, or tick **"is this a calendar?"** to route the same input through Gemini event extraction onto the calendar instead
- **Google Calendar Sync** — Pull events from individual family Google Calendars; push back local events
- **Recurring-event warnings** — a daily Google series expanded into many cards is flagged with one-click bulk delete
- **Persistent deletion for synced events** — deleting a Google-pulled event (or a whole recurring series) hides it from future syncs instead of letting it return on the next pull; a "Hidden from sync" card in the Sync panel restores any of them
- **Smart Deduplication** — Signature-based merge (title + start + end) on the import/sync paths; no duplicate cards
- **Cross-Device Sync** — Supabase backend keeps all family members in sync; invite a household member via 16-character code
- **Shopping Lists** — Organized by store (Costco, Indian Store, Grocery, Other), with **staples** (one-tap re-add), **dish/recipe → list** (type a dish name — *"paneer butter masala"* — or paste a full recipe, in the Recipes box **or straight to the copilot**: it derives the ingredients itself, in **buy units a store actually sells** — "400 g pack", "small bag", never "2 tbsp" — routed to the right store), **pantry → restock** (track what you have; Gemini suggests what to refill), **pantry → meal plan** (3 dinners from what you have + only the missing groceries), and **📸 photo intake** — snap a fridge or receipt photo and a vision pass detects the items, diffs them against your pantry, and stages only the new ones for a one-tap confirm. Plus **Kroger send-to-cart** — the first fully closed agentic loop: connect the Kroger API once in Manage → Groceries, pick the connection's store ("Shop at → Fred Meyer - Issaquah") and link lists to it; every linked list gets its own **Send** button (or take the one-tap offer after a dish ask). Items are matched to real products by a schema-enforced model pick-or-decline (declines get one automatic second pass) and staged as **one Approval** with per-item mappings + honest unmatched reasons — approve it and they land in your actual Kroger cart, while payment stays in Kroger's own app (the public Kroger API has no checkout endpoint — safety by contract). Setup: [docs/kroger-setup.md](docs/kroger-setup.md)
- **Weekly Meal Planner** — give the copilot the week's meals (*"plan next week's lunches: rajma chawal, tacos, paneer butter masala…"*) and one agentic turn plans the week AND derives **one consolidated, buy-unit, store-routed shopping list** (garlic once, not four times). Plans **any meal** (dinners by default; lunches/breakfasts on request — they coexist per week); resolves *"next week"* as the next 7 days starting tomorrow; is **diet-aware** (a lacto-vegetarian family's tacos use beans/paneer, never meat — but keeps dairy, since *lacto*); skips days you flag as covered ("we're out", "eating out"). Full CRUD (*"delete the planned lunches"*, *"swap Thursday to rajma"*). Lands on a **This week's meals** strip on Today (not noisy calendar events) with "🍽 Dinner tonight/tomorrow" lines in the briefing; *"what's for dinner Tuesday?"* answers locally. Chains into Kroger send-to-cart: plan → list → real cart.
- **Chores Tracker** — Per-kid assignment with gamified XP, levels, and weekly banking; picture-first cards (a pure title→emoji map, so pre-readers navigate by icon) and a confetti celebration when a chore's last rep is checked off. From the empty state, an **AI starter chore plan** generator asks each kid's age and drafts an age-appropriate plan the parent reviews (per-kid preview, untick anything) before it's added
- **Kid Mode (age-4-safe device lock)** — one toggle in Manage locks a wall tablet to the kid-safe surface: Manage/Approvals/Actions/Import and **every destructive tap** (deletes across chores, shopping, docs, events, goals) are hidden, while check-offs and the copilot ask-input stay (safe by construction — every destructive tool is confirm-tier server-side, so a kid's request can only *stage* a draft a parent later reviews). Exit = hold the 🔒 3 s, plus the step-up PIN when one is set
- **Name your copilot** — a Manage setting lets the family (read: the kids) rename the copilot; the bar, the goals strip, the greeting, and **both engines** answer to it (*"what's your name?" → "I'm Sparkles!"*). Synced household-wide; resets on sign-out so the next family doesn't inherit it
- **Agentic AI Copilot** — ask it to find free weeks or flag conflicts, **and** have it create events, chores, and shopping items for you (create-only, validated, capped). Activity suggestions are grounded in **real nearby venues (with drive times) and real dated events** plus the live weather, so it recommends specific places by name — not vague categories. The grounding gate fires on planning queries (`isPlanningQuery`) **or** proximity/food queries (`isPlacesQuery`) — so "a coffee shop within 15 min" gets full grounding too. The HOME label is always injected when set, so the copilot never asks for a city or ZIP. **Suggestions are grounded + verified, never fabricated:** a recommended venue/event must reference a real server-provided fact (the copilot names a specific place only from its PLACES/EVENTS list, and the server drops any it can't verify), each carries a **real link** (official site → Google Maps), and when no location is set it offers generic ideas instead of inventing a place; the "something different" pick is a real *lesser-known gem*, not a made-up one. Chat renders **markdown** (clickable, new-tab links); action/planning turns route to the **cloud agent** (multi-step, web-aware) automatically — the per-turn Escalate control stays wired but disabled until the local engine ships (see the engine strategy note below).
- **Web research + loop-closing handoff** — the cloud concierge can search the live web (provider chain **Tavily → Google CSE → Brave → keyless DuckDuckGo**, so it works with zero keys) and read a page to learn real logistics (a pass requirement, hours, a ticket URL) **before** recommending; then `prepare_handoff` stages the **real** booking/form URL — one it actually found **published on the venue's own page** (server-verified by provenance, so a *guessed* link like a wrong OpenTable URL is rejected) — with the **details you'll need to enter** (party size, date, pass type…) listed beside the link. Opening it is a plain new-tab link: the agent **cannot fill the venue's form and never submits or pays** — you type the details and make the final click (no-payment invariant).
- **Goals the copilot is tracking** — a small Today strip of open multi-step goals + their next action, so longer tasks follow through and stay visible.
- **Self-correction (critic/verifier)** — the quick-path copilot's action JSON is verified server-side (chore assignee in the roster, valid future dates, titled events); a near-miss triggers a **bounded corrective loop** (≤2 passes, each adopted only if it strictly reduces the verified issue count) instead of being silently dropped.
- **Human-in-the-loop "Modify"** — a staged Approvals draft has **Modify** next to Approve/Dismiss: type "make it vegetarian" / "Tuesday instead" and the agent recalculates just that draft, restaged in place (still a draft, still pending).
- **Proactive morning agent (closed-app)** — each morning the scheduler runs a real **planner pass**: one grounded model call reads the household's verified FACTS (agenda, weather, open chores, shopping list, tracked goals, drafts already pending) and proposes up to 3 concrete next actions — a shopping item, an event suggestion, or **the next step of an open goal** (approval advances the goal). Deterministic code validates every proposal and stages the survivors as **confirm-tier drafts** in Approvals: the model proposes, the code stages, the parent approves. The two hard-coded nudges (birthday gift, rain→umbrella) still run as the model-down fallback, and the same planner powers the in-app **"Preview today's briefing"** card (its proposals stage client-side under your own account), so the closed-app behavior is demoable on demand.

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19 + TypeScript, Tailwind CSS, `motion/react` |
| Backend | Express (Node.js) — Gemini API proxy |
| Auth & DB | Supabase (Google OAuth, PostgreSQL + JSONB blob storage) |
| AI | Google Gemini — one model knob **`COPILOT_MODEL`** (both engine tiers read it; the appliance defaults to `gemini-3.1-flash-lite` for its larger free-tier quota). Optional **local model via Ollama** for the quick-path copilot (`LOCAL_LLM_ENABLED`, off by default) |
| PWA | Web app manifest + service worker (installable, offline shell, local notifications) |
| Build | Vite (client), esbuild (server) |
| Tests | Vitest + jsdom + React Testing Library (pure-logic **and** component tests) |

### Architecture

- State lives in `App()` and is shared through two typed contexts: `AppContext` (`useApp()`) and `CalendarContext` (`useCalendar()`).
- **Presentation layer — copilot-first dark shell** (`src/components/shell/*`): `DarkShell` renders one persistent **copilot bar** (single input · Ask/Do/Approve · a **Manage** overlay) above four full-bleed, horizontally-swipeable pages — **Today · Chores · Shopping · Library** (touch-swipe + desktop arrows/keyboard/dots). Today shows live weather (keyless Open-Meteo, `src/utils/weatherClient.ts`) and opens a month-grid calendar overlay; Chores breaks a selected kid into Morning/Afternoon/Evening; Manage holds account/family/sync/import. The shell's overlays reuse the surviving calendar components (`AddEventModal`, `GoogleSyncPanel`) alongside the shell's own `CalendarOverlay` + `EventSheet`.
- **Core/common services** keep cross-cutting logic in one place:
  - `usePersistedCollection` + a central `COLLECTIONS` registry — single source of truth for every synced collection's localStorage cache, Supabase save, bootstrap load, and join-replace (adding a collection is one entry).
  - `callGeminiJSON` on the server — shared Gemini-call scaffolding for all `/api/parse-*` + `/api/copilot`. Runs on Gemini by default; an **optional local model via Ollama** (`LOCAL_LLM_ENABLED`, off by default) can serve the text-only quick path, falling back to Gemini on any failure (image prompts stay on Gemini). The copilot's quick path runs a **deterministic grounding harness** (`src/utils/copilotHarness.ts`) — instead of relying on tool-calling for reads, the server pre-fetches + injects FACTS blocks (DATE · AVAILABILITY · LONG-WEEKEND · WEATHER+AQI+pollen · PLACES with drive times · EVENTS), so the model reasons over real data and admits when it has none. Resilience: retry-with-backoff → model fallback, malformed-response recovery, token caps; date-aware + create-action dedupe.
  - `utils/aiActions.ts` — pure, tested validators/builders that clamp AI output (quick-add + copilot) before it touches state.
  - `bootstrapSignedInUser` — the post-sign-in bootstrap (household load, name prompt, first-sign-in auto-connect) extracted from the auth listener.

---

## Setup

### Prerequisites

> This Setup section is the **cloud / development** path (Supabase + Google OAuth). To run the zero-cloud
> **LAN appliance** instead, follow [`docs/INSTALL.md`](./docs/INSTALL.md) — it needs only Docker + a free Gemini key.

- Node.js **v22.5+** — the appliance's default SQLite backend uses the built-in `node:sqlite` (v18/20 cannot run it; `npm` enforces this via `engines`)
- A [Supabase](https://supabase.com) project (free tier works) — *cloud mode only*
- A Google Cloud project with the Calendar API enabled — *cloud mode only*

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```env
GEMINI_API_KEY=your_gemini_api_key

VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Same Client ID + Secret used for the Supabase Google provider.
# Required so Google Calendar sync keeps working after a page reload.
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

> **Gemini model & quota:** the copilot model is one knob — **`COPILOT_MODEL`** (both engine tiers read it; the appliance uses `gemini-3.1-flash-lite`). Optionally pin a fallback chain with **`GEMINI_FALLBACKS`** / **`CONCIERGE_FALLBACK`** (used verbatim instead of API auto-discovery, which is otherwise name-filtered to avoid image/TTS/embedding models). On the **free tier** the flash models cap at ~20 requests/day; the appliance's `gemini-3.1-flash-lite` default has a far larger daily quota. For steadier quality use a paid tier, pin a stronger chain, or **run a local model** (built-in — set `LOCAL_LLM_ENABLED` and friends; see `.env.example`). If every model is down, the AI endpoints degrade gracefully (a non-blocking "add it manually" notice) — calendar, chores and shopping keep working.

**Supabase setup (one-time):**
1. Run `supabase/schema.sql` in the Supabase SQL Editor (the hardened baseline), then run
   `supabase/migrations/2026-07-06-post-capstone.sql` (adds `agent_jobs`, `web_cache`, `pgvector`,
   `oauth_tokens` — required for async agent chat + page cache)
2. Enable Google OAuth under **Auth → Providers → Google** (add your Google Client ID + Secret)
3. Under **Auth → URL Configuration**, add `http://localhost:4894` to Redirect URLs
4. In Google Cloud Console, add `https://<your-project>.supabase.co/auth/v1/callback` to Authorized Redirect URIs

### 3. Run it

Two modes:

- **Development (editing on the host):** `npm run dev` — Vite dev server with hot reload, at `http://localhost:4894`. It serves the app as hundreds of unbundled modules, so it's **slow over the LAN** (and will time out on phones) — use it on the host only.
- **Production serve (real use / multi-device):** `npm run build` then `npm run start` — serves a single static bundle (fast). Re-run `npm run build` after any code change, then restart `npm run start`. The startup log **must** say `Running in PRODUCTION mode. Serving static assets.` (not "DEVELOPMENT … Vite dev middleware") — the `start` script sets `NODE_ENV=production`, which selects static serving.

> **Note:** the port (`4894`) must be in your Supabase **Auth → URL Configuration → Redirect URLs**, or Google sign-in fails and — because sign-in is required — the app won't load.

### 4. Run across your home network (LAN / wall tablet)

The server binds `0.0.0.0`, so it's reachable at `http://<host-LAN-IP>:4894` from other devices once you clear these:

1. **Use production serve** (`npm run build && npm run start`). Dev mode is too slow over Wi-Fi and times out on phones.
2. **Open the firewall port** on the host — one time, in an **Administrator** PowerShell:
   ```powershell
   New-NetFirewallRule -DisplayName "Family-Hub 4894" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4894 -Profile Private
   ```
3. **Point Supabase's Site URL at the LAN origin** → Auth → URL Configuration → **Site URL** = `http://<host-LAN-IP>:4894` (else sign-in bounces back to the *device's own* localhost). The Site URL is used **verbatim** as the post-login destination, so this is the reliable fix. Keep `http://localhost:4894` (and `/**`) in **Redirect URLs** so host-machine dev still returns to localhost. No Google Cloud change needed — the OAuth redirect there is the Supabase callback.
   > **Why the Site URL and not just a Redirect URL entry?** The app sends `window.location.origin` (no trailing slash) as `redirectTo`; Supabase only honors it if it matches the Redirect URLs allow-list — and in practice that match did **not** land for a bare LAN-IP origin, even with an exact `http://<host-LAN-IP>:4894` entry. Supabase fell back to the Site URL (localhost) anyway. Setting the Site URL itself skips the matcher entirely.
   > **Tradeoff:** signing in on the host via `localhost` will then land on the LAN IP after login — still works (server binds `0.0.0.0`), the URL just changes. After changing this, retest sign-in in a **fresh/incognito** window to avoid a cached redirect.
4. **Pin the host IP** (router DHCP reservation / static IP) so it doesn't change.

> Caveat: over plain `http://` on a LAN IP, **service worker / PWA install / notifications won't work** (they require a secure context — HTTPS or `localhost`). Viewing and using the app is fine.

### 5. Run tests

```bash
npm test
```

**1,200+ tests** across 122 files (Vitest), grouped by area:
- **Email → suggestions** — provider-agnostic Gmail normalize/decode (`email`) feeding bills / packages / kids' activities (tight filters, sanitized prompts).
- **Concierge safety** — draft/stepup tool builders (`aiActions`), the MCP toolbelt + registry parity + **no-payment drafts** incl. `prepare_handoff` (`mcpTools`/`toolRegistry`/`mcpPersistence`), the action-ledger + confirm-tier lifecycle (`historyLog`/`ledger`/`agentActions`), and scrypt step-up PIN hashing.
- **Agentic patterns** — web research + keyless-DDG parse (`webResearch`), loop-closing handoff (`handoff`), critic/verifier (`copilotCritic`), pantry→meal + vision diff (`visionPantry`), HITL Modify (`reviseDraft`), the proactive morning **planner** (`morningAgent` — validator safety properties: everything stages confirm-tier, horizon-clamped, goalId-allowlisted; plus the legacy deterministic nudges, `proactiveBriefing`).
- **Grounding & calendar logic** — places/events/weather+AQI+pollen FACTS (`placesFacts`/`eventsFacts`/`weatherFacts`), availability + long-weekend + conflicts + recurring-series + ICS + Gemini resilience + the local-model harness.
- **Component (jsdom + RTL)** — the copilot bar (escalate · markdown links · Approvals + Modify · kid-mode gating + hold-to-exit), the shell pages (`LibraryPage`, `ShoppingPage` incl. photo-scan + per-list Kroger sends, `ChoresPage` incl. kid mode/emoji/confetti/delete-confirm, `TodayPage`), `KrogerPanel` (two-level connections — a list row never offers store locations), `BriefingCard` (planner proposals → client-side staging), `GoalsStrip`, `DinnersStrip` (the meal planner's Today strip), `EventSheet`/`CalendarOverlay`, `ManageAddMember`, `NamePromptModal`, `ErrorBoundary`, `lazyTabs`; mocks in `src/__tests__/helpers/mockContexts.tsx`.

The **Python agent eval** (`agent/tests/test_eval.py`) adds offline structural no-payment proofs (always-run) + live refusal/prompt-injection prompts (owner-run). The test files in `src/__tests__/` are the authoritative detail — this is just the map.

---

## First Run

1. The app opens to a **blocking sign-in screen** — click *Sign in with Google*.
2. On return, you're prompted to **pick a display name** (e.g. "Dad", "Mom", or your first name). You're added to the household as a **Parent**.
3. Your **primary Google calendar is auto-connected** and its events import once, so the dashboard isn't empty.
4. Add family members, import more calendars, and start planning.

You can **rename or remove** any family member later by clicking their avatar in the header (rename/remove cascade across events, chores, calendar connections, and the XP ledger). Sign out from the header account chip.

---

## Household Sharing

When you sign in, a household is automatically created for you. Share the 16-character invite code (shown in **Manage → family section**, with **Copy / Regenerate** next to the invite code) with your spouse or family members. Invite codes expire after 7 days; regenerate from Manage to mint a fresh one.

A second family member must **join your household with that code** — otherwise signing in just creates their *own* empty household and they'll see none of your shared data. They can join in **two places**: (1) right in the **first-time name prompt** — it offers a "Have a family invite code?" box (lead option for a brand-new sign-in), or (2) later in the same **Manage → family section**. After joining they pick their own name and see the same shared data across all devices.

> If a family member already created a separate empty household by mistake, they're not stuck: just have them enter your invite code (name prompt or Sync panel) → **Join** → confirm the "replaces this device's data" prompt (safe — it only swaps their empty data for the shared household). Your data is never affected.

---

> **Architecture diagrams** — functional, detailed, data, and AI-workflow views (Mermaid, GitHub-rendered) live in [`docs/architecture.md`](./docs/architecture.md).

## Data Model

All family data is stored as JSONB blobs in Supabase keyed by `household_id + data_key`. Data keys: `events`, `sources`, `members`, `shopping`, `pantry`, `chores`, `rewards`, `redemptions`, `xpbank`, `choreweek`, `calendars`, `hiddenevents`, `settings`, `visitlog`, `documents` (the Docs Library / RAG corpus), `bills` (parsed from email), `digestprefs` (daily-briefing opt-in), `goals` (multi-step goals the concierge tracks), `copilotlog`, `quickaddlog`, `actionledger`. Persistence is driven by a single `COLLECTIONS` registry (one entry per key), so localStorage caching, cloud save, bootstrap load, and join-replace stay in sync automatically. (`settings` is a single-element household blob — currently the home location for copilot weather grounding.) Row-level security ensures only household members can read or write their data. (Idle/screensaver preferences are per-device localStorage only, not synced.)

**Per-record authorship.** `events`, `chores`, and `shopping` items carry optional `createdAt` + `createdByUserId` + `createdByEmail` (the `Authored` shape), stamped at every create site via the `authorStamp()` helper. The data is still household-scoped/shared; these fields just record *which* member (by stable email + auth userId) created each record — an audit trail without changing the schema (additive optional fields, so older blobs stay valid).

**Audit / RL logs.** `copilotlog` and `quickaddlog` are append-only, household-scoped, author-stamped logs (capped to the most recent 500 entries). `copilotlog` stores each copilot Q+A turn *full and structured* — prompt, raw answer, model, fallback flag, and the returned suggestions/actions — so it can drive auditing or a future reinforcement-learning dataset. `quickaddlog` stores each natural-language quick-add (raw text + classified kind + outcome). `actionledger` (concierge foundation A1) is the append-only audit trail of concierge actions — each auto-applied copilot action is recorded as an `applied` `LedgerEntry` (tool + risk tier + a payload snapshot), capped the same way; it becomes the approval queue for confirm/step-up actions in later phases.

**Auto-push to Google (opt-in).** If you've connected a **Push** calendar (Manage → Google sync), the Family-Hub events you create — including ones the copilot drafts — **automatically push to that Google calendar on app open**: a silent, client-side mirror that's idempotent via a `[FamilyHub-id:<id>]` marker (a re-push *updates* the same Google event rather than duplicating it), sharing one body builder (`src/utils/googleEvent.ts`) with the bulk "Sync Now" push. The **agent never writes to Google directly** — the no-new-agent-external-write invariant holds; this is your own app mirroring your own events to your own connected calendar, and each parent's device pushes only to its own account (token-scoped). A manual per-event **Push to Google** button (pick specific calendars) and the bulk "Sync Now" push remain for one-offs; **pull-from-Google runs on that bulk Sync (and when you connect a calendar or restore a hidden event) — NOT automatically on sign-in yet**. Auto-push is opt-in: with **no** Push rule connected, nothing pushes automatically.

**List autocomplete.** The shopping and pantry add-inputs offer native `<datalist>` typeahead sourced from the distinct item names already in that list (so suggestions reflect what's persisted, across sessions/devices).

**Identity & households.** Each signed-in member's profile (`members`) carries both their Supabase `userId` and their **Google email** — the email is the *stable* link, so a profile is re-matched and silently re-linked (`src/utils/identity.ts`) even if the auth `userId` changes, rather than wrongly re-prompting for a name. A household is created once per owner; joining another household requires its 16-character invite code via the `join_household_by_code` SECURITY DEFINER function (a non-member can't read a household by code under RLS). The device tags its cache with the active `household_id`, so signing into a *different* household replaces stale collections wholesale (no cross-household data bleed).

## License

**GNU AGPL-3.0-or-later** — see [`LICENSE`](./LICENSE). Strong network-copyleft: if you run a modified version as a network service, you must offer its users the Corresponding Source. The app surfaces a **"Source code (AGPL-3.0)"** link in the account overlay to satisfy §13.
