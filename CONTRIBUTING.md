# Contributing to Family-Hub

Thanks for looking under the hood. Family-Hub is AGPL-3.0-or-later; by contributing you agree your
changes land under the same license. Direction is tracked by the maintainer — open an issue to discuss
a feature before building it (this is a personal two-parent household app; general-purpose task-manager
features are out of scope).

**Branches:** all work lands on `main` via PR. `initial-push` is the frozen capstone submission
(tag `capstone-submitted`) — don't target it.

## Running the app

Three ways to run it; pick the one that matches what you're changing.

### 1. LAN appliance (SQLite, docker compose)
The recommended self-host path and the closest thing to "production" for most changes:

```bash
cp .env.example .env          # add a free Gemini key (https://aistudio.google.com/apikey)
docker compose -f docker-compose.appliance.yml up -d --build
# open http://<box-ip>:4894 → set a household passphrase
```

Guide: [`docs/INSTALL.md`](./docs/INSTALL.md) · architecture + security model:
[`docs/lan-appliance.md`](./docs/lan-appliance.md).

### 2. Local dev (hot reload)
```bash
npm install                   # Node >= 22.5 — the SQLite backend uses built-in node:sqlite
cp .env.example .env          # GEMINI_API_KEY is enough; storage defaults to SQLite
npm run dev                   # http://localhost:4894
```

To hack on the ADK concierge too:

```bash
cd agent
python -m venv .venv && .venv\Scripts\activate    # Python 3.10+; POSIX: source .venv/bin/activate
pip install -r requirements.txt
```

`agent/README.md` covers running it (`adk web`, `uvicorn agent.api:app`) — the agent spawns the
Node MCP server as a stdio child, so the root `npm install` must have run first.

### 3. Cloud (Supabase + Cloud Run)
Only needed for changes to auth/RLS/deploy paths. Supabase setup is in the README's Setup section;
the full deploy walkthrough is [`docs/cloud-run-deploy.md`](./docs/cloud-run-deploy.md).

## Per-commit gates

Every commit must pass, locally and in CI — [`appliance-images.yml`](./.github/workflows/appliance-images.yml)
runs the same gate (lint, vitest, build, plus the keyless agent pytest layer) on every pull request; only a
push to the default branch or a tag goes on to publish images:

```bash
npm run lint && npx vitest run && npm run build
cd agent && python -m pytest
```

That's `tsc --noEmit` (zero errors), the vitest suite (~1,264 tests across 122 files), a full
production build, and the Python agent tests (47 pass; 7 live tests self-skip without keys —
that's expected).

## Weak-model eval gates

Anything touching prompts, the FACTS harness, validators, critics, or the copilot pipeline should
also run the eval harness — model decisions here ride eval numbers, not vibes:

```bash
npm run eval          # Gemini baseline — validates the harness + your change against the cloud model
npm run eval:local    # local Ollama (gpt-oss:20b) — the Decision A numbers
```

The runner replays golden prompts through the real `/api/copilot` pipeline against a throwaway
appliance-mode server (no Supabase needed; results land in git-ignored `eval-results/`). The two
go/no-go gates:

- **Decision A — quick path.** May a local model serve the Express quick path? **Currently PASS**
  (local 18/18 vs the Gemini baseline's 13/18, scope+safety perfect). Don't regress it.
- **Decision B — agent path.** A local model never serves the ADK agent path unless it hits
  **≥90% valid tool calls + 0 destructive misfires** (`agent/evals/run_eval.py`). Not yet passed —
  local agent serving ships dark until it is.

## Code style

- **Match the surrounding code.** No reformatting passes, no style migrations.
- **Comment density is high and intentional.** Comments carry the why (invariants, tradeoffs,
  root-caused bugs) — keep that standard in new code and don't strip existing ones.
- TypeScript strict; pure logic goes in `src/utils/` with tests next to it in `src/__tests__/`.

## PR expectations

- **Tests for behavior changes.** New behavior gets a test; a bug fix gets a test that reproduces it.
- **No drive-by refactors.** Surgical diffs only — every changed line should trace to the PR's
  purpose. Standalone refactor sprints are explicitly out of scope;
  behavior-preserving cleanups ride along only when a feature already touches that code.
- Update the docs your change invalidates (README, `docs/`, `.env.example`) in the same PR.
- Safety invariants are non-negotiable: the no-payment invariant and the server-side risk tiers
  must hold after your change. If a PR weakens either, it won't merge.

## The allow-list `.gitignore` gotcha

The root `.gitignore` ignores **everything** (`/*`) and then allow-lists specific files and
directories. Consequence: a brand-new top-level file or directory is **silently untracked** — it
builds and tests fine locally, then vanishes from the clone. This has bitten us in production
(the eval runner itself was once dropped this way). Before adding any new top-level path:

```bash
git check-ignore -v <path>    # any output ending in an ignore (non-!) rule = it will be dropped
```

If it's ignored, add an explicit `!/<path>` allow rule in the same commit.

## Secrets policy

- Secrets live in a git-ignored `.env` only (`**/.env` is ignored; `.env.example` is the template
  and must never contain a real value). Run `git check-ignore .env` before pushing if in doubt.
- Never paste keys into code, tests, fixtures, or committed docs.
- Self-hosters register their **own** credentials — their own Google OAuth client (sign-in +
  Calendar sync) and, optionally, their own Kroger developer app for send-to-cart. There are no
  shared project keys to ask for; every knob is documented in [`.env.example`](./.env.example).

## Security issues

Don't open a public issue — see [`SECURITY.md`](./SECURITY.md) for private reporting.
