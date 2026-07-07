# Deploy Family-Hub to Cloud Run — step by step

End state: the **live deployable** for the capstone — two Cloud Run services plus a Cloud Scheduler job that
fires the autonomous **morning agent** (the digest email + a grounded planner pass that stages confirm-tier
drafts into Approvals).

```
                Cloud Scheduler (hourly cron)
                        │  POST /internal/run-digest  (X-Digest-Secret)
                        ▼
  Browser ─▶  family-hub-web        ──server-to-server──▶  concierge-agent
              (Dockerfile.web)        AGENT_BASE_URL          (Dockerfile)
              Express + React           /chat                 Python ADK + Node MCP child
              · in-app copilot                                · 8 tool-scoped specialists
              · morning agent: Resend email                   · per-request visitor-JWT isolation
                + planner → confirm-tier drafts
                        │                                            │
                        └───────────────  Supabase  ───────────────┘
```

Two services because the **digest scheduler lives in the Express web server** (`server.ts` →
`/internal/run-digest` → `runDailyDigest()` → Resend), while the **agent** (`/chat`) is a separate Python
container. Verified in the code: [server.ts:2700](../server.ts), [agent/api.py:133](../agent/api.py).

---

## 0 · Prerequisites (once)

- **gcloud CLI** installed and logged in: `gcloud auth login`
- A **GCP project with billing enabled** (Cloud Run + Cloud Build + Scheduler need it; usage stays in free tier for a demo)
- A **Supabase project** already set up (`supabase/schema.sql` run, Google OAuth provider enabled)
- Keys in hand:
  - `GEMINI_API_KEY` (Google AI Studio) — used by **both** services
  - Supabase **URL**, **anon key**, **service-role key**
  - **Resend** API key (the briefing email — you already have this working)
  - Google OAuth **Client ID + Secret** (calendar sync token refresh)

```bash
# Pick a project + region and enable the APIs
gcloud config set project YOUR_PROJECT_ID
gcloud config set run/region us-central1
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com artifactregistry.googleapis.com

# Artifact Registry repo for the web image (the agent uses --source, so it doesn't need this)
gcloud artifacts repositories create fam-hub \
  --repository-format=docker --location=us-central1 \
  --description="Family-Hub images"

# NEW projects only (hit live 2026-07): the default compute service account no longer gets build
# permissions automatically, so `--source` deploys fail with "does not have storage.objects.get
# access … run-sources-…zip". Grant it the builder role once:
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member=serviceAccount:PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --role=roles/cloudbuild.builds.builder --condition=None
```

> Run every command below from the **repo root** (`F:\github\fam-hub`).

---

## 1 · Deploy the AGENT service (`concierge-agent`)

The root `Dockerfile` is the agent image, so `--source .` builds it directly — no manual Docker needed.

```bash
gcloud run deploy concierge-agent \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 \
  --concurrency 4 \
  --timeout 300 \
  --min-instances 1 \
  --set-env-vars GOOGLE_GENAI_USE_VERTEXAI=FALSE \
  --set-env-vars COPILOT_MODEL=gemini-2.5-flash \
  --set-env-vars CONCIERGE_FALLBACK=gemini-flash-lite-latest,gemini-2.5-flash-lite \
  --set-env-vars GEMINI_API_KEY=YOUR_GEMINI_KEY \
  --set-env-vars GOOGLE_MAPS_API_KEY=YOUR_MAPS_KEY \
  --set-env-vars SUPABASE_URL=https://YOURPROJ.supabase.co \
  --set-env-vars SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

Why these flags:
- **`--memory 2Gi --cpu 2 --concurrency 4`** — each `/chat` spawns **8 Node MCP children** (one per specialist). High concurrency × 8 children would exhaust memory; cap it.
- **`--min-instances 1`** — keeps one instance warm so the MCP children don't cold-start mid-demo (the documented session-timeout risk). **Set back to 0 after the demo to stop paying for idle.**
- **`--timeout 300`** — multi-agent runs make 3–5 model calls; the default 60s can clip a slow outings loop.
- **`CONCIERGE_FALLBACK`** — comma-separated model chain tried in order when the primary throws a
  transient 503/429 (Gemini flash capacity spikes are real; without a chain, one spike 502s the agent —
  found live).
- **`SUPABASE_URL` + `SUPABASE_ANON_KEY`** — forwarded to the MCP child so writes persist under the visitor's JWT (RLS-scoped). Without them the agent runs validate-only.
- **`GOOGLE_MAPS_API_KEY`** — ALSO forwarded to the MCP child (it inherits the full service env): it powers
  `find_places` name lookup via Places Text Search. Without it the tool degrades to a keyless OSM fallback
  that is **category-only** — a name ask like "dinner at Din Tai Fung" finds nothing (found live: the agent
  answered "couldn't find it near Sammamish" while the web service, which had the key, grounded fine).
  Optional extras the MCP `web_search` chain will use if present: `TAVILY_API_KEY`, `BRAVE_API_KEY`,
  `GOOGLE_CSE_KEY`+`GOOGLE_CSE_ID` (absent all three it falls back to a fragile keyless scrape).

**Copy the service URL** it prints, e.g. `https://concierge-agent-abc123-uc.a.run.app`. You need it in step 3.

Smoke test — **note: NOT `/healthz`.** Google's frontend reserves the `/healthz` path on `*.run.app` and
answers it with its own 404 without ever forwarding to your container (found live — the service looked
dead while being perfectly healthy). Probe the real contract instead:
```bash
curl -s -X POST https://concierge-agent-abc123-uc.a.run.app/chat \
  -H "Content-Type: application/json" -d '{"message":"hi"}'   # -> {"reply":"…","sessionId":…}
```

---

## 2 · Build the WEB image

The web service uses **`Dockerfile.web`**, which `--source` can't select (it picks the default `Dockerfile`).
Build it with the provided Cloud Build config (no local Docker required):

```bash
gcloud builds submit --config cloudbuild.web.yaml \
  --substitutions=_IMAGE=us-central1-docker.pkg.dev/YOUR_PROJECT_ID/fam-hub/web:latest
```

*(Local-Docker alternative: `docker build -f Dockerfile.web --build-arg VITE_AGENT_BASE_URL=enabled -t <IMAGE> . && docker push <IMAGE>`.)*

---

## 3 · Deploy the WEB service (`family-hub-web`)

Set `AGENT_BASE_URL` to the **agent URL from step 1**. Generate the digest secret first (must be ≥32 chars —
`server.ts` refuses a shorter one):

```bash
# 1) a strong shared secret for the scheduler → digest endpoint
DIGEST_SECRET=$(openssl rand -hex 24)   # 48 hex chars; save it — Cloud Scheduler needs the same value
echo "$DIGEST_SECRET"

# 2) deploy
gcloud run deploy family-hub-web \
  --image us-central1-docker.pkg.dev/YOUR_PROJECT_ID/fam-hub/web:latest \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --min-instances 1 \
  --set-env-vars GEMINI_API_KEY=YOUR_GEMINI_KEY \
  --set-env-vars GOOGLE_MAPS_API_KEY=YOUR_MAPS_KEY \
  --set-env-vars TICKETMASTER_API_KEY=YOUR_TICKETMASTER_KEY \
  --set-env-vars VITE_SUPABASE_URL=https://YOURPROJ.supabase.co \
  --set-env-vars VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY \
  --set-env-vars AGENT_BASE_URL=https://concierge-agent-abc123-uc.a.run.app \
  --set-env-vars GOOGLE_CLIENT_ID=YOUR_GOOGLE_CLIENT_ID \
  --set-env-vars GOOGLE_CLIENT_SECRET=YOUR_GOOGLE_CLIENT_SECRET \
  --set-env-vars DIGEST_TRIGGER_SECRET=$DIGEST_SECRET \
  --set-env-vars SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY \
  --set-env-vars RESEND_API_KEY=YOUR_RESEND_KEY \
  --set-env-vars "DIGEST_FROM_EMAIL=Family-Hub <onboarding@resend.dev>"
```

Then set `APP_URL` to the web service's own URL (printed on deploy) — a second pass. **Use
`--update-env-vars` (merges), NOT `--set-env-vars`** — on `services update`, `--set-env-vars` REPLACES the
entire env-var set with just the ones given, producing a revision with no Supabase/Gemini config that fails
to boot (found live; Cloud Run kept serving the last healthy revision, which masks the mistake):
```bash
gcloud run services update family-hub-web --region us-central1 \
  --update-env-vars APP_URL=https://family-hub-web-xyz789-uc.a.run.app
```

Grounding keys (the copilot degrades honestly without them, but the demo loses its teeth):
- **`GOOGLE_MAPS_API_KEY`** — real nearby venues + drive times in the quick-path FACTS. Same key the agent
  service needs (see step 1) — setting it on ONE service does not cover the other.
- **`TICKETMASTER_API_KEY`** — real ticketed events in the FACTS (web service only; the agent has no events tool).

What each digest var does (all three required to actually send mail):
- **`DIGEST_TRIGGER_SECRET`** — enables `POST /internal/run-digest` **and auto-disables** the in-process 5-min interval (so multi-instance Cloud Run won't send duplicates).
- **`SUPABASE_SERVICE_ROLE_KEY`** — reads opted-in households across users (RLS bypass — keep secret).
- **`RESEND_API_KEY`** + **`DIGEST_FROM_EMAIL`** — the email channel you already verified.

> **Agent-authored briefing:** the digest now asks the ADK concierge to write the briefing prose
> (`server.ts` → `composeBriefingViaAgent` → `${AGENT_BASE_URL}/chat`), so the email is genuinely
> agent-generated. This reuses the **`AGENT_BASE_URL`** you already set above — no new var. If the agent
> service is unreachable (cold start past the 45s timeout, or down), the digest **falls back to the
> deterministic briefing text** and still sends, so email delivery never depends on the agent being up.

> **Secrets hardening (recommended):** put `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, and
> `DIGEST_TRIGGER_SECRET` in **Secret Manager** and pass them with `--set-secrets KEY=secretName:latest`
> instead of `--set-env-vars`. Env vars are visible to anyone with console read access.

---

## 4 · Wire up auth redirect URLs

With the web URL known (`https://family-hub-web-xyz789-uc.a.run.app`):

1. **Supabase → Authentication → URL Configuration:** set **Site URL** to the web URL and **add it to Redirect URLs**.
2. **Google Cloud Console → APIs & Services → Credentials → your OAuth client:** add the web URL to **Authorized JavaScript origins**. (The Supabase callback `https://YOURPROJ.supabase.co/auth/v1/callback` should already be an Authorized redirect URI.)

Without this, Google sign-in bounces back to localhost.

---

## 5 · Schedule the Morning Briefing (Cloud Scheduler)

Households pick a **send hour**; `runDailyDigest()` checks each one and sends only at its chosen hour (and
once per day). So fire the cron **hourly** (use `*/15 * * * *` if you want sub-hour send-time granularity):

```bash
gcloud scheduler jobs create http family-hub-digest \
  --location us-central1 \
  --schedule "0 * * * *" \
  --time-zone "America/Los_Angeles" \
  --uri "https://family-hub-web-xyz789-uc.a.run.app/internal/run-digest" \
  --http-method POST \
  --headers "X-Digest-Secret=$DIGEST_SECRET" \
  --attempt-deadline 300s
```

For the **video**, force a send on demand instead of waiting for the top of the hour:
```bash
curl -X POST -H "X-Digest-Secret: $DIGEST_SECRET" \
  https://family-hub-web-xyz789-uc.a.run.app/internal/run-digest
# -> {"ok":true}   (and the briefing email lands, like your screenshot)
```
Or trigger the scheduled job directly: `gcloud scheduler jobs run family-hub-digest --location us-central1`.

---

## 6 · Verify end to end

| Check | Command / action | Expect |
| --- | --- | --- |
| Agent healthy | `curl -s -X POST .../chat -H "Content-Type: application/json" -d '{"message":"hi"}'` | a JSON `reply` (never `/healthz` — GFE reserves it) |
| Web serves | open the web URL | app loads, Google sign-in works |
| Concierge panel shows | sign in / "Try the demo" | the in-app Concierge agent panel is visible (proves `VITE_AGENT_BASE_URL`) |
| Agent reachable from web | send a concierge prompt (e.g. *"Add a zoo day next Saturday"*) | event created — proves web→agent `AGENT_BASE_URL` wiring |
| Digest sends | the `curl .../internal/run-digest` above | `{"ok":true}` + email |
| Logs | `gcloud run services logs read concierge-agent --region us-central1` | no key/CORS errors |

---

## 7 · Cost control + teardown

- After recording, drop warm instances: `gcloud run services update concierge-agent --min-instances 0 --region us-central1` (and same for `family-hub-web`).
- Full teardown:
  ```bash
  gcloud scheduler jobs delete family-hub-digest --location us-central1
  gcloud run services delete concierge-agent family-hub-web --region us-central1
  gcloud artifacts repositories delete fam-hub --location us-central1
  ```

---

## Known limitations / honest notes (worth stating in the submission)

- **The agent service is `--allow-unauthenticated`.** Its `/chat` endpoint is open to the internet, so anyone
  with the URL could spend your Gemini quota. Fine for a time-boxed demo; for a real deploy, give the web
  service a service account, deploy the agent with `--no-allow-unauthenticated`, and have Express attach a
  Google-signed **ID token** (or use `--ingress internal` + a serverless VPC connector). Called out in
  [agent/api.py:99](../agent/api.py) (`_visitor_id` decodes the JWT **without** verifying — only a session key,
  not auth; RLS in the MCP child is the real gate).
- **`InMemorySessionService`** — conversation history is per-instance and lost on cold start / scale-out. With
  `--min-instances 1` it's stable for a demo; production would swap in a persistent session service.
- **7 MCP children per request** — intentional (per-specialist `tool_filter` scoping); the container uses the
  prebuilt `dist/mcp-server.cjs` bundle (not `npx tsx`) to keep spawn time low. Hence the `--concurrency 4` cap.
