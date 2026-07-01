"""Family-Hub concierge — ADK multi-agent over the Node MCP toolset.

KAGGLE_EVAL: Agent / Multi-agent (ADK) + Agent CLI — a root concierge that DELEGATES to seven tool-scoped
specialists, each given only its slice of the MCP toolbelt (tool_filter). Honest framing: most specialists
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
        # while `npx tsx` cold-transpiles on EVERY spawn — and build_root_agent spawns 7 MCP children at once
        # (one per specialist), so the concurrent tsx cold-start intermittently blew the MCP session timeout,
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


# Each specialist's scoped slice of the MCP toolbelt (its tool_filter). Declared as data so the
# agent-eval suite can assert the allowlists — e.g. that NO specialist is granted a payment/checkout
# tool (the no-payment invariant, structurally) — without spawning the MCP child.
SPECIALIST_TOOLS: dict[str, list[str]] = {
    "calendar_agent": ["create_event", "update_event", "delete_event"],
    # delete_chore/clear_chores/update_chore are CONFIRM-tier (destructive/mutating): staged for the
    # parent's approval, applied client-side — the agent never silently wipes the chore board.
    "chores_agent": ["add_chore", "delete_chore", "clear_chores", "update_chore"],
    "shopping_agent": ["add_shopping_item", "add_to_cart", "delete_shopping_item"],  # add_to_cart stages a DRAFT, never checks out
    # NO `reserve` search-link shortcut (removed): the agent must do the real legwork. search_local_knowledge
    # grounds picks on the local corpus; web_search/fetch_page research real logistics (does it even TAKE/need a
    # reservation? hours, pass/ticket URLs); prepare_handoff stages the loop-closing draft — but ONLY with a
    # REAL, server-verified booking URL (the MCP server fetches it to confirm it loads before staging).
    # set_goal lets the outings agent record a multi-step trip as a TRACKED goal (the family sees the plan
    # + follows it through). Auto-tier, reversible — not a payment/booking tool, so the no-payment invariant holds.
    # A multi-day getaway must complete in ONE loop (ADK specialists can't call a sibling's tools), so outings
    # also gets: get_events (READ — detect a calendar conflict on the trip dates), create_event (draft the trip
    # event), and delete_event/update_event (CONFIRM-tier — offer to CLEAR or RESCHEDULE a conflicting event,
    # staged for approval). update_event is needed because the OUTINGS conflict block offers "move it" as well.
    "outings_agent": ["find_places", "search_local_knowledge", "web_search", "fetch_page", "prepare_handoff",
                      "set_goal", "suggest_event", "get_events", "create_event", "delete_event", "update_event"],
    # READ-only — gathers the day's data + local-knowledge nudges (e.g. a newsletter's "VegFest is Saturday").
    "briefing_agent": ["get_events", "get_chores", "get_upcoming", "search_local_knowledge"],
    "bills_agent": ["get_bills"],                                    # READ-only — reports bills (never pays)
    # Manages the Docs Library: find docs, recategorize (move), or delete (staged for confirmation).
    "files_agent": ["search_local_knowledge", "move_document", "delete_document"],
}


def build_root_agent(access_token: str | None = None, model: str | None = None) -> Agent:
    """Build the concierge agent graph. Call WITHOUT a token for `adk run`/`adk web` (the MCP child uses
    the process env); the FastAPI service passes a per-request `access_token` so each visitor's writes are
    RLS-scoped to their own household (the per-visitor isolation invariant from the security review)."""
    m = model or MODEL
    calendar_agent = Agent(
        name="calendar_agent", model=m,
        description="Creates and reschedules household calendar events.",
        instruction=prompts.CALENDAR, tools=[_mcp(SPECIALIST_TOOLS["calendar_agent"], access_token)],
    )
    chores_agent = Agent(
        name="chores_agent", model=m,
        description="Assigns kids' chores (handles multi-kid phrases).",
        instruction=prompts.CHORES, tools=[_mcp(SPECIALIST_TOOLS["chores_agent"], access_token)],
    )
    shopping_agent = Agent(
        name="shopping_agent", model=m,
        description="Adds shopping-list items and stages Amazon cart DRAFTS (no checkout).",
        instruction=prompts.SHOPPING, tools=[_mcp(SPECIALIST_TOOLS["shopping_agent"], access_token)],
    )
    outings_agent = Agent(
        name="outings_agent", model=m,
        description="Finds real nearby venues to recommend, and stages reservation DRAFTS (no booking/payment).",
        instruction=prompts.OUTINGS, tools=[_mcp(SPECIALIST_TOOLS["outings_agent"], access_token)],
    )
    briefing_agent = Agent(
        name="briefing_agent", model=m,
        description="Reviews the day/week ahead (events, due chores, what's coming up) and gives a briefing with nudges.",
        instruction=prompts.BRIEFING, tools=[_mcp(SPECIALIST_TOOLS["briefing_agent"], access_token)],
    )
    bills_agent = Agent(
        name="bills_agent", model=m,
        description="Reports household bills found from email (payee, amount, due date). Never pays anything.",
        instruction=prompts.BILLS, tools=[_mcp(SPECIALIST_TOOLS["bills_agent"], access_token)],
    )
    files_agent = Agent(
        name="files_agent", model=m,
        description="Manages the Docs Library: finds, recategorizes (move), and deletes saved documents.",
        instruction=prompts.FILES, tools=[_mcp(SPECIALIST_TOOLS["files_agent"], access_token)],
    )
    # The root concierge routes to a specialist via ADK's LLM-driven delegation (sub_agents). It holds no
    # tools of its own — it decides WHO acts; the specialist acts with its scoped toolbelt.
    return Agent(
        name="concierge", model=m,
        description="The family's safe household concierge — routes requests to specialist agents.",
        instruction=prompts.ROOT,
        sub_agents=[calendar_agent, chores_agent, shopping_agent, outings_agent, briefing_agent, bills_agent, files_agent],
    )


# Module-level agent for `adk run concierge` / `adk web` (uses the process env for the MCP child).
root_agent = build_root_agent()
