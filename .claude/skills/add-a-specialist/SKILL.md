---
name: add-a-specialist
description: Add a new tool-scoped specialist agent to the Family-Hub ADK concierge. Each specialist is now a self-contained skill FOLDER (agent/concierge/skills/<name>/SKILL.md — frontmatter + persona), auto-loaded — no agent.py/prompts.py edits. Use when a new capability domain needs its own agent (e.g. a laundry_agent, plants_agent).
---

# add-a-specialist — one new tool-scoped ADK specialist, end to end

The concierge is a root router + tool-scoped specialists over the Node MCP toolbelt. A specialist =
a persona + an allowlisted slice of MCP tools. The split buys TOOL-SCOPING and routing reliability —
keep the slice minimal.

**As of the skill-folder refactor, a specialist IS a folder.** Each one lives at
`agent/concierge/skills/<name>_agent/SKILL.md`: YAML-ish frontmatter (`description`, `tools`, optional
`guards`) + a persona body. `skills/__init__.py` parses every folder into a `Skill` (name = folder name),
appends the shared `SAFETY` footer (and `EXTERNAL_CONTENT_GUARD` for `guards: [external_content]`), and
`build_root_agent` (agent.py) loops over `SKILLS` to construct the sub-agents. **`SPECIALIST_TOOLS` is
DERIVED from the folders; `prompts.py` only holds `ROOT` + back-compat re-exports.** So adding a specialist
is DROPPING IN ONE FOLDER — no edits to `agent.py`, `build_root_agent`, or the persona re-exports.

## Steps (all paths from the repo root)

1. **Tools first.** If the capability needs a NEW MCP tool, add it in `src/mcp/conciergeTools.ts`
   (pure validator + risk tier — `auto` reversible / `confirm` staged / `stepup` PIN) or the I/O
   layer `src/mcp/server.ts` for async/HTTP tools. NEVER a payment/checkout-shaped tool — the
   no-payment invariant is structural. A new MUTATING tool must also be added to `bridge.py`
   `MUTATING_TOOLS` (or its results silently never reach Approvals — there's a parity test for this).
   Then `npm run build:mcp` (the agent spawns the BUNDLE).
2. **Drop in the folder.** Create `agent/concierge/skills/<name>_agent/SKILL.md`:
   ```
   ---
   description: One crisp sentence — THIS is what the root router routes on. Sharpen, don't overlap.
   tools: [get_thing, add_thing, delete_thing]
   guards: [external_content]   # OPTIONAL — only if the agent READS stored external content (bills/files)
   ---
   <persona body>
   ```
   - `tools:` is the agent's ENTIRE tool_filter — only what this domain needs; read-only domains get
     only `get_*`/`search_*`. This list becomes `SPECIALIST_TOOLS["<name>_agent"]` automatically.
   - Persona body: state what the agent DOES and never does; describe confirm-tier actions as "staged
     for the parent's approval", never as done. **Do NOT append `{SAFETY}`** — the loader adds SAFETY
     (and the external-content guard, if `guards` lists it) for you. **No `{...}` f-string braces** in the
     body (it's read as plain text, not formatted) — write literal text, not `{placeholders}`.
3. **Router mention (optional but usual).** The root router still lists its specialists by name in
   `prompts.py` `ROOT`. Add a one-line bullet so the router knows to delegate to `<name>_agent`.
   (Routing is description-driven, but the explicit bullet + a sharp `description:` is what makes it
   reliable.) Nothing else in `prompts.py` or `agent.py` changes.
4. **Structural tests.**
   - `agent/tests/test_structure.py` `test_root_is_the_concierge_with_eight_specialists` hardcodes the
     specialist-name list — bump it to include the new one (and rename if the count changes).
   - `agent/tests/test_eval.py`: the no-payment + mutator-in-bridge checks pick the new specialist up
     automatically via `SPECIALIST_TOOLS`; add a `test_specialist_allowlists_are_scoped_as_expected`
     line pinning the new slice if it's non-trivial.
   - Add an eval golden in `agent/evals/golden_agent.jsonl` (expect_tool + forbid_tools) so a routing
     regression is caught.
5. **Gate**: `cd agent && python -m pytest -q` (picks up the loader + structure tests; the offline layer
   needs no key). `npm run build:mcp` if tools changed. Restart the agent (:8080) — it caches imported
   modules, so a new folder isn't seen until restart.

## Traps
- **It's a folder, not a prompts.py block.** Editing `prompts.py` to add a persona is the OLD pattern —
  the personas are re-exported FROM the folders now (`prompts.SHOPPING = SKILLS["shopping_agent"].instruction`).
  Edit the SKILL.md, never the re-export.
- **The loader is dependency-free frontmatter parsing** (no pyyaml): `key: value`, `[a, b, c]` for lists.
  Keep frontmatter to that shape — no nested YAML, no quotes-with-colons, no multi-line values.
- Each specialist spawns its own MCP child — a new one adds a spawn; keep MCP_STARTUP_TIMEOUT in mind.
- ADK specialists cannot call a SIBLING's tools mid-loop: a multi-step flow must hold every tool it
  needs in ITS OWN `tools:` slice (see `outings_agent`'s wide-but-justified list).
- The router routes on descriptions: overlapping descriptions = misrouting. Sharpen, don't broaden.
