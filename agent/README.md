# Family-Hub Concierge — ADK agent (capstone)

A Google **ADK** multi-agent that runs the household, acting through the project's **MCP server**
(`src/mcp/server.ts`) as its toolbelt. This is the Concierge-track demonstration of **Agent / Multi-agent
(ADK)**, **MCP**, **Security** (server-authoritative no-payment invariant + risk tiers), and **Agent
CLI** (`adk run` / `adk web`).

## Architecture

```
adk run / adk web
   └─ concierge (root)            routes to ONE specialist (LLM-driven delegation; holds no tools itself)
        ├─ calendar_agent   →  MCP: create_event, update_event                      ┐
        ├─ chores_agent     →  MCP: add_chore, delete_chore, clear_chores,          │ scoped CRUD adapters.
        │                           update_chore                                    │ The split is for tool-scoping
        ├─ shopping_agent   →  MCP: add_shopping_item, add_to_cart,                 │ (a specialist can't call a tool
        │                           delete_shopping_item                            │ outside its slice) + small-model
        ├─ briefing_agent   →  MCP: get_events/chores/upcoming (READ)               │ routing reliability — NOT autonomy.
        ├─ bills_agent      →  MCP: get_bills (READ)                                │ delete/clear/update are confirm-
        ├─ files_agent      →  MCP: search/move/delete_document                     ┘ tier (staged in Approvals).
        └─ outings_agent    →  MCP: find_places, web_search, fetch_page, prepare_handoff, set_goal
                                  │  the ONE multi-step loop: research the venue's own site → read its real
                                  │  published booking link → stage a provenance-verified handoff draft
                                  │  (each specialist gets only its slice via tool_filter)
                                  ▼
                 Node MCP server (stdio child: `npx tsx src/mcp/server.ts`)
                   no-payment invariant + risk tiers enforced SERVER-SIDE
```

Each specialist opens its own filtered MCP connection (one Node child per specialist) — fine for the
demo; the container build can swap `npx tsx src/mcp/server.ts` for a prebuilt `node` bundle to cut
startup time.

## Run it

Prereqs: Node deps installed at the repo root (`npm install`), Python 3.10+, and a Gemini key.

```bash
cd agent
python -m venv .venv && source .venv/bin/activate   # (Windows: .venv\Scripts\activate)
pip install -r requirements.txt
cp .env.example .env        # then put your GOOGLE_API_KEY in .env

adk web          # open the browser UI, pick "concierge"
# or
adk run concierge   # CLI REPL
```

The agent spawns the MCP server itself (stdio), so you don't start it separately — but `npm install` at
the repo root must have run so `npx tsx src/mcp/server.ts` resolves.

## HTTP surface for the React app (`POST /chat`)

`adk web` / `adk run` are for hands-on testing. The **React surface** talks to a thin FastAPI service
(`agent/api.py`) instead, so it gets a stable contract and **per-visitor isolation**:

```bash
# from the REPO ROOT (so `agent` imports as a package):
uvicorn agent.api:app --host 0.0.0.0 --port 8080
```

Contract (matches `src/utils/agentClient.ts`):

| | |
| --- | --- |
| `POST /chat` | `{ message, sessionId?, history?, family?, goals?, copilotName? }` + `Authorization: Bearer <supabase-jwt>` → `{ reply, sessionId, actions, model }` — `history`/`family` carry the copilot's context; `goals` re-injects every turn as the CURRENT GOALS block; `copilotName` is the family's (kid-pickable) name for the copilot |
| `GET /healthz` | `{ ok: true }` — local/docker only: on `*.run.app` Google's frontend RESERVES `/healthz` and 404s it without forwarding; probe `POST /chat` there instead |

Each `/chat` call rebuilds the agent with the **caller's** JWT, so the MCP child persists only under that
visitor's household (RLS-scoped) — the per-visitor isolation invariant. No token ⇒ the agent still answers
but writes are rejected (validate-only). `sessionId` carries the conversation across turns (in-memory; per
visitor).

**The React app does NOT call this service directly.** A direct browser fetch to the agent's origin is
blocked by the web app's production CSP (`connect-src 'self'`). Instead the browser calls the **same-origin**
Express route `POST /api/agent/chat`, and `server.ts` forwards it here (`AGENT_BASE_URL`, default
`http://127.0.0.1:8080`), passing the visitor's JWT. So this FastAPI service only needs to be reachable by
the Express server, not by the browser. `CORS`/`ALLOWED_ORIGINS` therefore only matters if you call this
service directly (e.g. its `/docs`). The panel appears when `VITE_AGENT_BASE_URL` is set (any truthy value).

## Run the whole stack with Docker (one command)

From the repo root, with a `.env` (copy `.env.example`) holding `GEMINI_API_KEY` / `GOOGLE_API_KEY`
(your Gemini key) + `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`:

```bash
docker compose up --build
# web   → http://localhost:4894   (React app + Express Gemini proxy)
# agent → http://localhost:8080   (Python ADK concierge API + its Node MCP child)
```

The **agent** image (`Dockerfile`) is the capstone's deployable demo backend: a single container with
**both** Python (ADK) and Node (the MCP server, spawned as a stdio child via `npx tsx src/mcp/server.ts`).
It serves the `POST /chat` surface over HTTP with `uvicorn agent.api:app` on `$PORT` (Cloud Run injects
`$PORT`). The `web` service bakes `VITE_AGENT_BASE_URL` so the React panel calls it.

**Cloud Run** (the demo project link): `gcloud run deploy concierge-agent --source . --port 8080` with
`GOOGLE_API_KEY` (+ `GOOGLE_GENAI_USE_VERTEXAI=FALSE`), `SUPABASE_URL`/`SUPABASE_ANON_KEY`, and
`ALLOWED_ORIGINS` (your web origin) set via Secret Manager / env. Persistence under a visitor's JWT
activates automatically — the React app sends the Bearer token per request. The static React app deploys
separately (Firebase Hosting / Cloud Run static) with `VITE_AGENT_BASE_URL` pointed at this service.

> ⚠️ Not yet built/tested in CI here (no Docker in the authoring env). Build it early —
> `docker compose up --build` — and adjust the `uvicorn agent.api:app` invocation (or the ADK
> Runner/session calls in `api.py`) if your installed `google-adk` version's API differs.

## Offline structure test (no key, no Node child)

```bash
cd agent && pytest        # asserts the root + 7 specialists are wired and carry tools
```

## Golden path (try these)

| You say | Routes to | Tool result |
| --- | --- | --- |
| "Add a zoo day next Saturday for Leo" | calendar_agent | `create_event` → **validated** (auto) |
| "Both kids need to make their beds daily" | chores_agent | `add_chore` → **validated** (expands per kid) |
| "Delete all chores, they're messed up" | chores_agent | `clear_chores` → **requires_confirmation** (staged in Approvals; chores removed on approval). `delete_chore` (by title) / `update_chore` (edit) work the same way |
| "Add AA batteries to the Costco list" | shopping_agent | `add_shopping_item` → **validated** |
| "Order more paper towels" | shopping_agent | `add_to_cart` → **requires_confirmation** (DRAFT link; never bought) |
| "Find us a good zoo near home" | outings_agent | `find_places` → **real** nearby venues, each with a real URL (official site → Google Maps) + drive time |
| "Get me a reservation at Din Tai Fung Bellevue Fri 6pm" | outings_agent | researches the venue's own site → `prepare_handoff` with the **real published** reserve link (e.g. the Yelp link DTF lists; the server rejects a *guessed* URL) → **requires_confirmation** DRAFT. Walk-in venues stage nothing and say so |
| "Disarm the alarm" | (concierge) | `home_control` → **unavailable** (honest stub) |
| **"Buy it and pay with my card"** | — | refused: no tool moves money (the no-payment invariant) |

## Troubleshooting

- **`Tool 'create_event' not found. Available tools: transfer_to_agent`** (the specialist "hallucinates" a
  tool it should have). The MCP toolset loaded **empty** — almost always the MCP stdio child didn't come up
  before ADK's session-connect timeout. The first `npx tsx src/mcp/server.ts` spawn transpiles and can take
  >5s (ADK's old default), so `_mcp` sets `timeout=MCP_STARTUP_TIMEOUT` (default **30s**). If you still hit
  it on a slow/cold machine, raise `MCP_STARTUP_TIMEOUT` in `agent/.env`. Confirm the child works standalone
  with `npm run mcp` (should log `concierge MCP server ready — N tools over stdio`, N counted dynamically).
- **`429 RESOURCE_EXHAUSTED` / "prepayment credits are depleted"** — the Gemini key's project ran out of
  paid credits. Use a key from a project **without** billing (free tier), or top up. Set it as
  `GOOGLE_API_KEY` in `agent/.env` and restart.
- **`adk: command not found`** — the venv isn't active in that shell. Re-run `.venv\Scripts\Activate.ps1`
  (Windows) / `source .venv/bin/activate`; the `(.venv)` prompt prefix means it's live.

## Notes / limitations

- **Persistence:** the MCP tools persist auto-tier writes (create_event / add_chore / add_shopping_item)
  to Supabase **under the visitor's JWT** when `SUPABASE_ACCESS_TOKEN` (+ `SUPABASE_URL`/`SUPABASE_ANON_KEY`)
  are set in the MCP child's env (forwarded from this agent — see `_mcp` in `agent.py`). Without them the
  agent runs validate-only (the contract slice). confirm/stepup results (prepare_handoff, add_to_cart,
  update_event, and the destructive delete_chore / clear_chores / update_chore / delete_shopping_item) are
  never auto-persisted — they stay staged for approval and the CLIENT applies them on approve (the chores/
  shopping/goals collections are client-owned + RLS-synced). `set_goal` is auto-tier but client-owned too
  (the client upserts it). In a hosted demo the
  ADK service sets `SUPABASE_ACCESS_TOKEN` per request from the visitor's anonymous session; for local
  testing, set it in `agent/.env`.
- **`find_places` grounding:** the outings agent finds REAL nearby venues (same source as the copilot —
  Google Places New → keyless OSM Overpass fallback; Distance Matrix → OSRM drive times). It resolves the
  home location from the visitor's `settings`, so it needs persistence (a signed-in/seeded household) and a
  home town set. `GOOGLE_MAPS_API_KEY` (optional, read from the MCP child's env) upgrades quality + ratings;
  without it the keyless OSM fallback still returns real venues with Google Maps links.
- **ADK version:** targets `google-adk >= 1.2` (`MCPToolset` + `StdioConnectionParams`). On a different
  major, adjust the `google.adk.tools.mcp_tool` imports in `concierge/agent.py`.
