# Self-host LAN appliance — single-tenant, SQLite, zero owner cloud cost

**Goal:** let other families run fam-hub themselves, single-click, **on their own LAN**, with **no owner-side
cloud cost**. That makes it a self-hosted, single-tenant appliance (one household per box) — not a multi-tenant
cloud SaaS. The LAN is the trust boundary (like today's kiosk). Inference is BYO Gemini key **or** local Ollama
(`LOCAL_LLM_*`); keyless fallbacks (OSM/OSRM/DuckDuckGo/Open-Meteo) already make maps/web/weather free.

## Architecture (the decoupling)
Today the browser talks **directly** to Supabase (auth + REST + RLS). With the DB living on the box as
**SQLite**, the browser can't reach it directly, so data + auth route **through the Express server**:

- **`StorageAdapter`** (`src/storage/`) — a household-scoped KV seam over the `family_data` blob model.
  Implementations: **SQLite** (built-in `node:sqlite`, zero native deps; the appliance default) and **Supabase**
  (optional cloud sync). Every call carries the authenticated `householdId` and the adapter MUST scope to it —
  the security boundary lives here regardless of backend. CAS via a per-write version token (no silent clobber).
- **Local household auth** (`src/storage/localAuth.ts` + `boxConfig.ts`) — the SQLite/local replacement for
  Supabase auth: a household **passphrase** (scrypt) → a **box-signed session** (HMAC) carrying the
  `householdId`. One shared household credential per box; the `members` collection still gives per-parent/kid
  profiles. Box identity (household id, passphrase hash, session secret) lives in a SQLite `meta` table.
- **Express endpoints** — `/api/auth/status|setup|login` and `/api/data/:key` (+ bulk `/api/data`), backed by
  the adapter, gated by `requireAuth` (which accepts the box session in local mode). Mode is chosen by
  `storageMode()`: explicit `STORAGE=sqlite|supabase`, else Supabase-if-configured, else SQLite.
- **Client** (`src/supabase.ts`) — `getAuthToken`/`loadHouseholdData`/`saveHouseholdData` are mode-aware: in
  `sqlite` mode they hit `/api/data` + the box session; the Supabase path is unchanged. Mode is reported by
  `/api/auth/status` (via `fetchAuthStatus()`).

## Security model is preserved (not stripped), for open-source extenders
Even though the default ships single-tenant, household-scoping is an invariant of **every** adapter, the
Supabase/Postgres path keeps DB **RLS**, and `supabase/schema.sql` + RLS stay in the repo as the multi-tenant
reference. An extender who flips to multi-tenant inherits an intact boundary; the multi-tenant hardening
(agent-JWT signature verify, refresh-token binding, invite hardening) is a documented "turn this on if you
expose beyond a trusted LAN" checklist, dormant by default.

## Run it: single-click on a LAN box
You need a box on your home network with **Docker** (a mini-PC, NAS, or any always-on machine) and **your own
Google AI Studio key** (free: https://aistudio.google.com/apikey). Then:

```bash
cp .env.example .env          # add your Gemini key (one GEMINI_API_KEY powers both containers)
docker compose -f docker-compose.appliance.yml up -d --build
# open http://<this-box's-LAN-ip>:4894  →  set a household passphrase  →  you're in.
```

**No Supabase account, no owner cloud cost.** The two containers (web + agent) share a Docker volume
(`famhub-data`) for the SQLite DB — back that up to keep your family's data. The Node base is **24** (built-in
`node:sqlite` needs Node ≥ 22.5). Update with `git pull && docker compose -f docker-compose.appliance.yml up -d --build`.

### Run a local model instead (zero inference cost)
Leave the keys empty and point the box at a local **Ollama** via `LOCAL_LLM_*` (the copilot already supports a
keyless local-first chain). Maps/web/weather are keyless by default (OSM/OSRM/DuckDuckGo/Open-Meteo), so a GPU
box runs the whole thing at ~$0 marginal.

## Status — COMPLETE (Phases A, B, C)
- ✅ **A1** — StorageAdapter seam + SQLite & Supabase impls (household-scoped, CAS). *(unit-tested)*
- ✅ **A2** — `/api/data` endpoints (get/save/bulk) + mode-aware client data layer.
- ✅ **A3** — local household auth (passphrase + box-signed sessions) + box-identity config in `requireAuth`/`/api/auth/*`.
- ✅ **A-gate** — App.tsx LocalAuthGate (setup/login) + a mode-aware bootstrap that leaves the Supabase path intact.
- ✅ **A4** — the agent's MCP child writes to the same SQLite box (`SqlitePersistence`, shared volume).
- ✅ **B** — runtime web config (`window.__APP_CONFIG__` → one image, any backend); container exit-on-unhandled.
- ✅ **C** — one-click `docker-compose.appliance.yml` + `.env.example`, Node-24 images, writable data volume.

## The cloud path is preserved (regression posture)
The appliance code is **gated on mode** and dormant in cloud: the client's local branches require
`_mode === 'sqlite'` (resolved from `/api/auth/status` at boot — `'supabase'` when Supabase is configured), and
`requireAuth`'s cloud branch is unchanged (`LOCAL_MODE` is false whenever Supabase is set). The App.tsx gate adds
a parallel local bootstrap and **guards the Supabase `onAuthStateChange` listener to only run in supabase mode**,
so it can't clobber or be clobbered. **Run your normal build (Supabase env set, `STORAGE` unset) and cloud
sign-in behaves as before.** The full vitest suite (App-rendering tests run in supabase mode) stays green.

## Smoke-test the backend directly (curl)
```bash
STORAGE=sqlite SQLITE_PATH=./data/test.db PORT=4894 npm run start      # or: node dist/server.cjs (Node ≥ 22.5)
curl localhost:4894/api/auth/status                                     # {mode:'sqlite', configured:false}
curl -X POST localhost:4894/api/auth/setup  -H 'content-type: application/json' -d '{"passphrase":"our family phrase"}'
TOKEN=<token>
curl -X POST localhost:4894/api/data/events -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"data":[{"id":"1","title":"Zoo"}]}'
curl localhost:4894/api/data               -H "authorization: Bearer $TOKEN"   # {collections:{events:[…]}, versions:{…}}
```
