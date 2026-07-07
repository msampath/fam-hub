"""Structured-action bridge: turn ADK tool-call results into the action shape the React copilot bar renders.

The unified bar feeds the ADK agent's mutating tool results through the SAME UI the local copilot uses
(confirmations + the Approve/ledger queue). The MCP server returns each tool result as JSON
(`{ok, tool, tier, status, artifact, message}`); ADK surfaces it inside an event's function_response. These
helpers dig that JSON out (tolerant of ADK-version shape differences) and keep only the mutating tools.
Pure → unit-tested without the ADK runtime.
"""
import json

# Mutating tools the bar renders as actions. Read tools (get_*/find_places/search_local_knowledge) only
# inform the agent's TEXT reply, so they're intentionally excluded here.
MUTATING_TOOLS = {"create_event", "update_event", "delete_event", "add_chore", "add_shopping_item",
                  "reserve", "add_to_cart", "prepare_handoff", "move_document", "delete_document",
                  "delete_chore", "clear_chores", "update_chore", "delete_shopping_item",
                  "set_goal",  # set_goal is auto-tier; the client upserts its artifact into the goals collection
                  "set_meal_plan",  # auto-tier; the client upserts the week into the mealplan collection
                  "delete_meal_plan",  # auto-tier; the client removes matching plans (completes CRUD)
                  "suggest_event"}  # auto-tier; the client renders its artifact as a tap-to-add chip (not a write)


def mcp_result_from_response(resp) -> dict | None:
    """Dig the MCP tool's JSON result out of an ADK function_response.response (shape varies by ADK version:
    a dict with 'result'/'content', the parsed dict itself, or a JSON string). Return the first object that
    looks like an McpToolResult (has 'tool' + 'status'), else None."""
    if isinstance(resp, dict) and "tool" in resp and "status" in resp:
        return resp
    found: list[str] = []

    def walk(x):
        if isinstance(x, str):
            found.append(x)
        elif isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, (list, tuple)):
            for v in x:
                walk(v)

    walk(resp)
    for s in found:
        try:
            d = json.loads(s)
        except Exception:
            continue
        if isinstance(d, dict) and "tool" in d and "status" in d:
            return d
    return None


def collect_actions(event, seen: set | None = None) -> list[dict]:
    """Mutating-tool results from one ADK event → the bar's action shape `{tool, status, tier, artifact,
    message}`. Empty for read-only tool calls. Pass a `seen` set across the run's events to DEDUP — some ADK
    versions re-emit a function_response on a later (aggregated/final) event, which would otherwise double-
    count a single tool call (inflating "N applied" + firing two refreshes)."""
    out: list[dict] = []
    for fr in event.get_function_responses():
        r = mcp_result_from_response(getattr(fr, "response", None))
        if not (r and r.get("tool") in MUTATING_TOOLS):
            continue
        if seen is not None:
            ident = getattr(fr, "id", None) or json.dumps(
                {"t": r.get("tool"), "a": r.get("artifact")}, sort_keys=True, default=str)
            if ident in seen:
                continue
            seen.add(ident)
        out.append({k: r.get(k) for k in ("tool", "status", "tier", "artifact", "message")})
    return out
