"""Family-Hub concierge — ADK multi-agent over the Node MCP toolset.

KAGGLE_EVAL: Agent / Multi-agent (ADK) + Agent CLI — a root concierge that DELEGATES to tool-scoped
specialists, each LOADED from a self-contained skill folder (skills/<name>/SKILL.md — persona, tool slice,
description) and given only its slice of the MCP toolbelt (tool_filter). Honest framing: most specialists
are thin NL→one-CRUD-call adapters — the split buys tool-scoping + routing reliability, not per-agent
autonomy; only `outings` runs a full multi-step loop. The tools, the no-payment
invariant, and the risk tiers are served by the Node MCP server (src/mcp/server.ts) over stdio — this
agent reuses that working toolbelt rather than re-implementing actions.

Run (from the `agent/` dir, after `pip install -r requirements.txt` + a Gemini key in `.env`):
    adk web            # browser UI listing the `concierge` agent
    adk run concierge  # CLI REPL

The MCP server is spawned as a stdio CHILD PROCESS (`npx tsx src/mcp/server.ts`) with cwd = repo root,
so it finds the TypeScript + node_modules. (NOTE: each specialist opens its own filtered MCP connection,
i.e. one Node child per specialist — fine for the demo; the container build can swap `npx tsx` for a
prebuilt `node dist/mcp.cjs` to cut startup cost.)

ADK API note: targets google-adk >= 1.2 (MCPToolset + StdioConnectionParams). If you're on a different
ADK version and the imports differ, adjust the two `google.adk.tools.mcp_tool` imports below.
"""
import os
from pathlib import Path

from google.adk.agents import Agent
from google.adk.tools.mcp_tool.mcp_toolset import MCPToolset, StdioConnectionParams
from mcp import StdioServerParameters

from . import prompts
from .skills import SKILLS

# Repo root = two levels up from this file (agent/concierge/agent.py -> repo root). The MCP server runs
# from here so `src/mcp/server.ts` + node_modules resolve.
REPO_ROOT = Path(__file__).resolve().parents[2]

# Model: ONE knob `COPILOT_MODEL` powers both engine tiers (this ADK agent + the Express quick-path). Default
# gemini-2.5-flash (burst/503 reliability with a billed key). The LAN appliance sets COPILOT_MODEL=
# gemini-3.1-flash-lite (~500/day free-tier RPD) in its compose for the 3-5-calls/message flow. CONCIERGE_MODEL
# remains a legacy per-tier override.
MODEL = os.environ.get("COPILOT_MODEL") or os.environ.get("CONCIERGE_MODEL", "gemini-2.5-flash")
# Fallback model CHAIN tried in order if the primary 503s/429s (capacity spikes on a newer flash). Set
# CONCIERGE_FALLBACK to a COMMA-SEPARATED list, tried left→right (e.g.
# "gemini-3-flash-preview,gemini-2.5-flash,gemini-3.1-flash-lite"); each gets CONCIERGE_MAX_ATTEMPTS tries
# before advancing. Pure parse → unit-tested; ignores blanks/whitespace so a trailing comma is harmless.
def parse_fallback_models(raw: str) -> list[str]:
    return [m.strip() for m in (raw or "").split(",") if m.strip()]

FALLBACK_MODELS = parse_fallback_models(os.environ.get("CONCIERGE_FALLBACK", ""))

# Router tiering (#1, REDESIGNED): a CHEAP model may serve the ROOT router — it only emits
# transfer_to_agent — while the specialists keep the chain model, so api.py's 503 fallback still
# swaps every node that does real work. Applied ONLY on the primary attempt (model=None below):
# a fallback attempt must not keep a pinned, possibly-503ing router in the graph.
ROUTER_MODEL = os.environ.get("CONCIERGE_ROUTER_MODEL", "").strip()

# A cold `npx tsx src/mcp/server.ts` start (tsx transpiles on first spawn) can exceed ADK's default ~5s MCP
# session-connect timeout — which surfaces as "Failed to create MCP session … TimeoutError" and an EMPTY
# toolbelt (the agent then only has transfer_to_agent and "hallucinates" create_event). Give it headroom.
# Env-overridable because cold-start time varies by machine / first-run vs warm (and Cloud Run cold starts).
MCP_STARTUP_TIMEOUT = float(os.environ.get("MCP_STARTUP_TIMEOUT", "30"))


def _mcp(tool_names: list[str], access_token: str | None = None) -> MCPToolset:
    """An MCP toolset (stdio) exposing ONLY `tool_names` to the calling specialist.

    The full os.environ is forwarded to the MCP child so (a) `npx` resolves via PATH and (b) the Supabase
    vars reach it: with SUPABASE_ACCESS_TOKEN (the visitor's JWT) + SUPABASE_URL/SUPABASE_ANON_KEY set, the
    MCP server PERSISTS writes to that visitor's household (RLS-scoped); without them it stays validate-only.
    In a hosted demo the ADK service sets SUPABASE_ACCESS_TOKEN per request from the visitor's session; for
    local `adk run`/`adk web` testing, put your own session's values in agent/.env.
    """
    # `access_token` (the visitor's Supabase JWT), when given, overrides SUPABASE_ACCESS_TOKEN so the MCP
    # child persists under THAT visitor — the per-request isolation the FastAPI service (api.py) needs.
    env = dict(os.environ)
    if access_token:
        env["SUPABASE_ACCESS_TOKEN"] = access_token
    # Spawn command: the container sets MCP_SERVER_CJS to a prebuilt esbuild bundle (run via `node`), so the
    # image needs neither `tsx` nor devDeps AND avoids the ~5s tsx transpile-on-cold-spawn that caused the ADK
    # MCP session timeout. For local `adk run`/`adk web` dev (no bundle), fall back to `npx tsx src/mcp/server.ts`.
    mcp_cjs = os.environ.get("MCP_SERVER_CJS")
    if not mcp_cjs:
        # Prefer a prebuilt esbuild bundle when present, even in LOCAL dev: `node <bundle>` spawns in ms,
        # while `npx tsx` cold-transpiles on EVERY spawn — and build_root_agent spawns one MCP child per
        # specialist at once, so the concurrent tsx cold-start intermittently blew the MCP session timeout,
        # leaving a specialist tool-less → "Tool 'find_places' not found" → 502. Run `npm run build:mcp` after
        # editing src/mcp/* to refresh the bundle (delete it to force the always-fresh `npx tsx` path).
        default_bundle = REPO_ROOT / "dist" / "mcp-server.cjs"
        if default_bundle.exists():
            mcp_cjs = str(default_bundle)
    if mcp_cjs:
        command, args = "node", [mcp_cjs]
    else:
        command, args = "npx", ["tsx", "src/mcp/server.ts"]
    return MCPToolset(
        connection_params=StdioConnectionParams(
            server_params=StdioServerParameters(
                command=command,
                args=args,
                cwd=str(REPO_ROOT),
                env=env,
            ),
            timeout=MCP_STARTUP_TIMEOUT,
        ),
        tool_filter=tool_names,
    )


# Each specialist's scoped slice of the MCP toolbelt (its tool_filter) — now DERIVED from the skill
# folders (skills/<name>/SKILL.md frontmatter `tools:`). Kept as this dict so the agent-eval suite can
# assert the allowlists — e.g. that NO specialist is granted a payment/checkout tool (the no-payment
# invariant, structurally) — without spawning the MCP child. To change a slice, edit its SKILL.md.
SPECIALIST_TOOLS: dict[str, list[str]] = {name: list(s.tools) for name, s in SKILLS.items()}


def build_root_agent(access_token: str | None = None, model: object | None = None,
                     router_model: str | None = None) -> Agent:
    """Build the concierge agent graph. Call WITHOUT a token for `adk run`/`adk web` (the MCP child uses
    the process env); the FastAPI service passes a per-request `access_token` so each visitor's writes are
    RLS-scoped to their own household (the per-visitor isolation invariant from the security review).

    `model` may be a model NAME or an ADK BaseLlm instance (api.py passes LiteLlm for the local tier).
    `router_model` (or CONCIERGE_ROUTER_MODEL) puts a cheap model on the ROOT router only — ignored when
    `model` is explicitly set, because a fallback/local attempt must swap the WHOLE graph."""
    m = model or MODEL
    root_model = (router_model or ROUTER_MODEL or m) if model is None else m
    # One specialist per loaded skill (name + description + persona + tool slice all come from its SKILL
    # folder) — adding a specialist is dropping in a skills/<name>/ folder, no code change here.
    sub_agents = [
        Agent(
            name=skill.name, model=m,
            description=skill.description,
            instruction=skill.instruction,
            tools=[_mcp(list(skill.tools), access_token)],
        )
        for skill in SKILLS.values()
    ]
    # The root concierge routes to a specialist via ADK's LLM-driven delegation (sub_agents). It holds no
    # tools of its own — it decides WHO acts; the specialist acts with its scoped toolbelt.
    return Agent(
        name="concierge", model=root_model,
        description="The family's safe household concierge — routes requests to specialist agents.",
        instruction=prompts.ROOT,
        sub_agents=sub_agents,
    )


# Module-level agent for `adk run concierge` / `adk web` (uses the process env for the MCP child).
root_agent = build_root_agent()
