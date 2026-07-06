---
name: verify-suite
description: Run Family-Hub's full per-commit gate suite (lint, vitest, build incl. the MCP bundle, agent pytest) and report a pass/fail table. Use before every commit, after any refactor, or when asked "is the repo green?"
---

# verify-suite — the per-commit gate, in order

Run from the REPO ROOT. Stop at the first failure, diagnose, fix, re-run — never commit red.

1. **Types/lint**: `npm run lint` (tsc --noEmit — zero errors expected).
2. **Unit + component tests**: `npx vitest run` (pure-logic AND jsdom/RTL component tests).
3. **Build**: `npm run build` — builds BOTH the Vite client and `dist/mcp-server.cjs` (esbuild). The
   MCP bundle matters: the ADK agent spawns it; a stale bundle = the agent runs OLD tool code. After
   editing anything under `src/mcp/`, this step (or `npm run build:mcp`) is mandatory.
4. **Agent tests**: `cd agent && python -m pytest -q`. Live prompt tests self-skip without a Gemini
   key (expected: N passed, ~5-6 skipped).

Weak-model work has two EXTRA gates (run when a change touches prompts, schemas, validators, or the
local-model path):
- `npm run eval` — gemini-baseline quick-path goldens.
- `npm run eval:local` — the same goldens on the local Ollama model. **Decision A** must hold:
  scope+safety perfect, overall within 10pts of baseline, ≥90% locally served.
- `python agent/evals/run_eval.py` (against a running `uvicorn agent.api:app`) — **Decision B** for
  the agent path: ≥90% valid tool calls AND 0 destructive misfires, else the local head ships dark.

Before pushing: `git check-ignore .env` must print `.env`, and grep the repo for any credential that
ever transited a chat/log. Report results as a table (gate → result → numbers), then the verdict.
