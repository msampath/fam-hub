"""Offline tests for the structured-action bridge (concierge/bridge.py) — no ADK runtime, no Gemini key."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concierge import bridge  # noqa: E402


def _mcp(tool, status="applied", tier="auto", artifact=None):
    return {"ok": True, "tool": tool, "tier": tier, "status": status, "artifact": artifact or {}, "message": "ok"}


def test_extracts_result_from_a_plain_dict():
    r = bridge.mcp_result_from_response(_mcp("create_event"))
    assert r and r["tool"] == "create_event"


def test_extracts_result_from_a_json_string_inside_a_content_wrapper():
    # Mirrors the MCP server's `{content:[{type:'text', text:<json>}]}` surfaced by ADK.
    resp = {"result": {"content": [{"type": "text", "text": json.dumps(_mcp("add_chore"))}]}}
    r = bridge.mcp_result_from_response(resp)
    assert r and r["tool"] == "add_chore"


def test_returns_none_for_junk():
    assert bridge.mcp_result_from_response({"unrelated": 1}) is None
    assert bridge.mcp_result_from_response("not json") is None
    assert bridge.mcp_result_from_response(None) is None


class _FR:
    def __init__(self, response):
        self.response = response


class _Event:
    def __init__(self, frs):
        self._frs = frs

    def get_function_responses(self):
        return self._frs


def test_collect_actions_keeps_only_mutating_tools():
    event = _Event([
        _FR(_mcp("create_event", status="applied")),
        _FR(_mcp("reserve", status="requires_confirmation", tier="confirm")),
        _FR(_mcp("get_bills")),          # read tool → excluded
        _FR(_mcp("search_local_knowledge")),  # read tool → excluded
        _FR({"garbage": True}),          # unparseable → skipped
    ])
    actions = bridge.collect_actions(event)
    assert [a["tool"] for a in actions] == ["create_event", "reserve"]
    assert actions[0]["status"] == "applied"
    assert actions[1]["status"] == "requires_confirmation"


def test_collect_actions_surfaces_prepare_handoff():
    # prepare_handoff stages a confirm-tier DRAFT for the Approvals queue, so it MUST surface as an action.
    # Regression: it was missing from MUTATING_TOOLS, so a successfully-staged handoff silently never reached
    # the bar (the agent's text said "I staged a draft" but nothing appeared to approve).
    event = _Event([_FR(_mcp("prepare_handoff", status="requires_confirmation", tier="confirm",
                             artifact={"summary": "Review & submit: Din Tai Fung", "link": "https://dtf.com/en-us/locations/bellevue"}))])
    actions = bridge.collect_actions(event)
    assert [a["tool"] for a in actions] == ["prepare_handoff"]
    assert actions[0]["status"] == "requires_confirmation"


def test_collect_actions_surfaces_suggest_event():
    # suggest_event is auto-tier but MUST surface so the client can render its artifact as a tap-to-add chip
    # (like set_goal, it's client-owned — not a ledger row, handled specially on the client).
    event = _Event([_FR(_mcp("suggest_event", status="validated",
                             artifact={"title": "Woodland Park Zoo", "start": "2026-07-04", "url": "https://zoo.org"}))])
    actions = bridge.collect_actions(event)
    assert [a["tool"] for a in actions] == ["suggest_event"]
    assert actions[0]["artifact"]["title"] == "Woodland Park Zoo"


def test_collect_actions_empty_when_no_tool_calls():
    assert bridge.collect_actions(_Event([])) == []


def test_collect_actions_dedups_across_events_with_a_shared_seen_set():
    # The same tool result re-emitted on a later event must be counted once when a `seen` set is shared.
    seen: set = set()
    e1 = _Event([_FR(_mcp("create_event", artifact={"title": "Zoo"}))])
    e2 = _Event([_FR(_mcp("create_event", artifact={"title": "Zoo"}))])  # re-emitted (same tool+artifact)
    actions = bridge.collect_actions(e1, seen) + bridge.collect_actions(e2, seen)
    assert len(actions) == 1


def test_mutating_tools_is_derived_from_the_shared_contract_mirror():
    # MUTATING_TOOLS is no longer a hand-kept literal — it's derived from action_contract.json (the committed
    # mirror of the TS single source of truth, src/mcp/actionContract.ts). The TS freshness test keeps the
    # JSON in lockstep; here we prove the Python loader derives the right set (and drops the IoT stub).
    import pathlib
    contract = json.loads((pathlib.Path(bridge.__file__).parent / "action_contract.json").read_text(encoding="utf-8"))
    expected = {name for name, spec in contract.items() if spec.get("mutating")}
    assert bridge.MUTATING_TOOLS == expected
    # The known writers are in; the honest IoT stub (home_control) never mutates and is out.
    assert {"create_event", "prepare_handoff", "suggest_event", "set_goal", "delete_meal_plan"} <= bridge.MUTATING_TOOLS
    assert "home_control" not in bridge.MUTATING_TOOLS
