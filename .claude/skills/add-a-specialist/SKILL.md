---
name: add-a-specialist
description: Add a new tool-scoped specialist agent to the Family-Hub ADK concierge (persona prompt + MCP tool grant + structural tests). Use when a new capability domain needs its own agent (e.g. a laundry_agent, plants_agent).
---

# add-a-specialist — one new tool-scoped ADK specialist, end to end

The concierge is a root router + tool-scoped specialists over the Node MCP toolbelt. A specialist =
a persona + an allowlisted slice of MCP tools. The split buys TOOL-SCOPING and routing reliability —
keep the slice minimal.

## Steps (all paths from the repo root)

1. **Tools first.** If the capability needs a NEW MCP tool, add it in `src/mcp/conciergeTools.ts`
   (pure validator + risk tier — `auto` reversible / `confirm` staged / `stepup` PIN) or the I/O
   layer `src/mcp/server.ts` for async/HTTP tools. NEVER a payment/checkout-shaped tool — the
   no-payment invariant is structural. Then `npm run build:mcp` (the agent spawns the BUNDLE).
2. **Allowlist** — `agent/concierge/agent.py` → `SPECIALIST_TOOLS["<name>_agent"] = [...]`. Only the
   tools this domain needs; read-only domains get only `get_*`/`search_*`.
3. **Persona** — `agent/concierge/prompts.py`: a `<NAME> = f"""..."""` block. House rules: state
   what the agent DOES and never does; confirm-tier actions are described as "staged for the
   parent's approval", never as done; end with `{SAFETY}`.
4. **Build the agent node** — in `build_root_agent`: an `Agent(name=..., model=m, description=...,
   instruction=prompts.<NAME>, tools=[_mcp(SPECIALIST_TOOLS["<name>_agent"], access_token)])`,
   appended to `sub_agents`. The DESCRIPTION is what the root router routes on — one crisp sentence.
5. **Structural tests** — `agent/tests/test_eval.py`: the allowlist assertions run offline
   (no-payment-tool check picks the new specialist up automatically via `SPECIALIST_TOOLS`; add a
   scoped-as-expected case). Add an eval golden in `agent/evals/golden_agent.jsonl` (expect_tool +
   forbid_tools) so Decision-B runs cover it.
6. **Gate**: `/verify-suite` (pytest picks up the structure tests; `npm run build:mcp` if tools changed).

## Traps
- Each specialist spawns its own MCP child — a new one adds a spawn; keep MCP_STARTUP_TIMEOUT in mind.
- ADK specialists cannot call a SIBLING's tools mid-loop: a multi-step flow must hold every tool it
  needs in ITS OWN slice (see outings_agent's wide-but-justified list).
- The router routes on descriptions: overlapping descriptions = misrouting. Sharpen, don't broaden.
