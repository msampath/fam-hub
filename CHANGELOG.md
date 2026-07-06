# Changelog

All notable changes to Family-Hub are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/spec/v2.0.0.html) — pre-1.0, minor releases may change behavior.
Current shipped state lives in [`PROJECT_STATUS.md`](./PROJECT_STATUS.md); direction lives in
[`planning/roadmap.md`](./planning/roadmap.md).

## [Unreleased]

Post-submission work on `main`. The submission itself is frozen on `initial-push` (tag
`capstone-submitted`) until Kaggle judging ends — no deploys, no env changes, no commits there.

### Added
- **Weak-model eval harness** — `scripts/eval-quickpath.ts` + `src/utils/evalScorers.ts` +
  `agent/evals/` replay golden prompts through the *real* `/api/copilot` pipeline (live model calls,
  real FACTS harness, real critic) against a throwaway appliance-mode server; run with `npm run eval`
  (Gemini baseline) / `npm run eval:local` (local Ollama). Two go/no-go gates for serving a local
  model: **Decision A (quick path) — PASS** (after the Phase-3 hardening below, local `gpt-oss:20b`
  @ q4 scores 18/18 with scope+safety perfect, 100% locally served, vs the `gemini-2.5-flash`
  baseline's 13/18; the first run was 94% vs 78%). **Decision B (agent path)** stays gated —
  local never serves the ADK agent unless ≥90% valid tool calls + 0 destructive misfires.
- **Kroger send-to-cart loop** — connect a QFC / Fred Meyer / Kroger store in Manage → Groceries,
  hit **Send to cart**, and grocery items are matched to real products (schema-enforced
  choose-from-candidates matching, because Kroger's fuzzy search returns frying pans for "paneer")
  and staged as **one confirm-tier `kroger_cart_write` Approval**; approving writes the items to your
  actual Kroger cart. Payment stays in Kroger's own app — the public Kroger API has **no
  checkout/payment endpoint**, so the no-payment invariant holds by contract. Includes the pure API
  module (`src/utils/krogerApi.ts`), six server routes, the connect panel, and the approved-write
  applier. A dish ask ("I want paneer butter masala") now auto-offers the send-to-cart staging.
- **Quick-add critic** (`src/utils/quickAddCritic.ts`) — the natural-language quick-add path gets
  the same verify-before-apply treatment the copilot already had.
- **Model fallback chains** — `GEMINI_FALLBACKS` (Express quick path, may end in `local`) and
  `CONCIERGE_FALLBACK` (ADK agent), tried in order on 503/429; added after a live Gemini 503 took
  the agent path down.
- **Per-store Clear** in Shopping (clear one store's done items, keeping staples) and an
  Approvals-button label cleanup.

### Changed
- **CLAIM=ACTION output contract** — the copilot may claim it did something only when a matching
  action object exists in its reply. `verifyActionClaims` + a bounded correction pass catch unbacked
  success claims; the eval harness caught Gemini answering "I've added milk" with zero actions on
  5/5 explicit commands, which this now surfaces honestly instead of silently dropping.
- **Phase-3 weak-model hardening** (quick-path surfaces made safe for a small local model):
  calendar-extraction validator (ISO dates, ±1-year window), `find_places` keyless-fallback honesty
  (name-filter OSM results against the query or decline — no more wrong-looking "found 6 cafes"),
  email-scan `confidence` field (drop <0.5) + local-slot genConfig, a `requireCloud` flag for the
  OCR/revise-draft paths, and a briefing-compose cross-check of names/dates against the
  deterministic facts.
- **Roadmap consolidated** — `planning/roadmap.md` is now the single roadmap SSOT, superseding
  `planning/post-capstone-plan.md` and the roadmap half of `future_ideas.md`.

### Fixed
- **Browser-proof Kroger OAuth** — the popup handoff (postMessage / `window.opener` / shared
  localStorage) is browser-fragile: COOP severs the opener, Safari ITP / Brave shields / ad-blockers
  eat the rest. The callback now stashes the refresh token server-side keyed by the single-use
  `state` nonce (5-minute TTL) and the app claims it via authenticated `GET /api/kroger/poll`.
  Owner-verified live; the previously missing connect-flow test now exists.
- **Eval runner tracked** — the allow-list `.gitignore` had silently dropped
  `scripts/eval-quickpath.ts`; it now ships (and CONTRIBUTING documents the gotcha).

### Docs
- Restored and committed the planning/SSOT corpus (~50 files — `PROJECT_STATUS.md` history,
  `future_ideas.md`, agent-harness notes, review reports) that had only ever existed untracked in
  the original dev checkout; secret/PII-scanned first. The corpus now travels with the repo.

## [0.1.0] - 2026-07-05

The Kaggle *AI Agents Intensive* capstone submission (Concierge track) — tag `capstone-submitted`
on `initial-push`. First public release; AGPL-3.0-or-later.

### Added
- **Two-engine AI copilot.** An Express quick path grounded by a deterministic FACTS harness
  (date · availability · long-weekend · weather+AQI+pollen · places with drive times · events —
  the server pre-fetches real data, so the model reasons over facts and admits when it has none),
  with self-correction (a server-side critic verifies action JSON and runs a bounded ≤2-pass
  corrective loop). Action/planning turns route automatically to the second engine:
- **Python ADK multi-agent concierge** — a root router + **7 tool-scoped specialists** (calendar /
  chores / shopping / outings / briefing / bills / files) over a **Node MCP server** (stdio child).
  Specialists are tool-scoped by design; `outings` runs the full research → plan → handoff loop,
  including live web research (Tavily → Google CSE → Brave → keyless DuckDuckGo) and
  provenance-verified booking handoffs (a staged URL must have been found on the venue's own page).
- **Safety architecture** — the **no-payment invariant** (the agent never holds payment credentials
  and never completes a purchase; carts and reservations are *drafts* the parent finishes), **risk
  tiers** (auto / confirm / step-up PIN, scrypt-hashed) enforced server-side in the MCP tool layer —
  never trusted to the model — an **Approvals queue** with human-in-the-loop **Modify**, and an
  append-only action ledger.
- **Kid mode** — an age-4-safe device lock: picture-first chores, every destructive tap hidden
  shell-wide, hold-the-lock-3s (+ optional PIN) to exit.
- **Proactive morning planner** — a scheduled, closed-app pass where one grounded model call
  proposes up to 3 next actions and deterministic code stages the survivors as confirm-tier drafts:
  the model proposes, the code stages, the parent approves. Same planner behind the in-app
  "Preview today's briefing", plus an opt-in daily digest email.
- **Google Calendar sync** — per-member pull, opt-in auto-push with idempotent markers,
  recurring-series warnings with bulk delete, signature-based dedupe, persistent deletion
  ("hidden from sync") with restore.
- **Email scans** — bills, packages, and kids'-activity suggestions parsed from Gmail with tight
  filters and sanitized prompts; read-only.
- **Docs Library (RAG)** — universal upload (.pdf / .docx / .xlsx / .txt / .md, pasted text, web
  pages) into a copilot-readable corpus with `search_local_knowledge`; optional local embeddings.
- **Shopping** — store-routed lists, staples, dish → ingredients (the model derives the recipe
  itself, in buy units a store actually sells), pantry restock + pantry meal-plan, and photo intake
  (fridge/receipt vision diffed against the pantry).
- **Chores** — per-kid assignment with XP, levels, weekly banking, and confetti.
- **Grounded suggestions** — real nearby venues (Google Places, or keyless OSM/OSRM fallback) with
  drive times, real dated events (Ticketmaster), live weather (keyless Open-Meteo); a recommended
  venue must reference a server-verified fact or it's dropped.
- **PWA** — installable, offline shell, local daily reminders and per-event alerts.
- **Two storage backends** — the **SQLite LAN appliance** (docker compose, household passphrase,
  one family per box, no cloud accounts) and **Supabase cloud** (Google OAuth, Postgres + RLS,
  cross-device sync, invite codes).
- **Cloud Run deploy** — web + agent services, Cloud Scheduler for the morning agent, and a
  no-sign-in "Try the demo" (anonymous, RLS-isolated, seeded household).
- **Test suite at submission** — 918 vitest across 96 files plus the Python agent eval
  (offline structural no-payment proofs always run; live refusal/prompt-injection prompts are
  owner-run).

[Unreleased]: https://github.com/msampath/fam-hub/compare/capstone-submitted...main
[0.1.0]: https://github.com/msampath/fam-hub/releases/tag/capstone-submitted
