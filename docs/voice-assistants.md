# Voice assistants — "tell Family Hub to add milk"

**Goal:** speak to the household's existing smart speaker (Echo / Nest) — or any microphone — and have the
utterance land on the **real** concierge path: the Express proxy → the ADK agent → MCP tools → tier-gated
actions, with confirm-tier results staged in **Approvals** exactly as if typed into the Copilot bar. No
parallel "voice API", no bypassing the safety model.

This doc compares three integration paths and ends with a ranked recommendation. A working proof of the
shared plumbing already exists: [`scripts/voice-bridge-poc.mjs`](../scripts/voice-bridge-poc.mjs).

## The seam every path shares

Whatever sits upstream (Alexa, Google, Home Assistant, a cron job), the last hop is identical — two HTTP
calls against the LAN appliance (verified against `server.ts`):

1. **`POST /api/auth/login` `{ passphrase }` → `{ token }`** — the appliance's household passphrase login
   (LOCAL_MODE only; 401 `Incorrect passphrase.` on a miss, rate-limited 8/min/IP). The token is a compact
   box-signed HMAC session (`src/storage/localAuth.ts`), default TTL **30 days**.
2. **`POST /api/agent/chat` `{ message, sessionId? }` + `Authorization: Bearer <token>`** — `requireAuth` +
   the AI rate limit, then a same-origin forward to the ADK service (`AGENT_BASE_URL`). Response:
   `{ reply, sessionId, actions[] }`, each action `{ tool, status, tier, artifact, message }`.

**The auth crux.** `/api/agent/chat` accepts *only* the app session JWT — there is no API key, and we should
keep it that way. The seam that makes voice possible without new auth surface: **the bridge logs in with the
household passphrase once and holds the session token**, exactly like a browser tab. Rotation is already
solved — `POST /api/auth/change-passphrase` rotates the box's signing secret, which instantly invalidates
every outstanding token; the bridge sees a 401 and re-logs-in with the (new) configured passphrase. One
credential to manage, one revocation lever, zero new endpoints.

**The safety model carries over for free.** Auto-tier tools (`add_shopping_item`, `create_event`,
`add_chore`) apply immediately and report `status: applied`. Confirm/step-up tools come back
`requires_confirmation` / `requires_stepup` and are **staged in the Approvals queue** — voice can't delete,
rebook, or spend without a parent tapping approve in the app. The step-up PIN is never speakable. The honest
corollary: the session token is **household-level** authority — anyone who can talk to the speaker in the
kitchen can add milk. That is the same trust boundary as the wall-mounted kiosk, so it's consistent, not new
risk — but say it out loud: voice shares the kiosk's trust model, and confirm-tier is the backstop.

```
speaker/mic ──(path A/B/C)──▶ bridge ──▶ POST /api/auth/login {passphrase} ─▶ {token}   (once, cached)
                                └──────▶ POST /api/agent/chat {message} +Bearer ─▶ ADK agent ─▶ MCP tools
                                                                                     │ auto → applied
                                                                                     └ confirm → Approvals
```

---

## Path A — Home Assistant custom integration (recommended)

Home Assistant is the same species as our appliance — a Docker container on the family's LAN — and it has
already paid the costs we'd otherwise pay twice: **its cloud bridges reach both Alexa and Google Home from
one integration**, and its own **Assist** pipeline offers a fully local voice path (Voice PE hardware /
companion app) with no external cloud at all.

```
"add milk"                                            LAN ┌────────────────────────────┐
  Echo ──▶ Alexa cloud ──▶ HA cloud bridge (Nabu Casa) ──▶│ Home Assistant             │
  Nest ──▶ Google cloud ─▶ HA cloud bridge ──────────────▶│  └ famhub integration      │──▶ fam-hub box
  HA Voice PE / app ──(no cloud)─────────────────────────▶│    (conversation agent,    │    :4894
                                                          │     holds session token)   │
                                                          └────────────────────────────┘
```

- **What we build:** one custom component (`custom_components/famhub/`, distributable via HACS). A config
  flow asks for the box URL + household passphrase, performs the login, stores the token; a small client
  re-logs-in on 401. It registers as a **conversation agent** (HA's `conversation` platform), so "add milk
  to the shopping list" is forwarded verbatim to `/api/agent/chat` and the agent's `reply` is spoken back.
  Optionally expose a couple of scripts/intents ("Add {item} to the shopping list") for the cloud-speaker
  paths where free-form passthrough is clunky (below).
- **Auth:** the passphrase seam above, held inside HA's encrypted config storage. Token rotation is the
  401-→-re-login loop; changing the passphrase in fam-hub forces every bridge and browser to re-auth — one
  lever.
- **Reach:** three front doors from one integration — (1) **Assist local hardware/app** — full free-form
  conversation, 100% LAN; (2) **Alexa** and (3) **Google Home** via HA's existing bridges (Nabu Casa
  subscription ~$6.5/mo, or the free-but-fiddly manual skill/action setup). Honest limit: through the
  Echo/Nest **smart-home** surface, utterances arrive command-shaped — Alexa/Google parse them against
  exposed entities/scripts, so "add milk" works as an intent/script invocation, while long free-form
  sentences are only first-class on HA's own Assist devices. That is a constraint of the assistant clouds,
  not of HA — and paths B/C hit it harder.
- **Privacy:** LAN-only end-to-end on the Assist path; on Echo/Nest paths the utterance transits
  Amazon/Google (unavoidable with their hardware) but **household data never does** — the reply text is the
  only thing going back.
- **Effort:** ~1–2 weeks — config flow + token client (~a day; the PoC is the client), conversation-agent
  glue, HACS packaging, docs. No app-store certification, no public endpoint, no per-household developer
  accounts.
- **Who it fits:** exactly our users — a family that self-hosts an appliance is disproportionately likely to
  run (or happily adopt) Home Assistant.

## Path B — native Alexa Skill

```
Echo ──▶ Alexa cloud ──▶ skill endpoint (public HTTPS: Lambda or tunnel) ──▶ ??? ──▶ LAN box :4894
```

The blocker is structural: a skill endpoint must be **public HTTPS with a trusted cert** — the LAN box is
neither. Every workaround taxes each household: a Lambda relay plus an outbound tunnel from the box
(cloudflared/tailscale funnel), or port-forwarding a family's home router (no). Then account linking: Alexa
wants **OAuth 2.0**, and our appliance deliberately has a passphrase, not an authorization server — we'd
have to build an OAuth shim in front of `/api/auth/login` just to satisfy the linking flow. Add an Amazon
developer account, skill certification (and re-certification per change), and per-household skill
enablement + linking. Privacy: every utterance — and every reply containing calendar/shopping data — routes
through Amazon's cloud and our relay.

- **Effort:** 3–6 weeks (skill model, relay infra, OAuth shim, certification) + permanent operational
  surface. **Wins only if** the household is Echo-only, refuses HA, and wants the polished native
  "Alexa, ask Family Hub…" invocation. Even then, "reaches Alexa only" — Google needs a second build.

## Path C — Google Home / Assistant action

Google **sunset Conversational Actions on June 13, 2023** — the surface that let third parties hold a
conversation on a Nest speaker no longer exists. The current story, verified July 2026:

- **App Actions** — the designated successor — deep-link voice into an **Android app's** existing
  functionality. Family-Hub is a web app on a kiosk; there is nothing to deep-link into.
- **Google Home APIs** — device types, structures, automations: a *smart-home device* surface (Matter-era),
  with local fulfillment aimed at device control. No free-form third-party conversation.
- The Gemini-era assistant has, as of this writing, **no public "talk to my app" registration** for third
  parties. The third-party conversational surface is shrinking, not growing.

**Verdict: not viable as a native path.** The only practical way to reach a Nest speaker today is
*through* a smart-home bridge that Google already trusts — which is precisely path A's HA bridge. Building
"for Google" natively means building path A anyway.

## Comparison

| | A — HA integration | B — Alexa skill | C — Google native |
|---|---|---|---|
| Reaches | Alexa + Google + local Assist | Alexa only | — (surface sunset) |
| Public endpoint needed | no — LAN to LAN | yes (Lambda/tunnel per household) | n/a |
| Auth fit | passphrase login as-is | OAuth shim to build | n/a |
| Utterance transit | LAN-only (Assist) / vendor cloud (Echo·Nest) | Amazon + relay, always | n/a |
| Per-household setup | install integration, enter passphrase | dev account, skill link, tunnel | n/a |
| Certification | none | Amazon, recurring | n/a |
| Effort | ~1–2 weeks | 3–6 weeks + ops | not buildable |

## Recommendation (ranked)

1. **Home Assistant custom integration** — one build reaches both assistant ecosystems *and* adds a
   fully-local voice path that matches the appliance's privacy posture; auth rides the existing passphrase
   seam with rotation already solved; no public endpoint, no certification, no per-household cloud infra.
2. **Native Alexa Skill** — only if Echo-native invocation becomes a hard requirement; accept the relay +
   OAuth shim + certification tax.
3. **Google native** — no. Revisit only if Google ships a real third-party conversational surface.

**Step 1 is done:** `scripts/voice-bridge-poc.mjs` is the bridge's entire client half — passphrase login →
token → utterance → `/api/agent/chat` → printed `reply` + `actions[]` (tier/status included, so a staged
`requires_confirmation` is visible next to an auto `applied`). Run it against a live appliance:

```bash
node scripts/voice-bridge-poc.mjs --passphrase 'our family phrase' "add milk to the shopping list"
```

Step 2 is wrapping those ~40 effective lines in a HA config flow + conversation agent. Out of scope for the
bridge by design: wake word, speech-to-text, and text-to-speech — the assistant layer owns those; Family-Hub
only ever sees text in, text + actions out.

## References

- [Conversational Actions sunset overview — Google for Developers](https://developers.google.com/assistant/ca-sunset)
- [Google shutting down Conversational Actions in favor of App Actions — Android Police](https://www.androidpolice.com/google-shutting-down-assistant-conversational-actions-app-actions-for-android/)
- [HA: Assist — talk to your smart home](https://www.home-assistant.io/voice_control/)
- [HA: exposing entities to Assist / Google Assistant / Alexa](https://www.home-assistant.io/voice_control/voice_remote_expose_devices/)
- [HA core issue #132515 — Google Conversational Actions have been sunset](https://github.com/home-assistant/core/issues/132515)
- In-repo: [`architecture.md`](./architecture.md) (safety model, risk tiers), [`lan-appliance.md`](./lan-appliance.md) (passphrase auth, box sessions)
